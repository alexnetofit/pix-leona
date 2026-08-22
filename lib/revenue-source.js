/**
 * lib/revenue-source.js — Coleta de faturamento nas fontes (Guru, Paddle e Pagou),
 * agregada por dia em America/Sao_Paulo.
 *
 * Por que existe: a API da Guru pagina por cursor e gasta ~3,4s por pagina de
 * 100 transacoes. Um mes de vendas da ~2.600 transacoes, ou seja ~50s so de
 * Guru. Consultar isso a cada abertura de tela e insustentavel, entao este
 * modulo e usado pelo cron pra alimentar a tabela `revenue_daily`, e a tela le
 * o agregado pronto.
 *
 * Detalhe importante: a paginacao por cursor da Guru e sequencial, mas dias
 * diferentes sao consultas independentes. Por isso o ganho vem de paralelizar
 * por dia (GURU_CONCURRENCY), nao de pedir intervalos maiores — medido:
 * intervalo unico de 30 dias leva 183s, dia a dia com 4 em paralelo leva 50s.
 *
 * Semantica de valores (preservada do comportamento anterior da tela):
 *   - Guru: transacao aprovada entra em gross/net; transacao reembolsada ou
 *     com chargeback sai do gross e entra so em refund_*.
 *   - Paddle: transacao completada entra em gross/net e, se tiver ajuste, a
 *     diferenca entra em refund_* sem sair do gross.
 *   - Pagou: bruto/liquido em BRL (paid_amount/base_price). O campo amount
 *     da API mistura settlement com real e nao pode ir pro card.
 *   - Em Guru e Paddle, o reembolso e atribuido ao dia da venda original.
 */
import { GURU_BASE, LEONA_GURU_PRODUCT_ID, guruHeaders } from './guru.js';
import { paddleRequest } from './paddle-client.js';
import { getPagouTransaction, listPagouTransactions, pagouConfigured } from './pagou.js';

const APPROVED_STATUSES = ['approved', 'completed'];
const REFUND_STATUSES = ['refunded', 'chargeback'];
const GURU_PAGE_SIZE = 100;
const GURU_MAX_PAGES_PER_DAY = 20;
const GURU_MAX_RETRIES = 3;
const PADDLE_PAGE_SIZE = 200;
const PADDLE_MAX_PAGES = 120;

export const GURU_CONCURRENCY = 4;
export const PADDLE_PIX_ACTIVE_DAYS = 32;
export const PAGOU_ACTIVE_DAYS = 32;
const PAGOU_PAID = new Set(['paid']);
const PAGOU_REFUND = new Set(['refunded', 'chargedback', 'chargeback']);

const BRT_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function brtToday() {
  return BRT_DAY_FMT.format(new Date());
}

export function brtDayOf(isoTimestamp) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  return BRT_DAY_FMT.format(date);
}

export function shiftDays(iso, amount) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function isValidDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function daysBetween(start, end, limit = 400) {
  const days = [];
  let cursor = start;
  while (cursor <= end && days.length < limit) {
    days.push(cursor);
    cursor = shiftDays(cursor, 1);
  }
  return days;
}

/** Meia-noite de Sao Paulo (UTC-3) do dia informado, em UTC. */
function brtBoundary(day) {
  return `${day}T03:00:00.000Z`;
}

function toCents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function intCents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

export function emptyTotals() {
  return {
    gross_cents: 0,
    net_cents: 0,
    sales_count: 0,
    refund_gross_cents: 0,
    refund_net_cents: 0,
    refund_count: 0,
    transactions_scanned: 0,
    source_pages: 0
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const seconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 15_000);
  return Math.min(700 * (2 ** attempt), 10_000) + Math.floor(Math.random() * 250);
}

/**
 * Limitador de concorrencia por processo. A Guru responde 429 com facilidade,
 * entao nunca deixamos mais de GURU_CONCURRENCY requisicoes em voo, mesmo que
 * varias sincronizacoes rodem ao mesmo tempo na mesma instancia.
 */
const guruGate = globalThis.__leonaGuruGate || { active: 0, waiters: [] };
globalThis.__leonaGuruGate = guruGate;

