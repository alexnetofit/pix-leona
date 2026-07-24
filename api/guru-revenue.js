/**
 * api/guru-revenue.js — Faturamento bruto e liquido do produto Leona na Guru.
 *
 * Body JSON:
 *   {
 *     start: "YYYY-MM-DD",   // dia inicial em America/Sao_Paulo (BR)
 *     end:   "YYYY-MM-DD"    // dia final em America/Sao_Paulo (BR)
 *   }
 *
 * A pagina de analytics da Guru agrupa vendas por `confirmed_at` (data
 * em que a venda foi confirmada/paga), nao por `ordered_at`. Usar
 * `confirmed_at_ini/end` bate com o grafico oficial da Guru.
 *
 * Tambem soma separadamente reembolsos (refunded/chargeback) no
 * periodo pra debug, sem subtrair do bruto/liquido reportado.
 */
import { GURU_BASE, LEONA_GURU_PRODUCT_ID, guruHeaders } from '../lib/guru.js';
import { applyCors } from '../lib/auth.js';
import { paddleRequest } from '../lib/paddle-client.js';

const APPROVED_STATUSES = ['approved', 'completed'];
const REFUND_STATUSES = ['refunded', 'chargeback'];
const PAGE_SIZE = 100;
const MAX_PAGES_PER_DAY = 20;
const MAX_DAYS = 62;
const PADDLE_PIX_ACTIVE_DAYS = 32;
const PADDLE_PAGE_SIZE = 30;

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function shiftDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function daysBetween(start, end) {
  const days = [];
  let cur = start;
  while (cur <= end && days.length <= MAX_DAYS) {
    days.push(cur);
    cur = shiftDays(cur, 1);
  }
  return days;
}

function buildUrl(start, end, cursor) {
  const u = new URL(`${GURU_BASE}/transactions`);
  u.searchParams.set('product_id', LEONA_GURU_PRODUCT_ID);
  u.searchParams.set('confirmed_at_ini', start);
  u.searchParams.set('confirmed_at_end', end);
  u.searchParams.set('per_page', String(PAGE_SIZE));
  for (const st of [...APPROVED_STATUSES, ...REFUND_STATUSES]) {
    u.searchParams.append('transaction_status[]', st);
  }
  if (cursor) u.searchParams.set('cursor', cursor);
  return u.toString();
}

function buildActiveSubscriptionsUrl() {
  const u = new URL(`${GURU_BASE}/subscriptions`);
  u.searchParams.set('product_id', LEONA_GURU_PRODUCT_ID);
  u.searchParams.append('subscription_status[]', 'active');
  // A Guru exige limit >= 20 e devolve total_rows na primeira pagina.
  u.searchParams.set('limit', '20');
  return u.toString();
}

function brtBoundary(day) {
  return `${day}T03:00:00.000Z`;
}

function cents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  while (nextPath && pages < 100) {
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

async function fetchPaddleMetrics(start, end) {
  if (!process.env.PADDLE_API_KEY) {
    throw Object.assign(new Error('PADDLE_API_KEY não configurado'), { status: 500 });
  }
  if (!process.env.PADDLE_ENVIRONMENT) {
    process.env.PADDLE_ENVIRONMENT = 'production';
  }

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const pixCutoffDay = shiftDays(today, -PADDLE_PIX_ACTIVE_DAYS);
  const queryStart = start < pixCutoffDay ? start : pixCutoffDay;
  const queryEnd = end > today ? end : today;

  const txParams = new URLSearchParams();
  txParams.set('status', 'completed');
  txParams.set('include', 'adjustments');
  txParams.set('per_page', String(PADDLE_PAGE_SIZE));
  txParams.set('order_by', 'billed_at[ASC]');
  txParams.set('billed_at[GTE]', brtBoundary(queryStart));
  txParams.set('billed_at[LT]', brtBoundary(shiftDays(queryEnd, 1)));

  const subParams = new URLSearchParams();
  subParams.set('status', 'active,trialing');
  subParams.set('per_page', String(PADDLE_PAGE_SIZE));

  const [transactionResult, subscriptionResult] = await Promise.all([
    fetchAllPaddle(`/transactions?${txParams.toString()}`),
    fetchAllPaddle(`/subscriptions?${subParams.toString()}`)
  ]);

  const transactions = transactionResult.rows.filter(paddleTransactionIsLeona);
  const subscriptions = subscriptionResult.rows.filter(paddleSubscriptionIsLeona);
  const activeSubscriptionCustomers = new Set(
    subscriptions.map(subscription => subscription.customer_id).filter(Boolean)
  );
  const selectedStart = brtBoundary(start);
  const selectedEnd = brtBoundary(shiftDays(end, 1));
  const pixCutoff = new Date(Date.now() - PADDLE_PIX_ACTIVE_DAYS * 24 * 60 * 60 * 1000);

  let grossCents = 0;
  let netCents = 0;
  let count = 0;
  let refundGrossCents = 0;
  let refundNetCents = 0;
  let refundCount = 0;
  const pixPrepaidCustomers = new Set();

  for (const transaction of transactions) {
    const billedAt = transaction.billed_at || '';
    const totals = transaction.details?.totals || {};
    const adjusted = transaction.details?.adjusted_totals || totals;
    const currency = totals.currency_code || transaction.currency_code;

    if (
      billedAt >= selectedStart
      && billedAt < selectedEnd
      && currency === 'BRL'
    ) {
      const originalGross = cents(totals.grand_total);
      const originalNet = cents(totals.earnings);
      const adjustedGross = cents(adjusted.grand_total);
      const adjustedNet = cents(adjusted.earnings);
      if (originalGross > 0) {
        grossCents += originalGross;
        netCents += originalNet;
        count++;
        if (adjustedGross < originalGross) {
          refundGrossCents += originalGross - adjustedGross;
          refundNetCents += Math.max(0, originalNet - adjustedNet);
          refundCount++;
        }
      }
    }

    if (
      !transaction.subscription_id
      && completedPaymentMethod(transaction) === 'pix'
      && transaction.customer_id
      && !activeSubscriptionCustomers.has(transaction.customer_id)
      && new Date(billedAt) >= pixCutoff
      && cents(adjusted.grand_total) > 0
    ) {
      pixPrepaidCustomers.add(transaction.customer_id);
    }
  }

  return {
    approved: {
      gross: Math.round(grossCents) / 100,
      net: Math.round(netCents) / 100,
      count
    },
    refunded: {
      gross: Math.round(refundGrossCents) / 100,
      net: Math.round(refundNetCents) / 100,
      count: refundCount
    },
    active_subscribers: {
      count: subscriptions.length + pixPrepaidCustomers.size,
      recurring: subscriptions.length,
      pix_prepaid: pixPrepaidCustomers.size,
      pix_active_window_days: PADDLE_PIX_ACTIVE_DAYS
    },
    pages_fetched: transactionResult.pages + subscriptionResult.pages,
    transactions_in_range: count
  };
}

async function fetchDay(day, headers) {
  let pages = 0;
  let cursor = null;
  const transactions = [];

  while (pages < MAX_PAGES_PER_DAY) {
    pages++;
    const r = await fetch(buildUrl(day, day, cursor), { headers });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      const err = new Error(`Guru retornou ${r.status} ao buscar transações`);
      err.status = 502;
      err.detail = errBody.slice(0, 500);
      err.day = day;
      throw err;
    }

    const body = await r.json();
    if (Array.isArray(body.data)) transactions.push(...body.data);
    if (!body.has_more_pages || !body.next_cursor) break;
    cursor = body.next_cursor;
  }

  return { day, pages, transactions };
}