async function acquireGuruSlot() {
  if (guruGate.active >= GURU_CONCURRENCY) {
    await new Promise(resolve => guruGate.waiters.push(resolve));
    return;
  }
  guruGate.active++;
}

function releaseGuruSlot() {
  const next = guruGate.waiters.shift();
  if (next) {
    next();
    return;
  }
  guruGate.active = Math.max(0, guruGate.active - 1);
}

async function guruFetch(url, options) {
  let response;
  for (let attempt = 0; attempt <= GURU_MAX_RETRIES; attempt++) {
    await acquireGuruSlot();
    try {
      response = await fetch(url, options);
    } finally {
      releaseGuruSlot();
    }
    if (response.status !== 429 || attempt === GURU_MAX_RETRIES) return response;
    await sleep(retryDelayMs(response, attempt));
  }
  return response;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

function guruTransactionsUrl(day, cursor) {
  const url = new URL(`${GURU_BASE}/transactions`);
  url.searchParams.set('product_id', LEONA_GURU_PRODUCT_ID);
  url.searchParams.set('confirmed_at_ini', day);
  url.searchParams.set('confirmed_at_end', day);
  url.searchParams.set('per_page', String(GURU_PAGE_SIZE));
  for (const status of [...APPROVED_STATUSES, ...REFUND_STATUSES]) {
    url.searchParams.append('transaction_status[]', status);
  }
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

async function fetchGuruDay(day, headers) {
  const totals = emptyTotals();
  const seen = new Set();
  let cursor = null;

  while (totals.source_pages < GURU_MAX_PAGES_PER_DAY) {
    totals.source_pages++;
    const response = await guruFetch(guruTransactionsUrl(day, cursor), { headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const error = new Error(`Guru retornou ${response.status} ao buscar transações`);
      error.status = 502;
      error.detail = detail.slice(0, 500);
      error.day = day;
      throw error;
    }

    const body = await response.json();
    const rows = Array.isArray(body.data) ? body.data : [];
    for (const transaction of rows) {
      if (transaction?.product?.internal_id !== LEONA_GURU_PRODUCT_ID) continue;
      const id = transaction?.id
        || transaction?.invoice?.id
        || JSON.stringify([
          transaction?.subscription?.id,
          transaction?.payment?.marketplace_id
        ]);
      if (seen.has(id)) continue;
      seen.add(id);

      totals.transactions_scanned++;
      const status = String(transaction?.status || '').toLowerCase();
      const gross = toCents(transaction?.payment?.gross);
      const net = toCents(transaction?.payment?.net);

      if (APPROVED_STATUSES.includes(status)) {
        totals.gross_cents += gross;
        totals.net_cents += net;
        totals.sales_count++;
      } else if (REFUND_STATUSES.includes(status)) {
        totals.refund_gross_cents += gross;
        totals.refund_net_cents += net;
        totals.refund_count++;
      }
    }

    if (!body.has_more_pages || !body.next_cursor) break;
    cursor = body.next_cursor;
  }

  return totals;
}

/** Totais da Guru por dia. Chave: dia ISO, valor: totals. */
export async function fetchGuruDailyTotals(days, guruToken) {
  const headers = guruHeaders(guruToken);
  const totals = await mapWithConcurrency(
    days,
    GURU_CONCURRENCY,
    day => fetchGuruDay(day, headers)
  );
  return new Map(days.map((day, index) => [day, totals[index]]));
}

export async function fetchGuruActiveSubscribers(guruToken) {
  const url = new URL(`${GURU_BASE}/subscriptions`);
  url.searchParams.set('product_id', LEONA_GURU_PRODUCT_ID);
  url.searchParams.append('subscription_status[]', 'active');
  // A Guru exige limit >= 20 e devolve total_rows na primeira pagina.
  url.searchParams.set('limit', '20');

  const response = await guruFetch(url.toString(), { headers: guruHeaders(guruToken) });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Guru retornou ${response.status} ao buscar assinantes ativos`);
    error.status = 502;
    error.detail = detail.slice(0, 500);
    throw error;
  }

  const body = await response.json();
  const rows = Array.isArray(body.data) ? body.data : [];
  if (Number.isFinite(Number(body.total_rows))) return Number(body.total_rows);
  return rows.filter(
    row => row?.product?.id === LEONA_GURU_PRODUCT_ID && row?.last_status === 'active'
  ).length;
}

function paddleTransactionIsLeona(transaction) {
  const configuredPrices = new Set([
    process.env.PADDLE_STARTER_PRICE_ID,
    process.env.PADDLE_PIX_PRICE_ID
  ].filter(Boolean));
  const items = Array.isArray(transaction?.items) ? transaction.items : [];
  const lineItems = Array.isArray(transaction?.details?.line_items)
    ? transaction.details.line_items
    : [];
  return items.some(item =>
    configuredPrices.has(item?.price?.id)
    || String(item?.product?.name || '').toLowerCase() === 'leona flow'
  ) || lineItems.some(item =>
    configuredPrices.has(item?.price_id)
    || String(item?.product?.name || '').toLowerCase() === 'leona flow'
  ) || Boolean(transaction?.custom_data?.leona_account_id);
}

function paddleSubscriptionIsLeona(subscription) {
  const starterPriceId = process.env.PADDLE_STARTER_PRICE_ID;
  const items = Array.isArray(subscription?.items) ? subscription.items : [];
  return items.some(item =>
    (starterPriceId && item?.price?.id === starterPriceId)
    || String(item?.price?.product?.name || '').toLowerCase() === 'leona flow'
  ) || Boolean(subscription?.custom_data?.leona_account_id);
}

function completedPaymentMethod(transaction) {
  const payment = (transaction?.payments || []).find(item =>
    ['captured', 'completed'].includes(String(item?.status || '').toLowerCase())
  );
  return String(payment?.method_details?.type || '').toLowerCase();
}

async function fetchAllPaddle(path) {
  const rows = [];
  let pages = 0;
  let nextPath = path;
  while (nextPath && pages < PADDLE_MAX_PAGES) {
    pages++;
    const result = await paddleRequest(nextPath);
    if (Array.isArray(result.data)) rows.push(...result.data);
    if (!result.meta?.pagination?.has_more) break;
    const next = result.meta?.pagination?.next;
    if (!next) break;
    const url = new URL(next);
    nextPath = `${url.pathname}${url.search}`;
  }
  return { rows, pages };
}

function assertPaddleConfigured() {
  if (!process.env.PADDLE_API_KEY) {
    throw Object.assign(new Error('PADDLE_API_KEY não configurado'), { status: 500 });
  }
  if (!process.env.PADDLE_ENVIRONMENT) {
    process.env.PADDLE_ENVIRONMENT = 'production';
  }
}

async function fetchPaddleTransactions(start, end) {
  const params = new URLSearchParams();
  params.set('status', 'completed');
  params.set('include', 'adjustments');
  params.set('per_page', String(PADDLE_PAGE_SIZE));
  params.set('order_by', 'billed_at[ASC]');
  params.set('billed_at[GTE]', brtBoundary(start));
  params.set('billed_at[LT]', brtBoundary(shiftDays(end, 1)));
  return fetchAllPaddle(`/transactions?${params.toString()}`);
}

/**
 * Totais da Paddle por dia. Uma consulta cobre o intervalo inteiro (a Paddle
 * pagina rapido: um mes cabe em uma pagina), e o rateio por dia sai do
 * `billed_at` de cada transacao.
 */
export async function fetchPaddleDailyTotals(days) {
  assertPaddleConfigured();
  if (!days.length) return { byDay: new Map(), pages: 0 };

  const start = days[0];
  const end = days[days.length - 1];
  const { rows, pages } = await fetchPaddleTransactions(start, end);
  const wanted = new Set(days);
  const byDay = new Map();

  for (const transaction of rows) {
    if (!paddleTransactionIsLeona(transaction)) continue;
    const totalsRaw = transaction.details?.totals || {};
    const adjusted = transaction.details?.adjusted_totals || totalsRaw;
    const currency = totalsRaw.currency_code || transaction.currency_code;
    if (currency !== 'BRL') continue;

    const day = brtDayOf(transaction.billed_at || '');
    if (!day || !wanted.has(day)) continue;

    const gross = intCents(totalsRaw.grand_total);
    if (gross <= 0) continue;
    const net = intCents(totalsRaw.earnings);
    const adjustedGross = intCents(adjusted.grand_total);
    const adjustedNet = intCents(adjusted.earnings);

    const totals = byDay.get(day) || emptyTotals();
    totals.gross_cents += gross;
    totals.net_cents += net;
    totals.sales_count++;
    totals.transactions_scanned++;
    if (adjustedGross < gross) {
      totals.refund_gross_cents += gross - adjustedGross;
      totals.refund_net_cents += Math.max(0, net - adjustedNet);
      totals.refund_count++;
    }
    byDay.set(day, totals);
  }

  // A consulta cobre o intervalo inteiro, entao nao existe pagina "de um dia".
  // O contador vai pro ultimo dia da janela so pra alimentar o indicador de
  // paginas processadas da tela.
  const lastDay = days[days.length - 1];
  const lastTotals = byDay.get(lastDay) || emptyTotals();
  lastTotals.source_pages = pages;
  byDay.set(lastDay, lastTotals);

  return { byDay, pages };
}

/**
 * Snapshot de assinantes ativos "agora" na Paddle. Alem das assinaturas
 * recorrentes, conta clientes de PIX pre-pago: pagamento avulso, sem
 * assinatura, valido por uma janela de PADDLE_PIX_ACTIVE_DAYS dias.
 */
export async function fetchPaddleSubscriberSnapshot() {
  assertPaddleConfigured();

  const subParams = new URLSearchParams();
  subParams.set('status', 'active,trialing');
  subParams.set('per_page', String(PADDLE_PAGE_SIZE));

  const today = brtToday();
  const [subscriptionResult, transactionResult] = await Promise.all([
    fetchAllPaddle(`/subscriptions?${subParams.toString()}`),
    fetchPaddleTransactions(shiftDays(today, -PADDLE_PIX_ACTIVE_DAYS), today)
  ]);

  const subscriptions = subscriptionResult.rows.filter(paddleSubscriptionIsLeona);
  const subscriptionCustomers = new Set(
    subscriptions.map(subscription => subscription.customer_id).filter(Boolean)
  );
  const pixCutoff = new Date(Date.now() - PADDLE_PIX_ACTIVE_DAYS * 24 * 60 * 60 * 1000);
  const prepaidCustomers = new Set();

  for (const transaction of transactionResult.rows) {
    if (!paddleTransactionIsLeona(transaction)) continue;
    const adjusted = transaction.details?.adjusted_totals
      || transaction.details?.totals
      || {};
    if (
      !transaction.subscription_id
      && completedPaymentMethod(transaction) === 'pix'
      && transaction.customer_id
      && !subscriptionCustomers.has(transaction.customer_id)
      && new Date(transaction.billed_at) >= pixCutoff
      && intCents(adjusted.grand_total) > 0
    ) {
      prepaidCustomers.add(transaction.customer_id);
    }
  }

  return {
    count: subscriptions.length + prepaidCustomers.size,
    recurring: subscriptions.length,
    prepaid: prepaidCustomers.size,
    pages: subscriptionResult.pages + transactionResult.pages
  };
}

function pagouTxPayload(body) {
  return body?.data || body || {};
}

export function pagouPartyEmail(row) {
  return String(
    row?.customerEmail
    || row?.customer_email
    || row?.buyer?.email
    || row?.customer?.email
    || row?.email
    || ''
  ).trim().toLowerCase();
}

/** Bruto em BRL: o que o cliente pagou, nunca o settlement. */
export function pagouGrossBrlCents(tx) {
  return intCents(
    tx?.paid_amount
    || tx?.base_price
    || tx?.payment?.paid_amount
    || tx?.payment?.base_price
  );
}

/**
 * Líquido em BRL. Na Pagou, `amount`/`fee.net_amount` às vezes são BRL
 * (PIX da assinatura) e às vezes settlement (~USD) no cartão/avulso.
 * Se o amount for bem menor que o cobrado, escala o líquido pelo câmbio implícito.
 */
export function pagouNetBrlCents(tx) {
  const gross = pagouGrossBrlCents(tx);
  const rawAmount = intCents(tx?.amount || tx?.payment?.amount);
  const rawNet = intCents(
    tx?.fee?.net_amount
    || tx?.payment?.fee?.net_amount
    || tx?.settlements?.summary?.total_net_amount
  );
  if (gross <= 0) return 0;
  if (rawAmount > 0 && rawNet > 0 && rawAmount * 2 < gross) {
    return Math.round(gross * rawNet / rawAmount);
  }
  if (rawNet > 0) return rawNet;
  return gross;
}

export function buildPagouSubscriberSnapshot({ transactions = [] } = {}) {
  const emails = new Set();
  for (const tx of transactions) {
    const email = pagouPartyEmail(tx);
    if (email) emails.add(email);
  }
  return {
    count: emails.size,
    recurring: null,
    prepaid: emails.size
  };
}

async function hydratePagouTransactions(rows) {
  const unique = [];
  const seen = new Set();
  const listedById = new Map();
  for (const row of rows) {
    const id = row?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    listedById.set(id, row);
  }
  const details = await mapWithConcurrency(unique, 5, async (id) => {
    const listed = listedById.get(id);
    if (listed && pagouGrossBrlCents(listed) > 0) return listed;
    const found = await getPagouTransaction(id);
    return pagouTxPayload(found.body);
  });
  return details.filter((tx) => tx && tx.id);
}

/**
 * Totais da Pagou por dia em centavos de BRL (o que o cliente pagou).
 * `transactions_scanned` também guarda o bruto BRL — no cache antigo o
 * `gross_cents` chegou a misturar settlement; o resumo usa o BRL.
 */
export async function fetchPagouDailyTotals(days) {
  if (!pagouConfigured() || !days.length) return { byDay: new Map(), pages: 0 };

  const start = days[0];
  const end = days[days.length - 1];
  const dateFrom = brtBoundary(start);
  const dateTo = brtBoundary(shiftDays(end, 1));
  const [paidListed, refundListed] = await Promise.all([
    listPagouTransactions({ status: 'paid', dateFrom, dateTo }),
    listPagouTransactions({ status: 'refunded', dateFrom, dateTo })
  ]);
  const listed = {
    rows: [...paidListed.rows, ...refundListed.rows],
    pages: paidListed.pages + refundListed.pages
  };
  const details = await hydratePagouTransactions(listed.rows);
  const wanted = new Set(days);
  const byDay = new Map();

  for (const tx of details) {
    const status = String(tx.status || '').toLowerCase();
    const day = brtDayOf(tx.paid_at || tx.created_at || tx.createdAt || '');
    if (!day || !wanted.has(day)) continue;
    const brl = pagouGrossBrlCents(tx);
    const net = pagouNetBrlCents(tx);
    if (brl <= 0) continue;

    const totals = byDay.get(day) || emptyTotals();
    totals.transactions_scanned += brl;
    totals.source_pages = listed.pages;
    if (PAGOU_PAID.has(status)) {
      totals.gross_cents += brl;
      totals.net_cents += net;
      totals.sales_count++;
    } else if (PAGOU_REFUND.has(status)) {
      totals.refund_gross_cents += brl;
      totals.refund_net_cents += net;
      totals.refund_count++;
    }
    byDay.set(day, totals);
  }

  return { byDay, pages: listed.pages };
}

export async function fetchPagouSubscriberSnapshot() {
  if (!pagouConfigured()) {
    return { count: 0, recurring: null, prepaid: 0, pages: 0 };
  }

  const today = brtToday();
  const recent = await listPagouTransactions({
    status: 'paid',
    dateFrom: brtBoundary(shiftDays(today, -PAGOU_ACTIVE_DAYS))
  });
  const snapshot = buildPagouSubscriberSnapshot({ transactions: recent.rows });

  return {
    ...snapshot,
    pages: recent.pages || 0
  };
}