async function fetchActiveSubscribersTotal(headers) {
  const r = await fetch(buildActiveSubscriptionsUrl(), { headers });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    const err = new Error(`Guru retornou ${r.status} ao buscar assinantes ativos`);
    err.status = 502;
    err.detail = errBody.slice(0, 500);
    throw err;
  }

  const body = await r.json();
  if (Number.isFinite(Number(body.total_rows))) {
    return Number(body.total_rows);
  }

  const data = Array.isArray(body.data) ? body.data : [];
  return data.filter(s =>
    s?.product?.id === LEONA_GURU_PRODUCT_ID &&
    s?.last_status === 'active'
  ).length;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const expectedToken = process.env.SUPPORT_CHAT_TOKEN?.trim();
  if (!expectedToken) return res.status(500).json({ error: 'SUPPORT_CHAT_TOKEN não configurado' });

  const auth = req.headers.authorization || '';
  const providedToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (providedToken !== expectedToken) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const guruToken = process.env.GURU_TOKEN;
  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });

  const { start, end } = req.body || {};

  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'Informe start e end no formato YYYY-MM-DD' });
  }
  if (start > end) {
    return res.status(400).json({ error: 'start não pode ser maior que end' });
  }

  const days = daysBetween(start, end);
  if (days.length > MAX_DAYS) {
    return res.status(400).json({ error: `Intervalo grande demais. Máximo: ${MAX_DAYS} dias.` });
  }

  const headers = guruHeaders(guruToken);

  let gross = 0;
  let net = 0;
  let count = 0;
  let refundGross = 0;
  let refundNet = 0;
  let refundCount = 0;
  let scanned = 0;
  let totalPages = 0;

  try {
    const t0 = Date.now();
    const seen = new Set(); // dedup por id (transacoes podem repetir entre dias)
    const [activeSubscribersTotal, results, paddle] = await Promise.all([
      fetchActiveSubscribersTotal(headers),
      Promise.all(days.map(day => fetchDay(day, headers))),
      fetchPaddleMetrics(start, end)
    ]);

    for (const { pages, transactions } of results) {
      totalPages += pages;
      for (const t of transactions) {
        if (t?.product?.internal_id !== LEONA_GURU_PRODUCT_ID) continue;
        const id = t?.id || t?.invoice?.id || JSON.stringify([t?.subscription?.id, t?.payment?.marketplace_id]);
        if (seen.has(id)) continue;
        seen.add(id);

        scanned++;
        const status = String(t?.status || '').toLowerCase();
        const g = Number(t?.payment?.gross) || 0;
        const n = Number(t?.payment?.net) || 0;

        if (APPROVED_STATUSES.includes(status)) {
          gross += g;
          net += n;
          count++;
        } else if (REFUND_STATUSES.includes(status)) {
          refundGross += g;
          refundNet += n;
          refundCount++;
        }
      }
    }
    const fetchMs = Date.now() - t0;

    const guru = {
      approved: {
        gross: Math.round(gross * 100) / 100,
        net: Math.round(net * 100) / 100,
        count
      },
      refunded: {
        gross: Math.round(refundGross * 100) / 100,
        net: Math.round(refundNet * 100) / 100,
        count: refundCount
      },
      active_subscribers: {
        count: activeSubscribersTotal
      },
      pages_fetched: totalPages,
      transactions_in_range: scanned
    };
    const approved = {
      gross: Math.round((guru.approved.gross + paddle.approved.gross) * 100) / 100,
      net: Math.round((guru.approved.net + paddle.approved.net) * 100) / 100,
      count: guru.approved.count + paddle.approved.count
    };
    const refunded = {
      gross: Math.round((guru.refunded.gross + paddle.refunded.gross) * 100) / 100,
      net: Math.round((guru.refunded.net + paddle.refunded.net) * 100) / 100,
      count: guru.refunded.count + paddle.refunded.count
    };

    return res.status(200).json({
      product_id: LEONA_GURU_PRODUCT_ID,
      range: { start, end },
      approved,
      refunded,
      active_subscribers: {
        count: guru.active_subscribers.count + paddle.active_subscribers.count
      },
      platforms: { guru, paddle },
      pages_fetched: totalPages + paddle.pages_fetched,
      days_queried: days.length,
      transactions_in_range: scanned + paddle.transactions_in_range,
      fetch_ms: fetchMs
    });
  } catch (e) {
    console.error('guru-revenue error:', e);
    return res.status(e.status || 500).json({ error: e.message, detail: e.detail, day: e.day });
  }
}
