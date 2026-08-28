/**
 * lib/revenue-daily.js — Leitura e escrita do cache diario de faturamento.
 *
 * A tabela `revenue_daily` guarda um agregado fechado por dia e por
 * plataforma. A tela /guru le esse agregado (milissegundos) em vez de bater na
 * Guru a cada abertura (~50s pra 30 dias). O cron mantem os dias recentes
 * atualizados; dias antigos so mudam quando entra reembolso ou chargeback
 * atrasado, e por isso a rodada noturna refaz a janela recente inteira.
 */
import { sbConfigured, sbSelectWhere, sbUpsert } from './supabase.js';
import {
  DLOCAL_ACTIVE_DAYS,
  PAGARME_ACTIVE_DAYS,
  PADDLE_PIX_ACTIVE_DAYS,
  brtToday,
  daysBetween,
  emptyTotals,
  fetchDlocalDailyTotals,
  fetchDlocalSubscriberSnapshot,
  fetchGuruActiveSubscribers,
  fetchGuruDailyTotals,
  fetchPagarmeDailyTotals,
  fetchPagarmeSubscriberSnapshot,
  fetchPagouDailyTotals,
  fetchPagouSubscriberSnapshot,
  fetchPaddleDailyTotals,
  fetchPaddleSubscriberSnapshot,
  shiftDays,
  assignUniqueSubscribers
} from './revenue-source.js';
import { filterEmailsWithActiveGuru, LEONA_GURU_PRODUCT_ID } from './guru.js';

const TABLE = 'revenue_daily';
export const PLATFORMS = ['guru', 'paddle', 'pagou', 'dlocal', 'pagarme'];

/**
 * Dias recentes podem mudar (venda entrando, reembolso caindo), entao tem
 * validade curta. Dias mais antigos ficam sob responsabilidade do cron
 * noturno pra nao penalizar quem abre a tela.
 */
const RECENT_DAYS = 2;
const RECENT_TTL_MS = 15 * 60 * 1000;

export function revenueCacheEnabled() {
  return sbConfigured();
}

export async function readRevenueRows(start, end) {
  return sbSelectWhere(TABLE, {
    gte: { day: start },
    lte: { day: end },
    order: 'day.asc',
    limit: 2000
  });
}

export async function upsertRevenueRows(rows) {
  if (!rows.length) return [];
  return sbUpsert(TABLE, rows, { onConflict: 'day,platform', single: false });
}

/**
 * Ultimo snapshot de assinantes por plataforma. E metrica de "agora": o valor
 * fica no dia em que foi coletado, entao pegamos o mais recente disponivel.
 */
export async function readSubscriberSnapshot() {
  const rows = await sbSelectWhere(TABLE, {
    // Comparacao numerica ja descarta os dias sem snapshot (null).
    gte: { active_subscribers: 0 },
    order: 'day.desc',
    limit: 20
  });
  const snapshot = {};
  for (const row of rows) {
    if (snapshot[row.platform]) continue;
    snapshot[row.platform] = {
      count: Number(row.active_subscribers) || 0,
      recurring: row.active_subscribers_recurring == null
        ? null
        : Number(row.active_subscribers_recurring),
      prepaid: row.active_subscribers_prepaid == null
        ? null
        : Number(row.active_subscribers_prepaid),
      day: row.day,
      synced_at: row.synced_at
    };
  }
  return snapshot;
}

function rowKey(day, platform) {
  return `${day}:${platform}`;
}

/**
 * Por plataforma, quais dias faltam ou estao velhos demais. Assim a tela nao
 * reconsulta a Guru so porque a Pagou ainda nao tinha row.
 */
export function findSyncPlan(days, rows, { today = brtToday() } = {}) {
  const index = new Map(rows.map(row => [rowKey(row.day, row.platform), row]));
  const recentCutoff = shiftDays(today, -RECENT_DAYS + 1);
  const now = Date.now();
  const plan = Object.fromEntries(PLATFORMS.map(platform => [platform, []]));

  for (const day of days) {
    for (const platform of PLATFORMS) {
      const row = index.get(rowKey(day, platform));
      if (!row) {
        plan[platform].push(day);
        continue;
      }
      if (day >= recentCutoff) {
        const age = now - new Date(row.synced_at).getTime();
        if (!Number.isFinite(age) || age > RECENT_TTL_MS) {
          plan[platform].push(day);
        }
      }
    }
  }

  return plan;
}

/**
 * Dias que precisam ser buscados na fonte: sem registro, ou recentes demais
 * pra confiar no que esta gravado.
 */
export function findDaysToSync(days, rows, options) {
  const plan = findSyncPlan(days, rows, options);
  return days.filter(day => PLATFORMS.some(platform => plan[platform].includes(day)));
}

function buildPlatformRows(days, platform, byDay, snapshot, today) {
  const syncedAt = new Date().toISOString();
  return days.map(day => {
    const totals = byDay.get(day) || emptyTotals();
    const platformSnapshot = day === today ? snapshot?.[platform] : null;
    return {
      day,
      platform,
      gross_cents: totals.gross_cents,
      net_cents: totals.net_cents,
      sales_count: totals.sales_count,
      refund_gross_cents: totals.refund_gross_cents,
      refund_net_cents: totals.refund_net_cents,
      refund_count: totals.refund_count,
      transactions_scanned: totals.transactions_scanned,
      source_pages: totals.source_pages,
      active_subscribers: platformSnapshot ? platformSnapshot.count : null,
      active_subscribers_recurring: platformSnapshot?.recurring ?? null,
      active_subscribers_prepaid: platformSnapshot?.prepaid ?? null,
      synced_at: syncedAt
    };
  });
}

/**
 * Busca so as plataformas do plano. Se so falta Pagou/Pagar.me, Guru, Paddle e
 * dLocal ficam quietas — inclusive o snapshot pesado delas.
 */
export async function collectRevenuePlan(plan, { guruToken, includeSnapshot } = {}) {
  const guruDays = plan.guru || [];
  const paddleDays = plan.paddle || [];
  const pagouDays = plan.pagou || [];
  const dlocalDays = plan.dlocal || [];
  const pagarmeDays = plan.pagarme || [];
  const days = [...new Set([
    ...guruDays,
    ...paddleDays,
    ...pagouDays,
    ...dlocalDays,
    ...pagarmeDays
  ])].sort();
  if (!days.length) return { rows: [], days: [], snapshot: null };
  const today = brtToday();
  const snapshotFlags = {
    guru: guruDays.includes(today),
    paddle: paddleDays.includes(today),
    pagou: pagouDays.includes(today),
    dlocal: dlocalDays.includes(today),
    pagarme: pagarmeDays.includes(today)
  };
  const heavyToday = snapshotFlags.guru || snapshotFlags.paddle || snapshotFlags.dlocal;
  const cheapToday = snapshotFlags.pagarme || snapshotFlags.pagou;
  const wantsFullSnapshot = includeSnapshot === true || (includeSnapshot == null && heavyToday);
  const wantsCheapSnapshot = !wantsFullSnapshot && includeSnapshot !== false && cheapToday;
  if ((guruDays.length || wantsFullSnapshot) && !guruToken) throw new Error('GURU_TOKEN não configurado');

  const [guruByDay, paddleResult, pagouResult, dlocalResult, pagarmeResult, snapshot] = await Promise.all([
    guruDays.length ? fetchGuruDailyTotals(guruDays, guruToken) : Promise.resolve(new Map()),
    paddleDays.length ? fetchPaddleDailyTotals(paddleDays) : Promise.resolve({ byDay: new Map() }),
    pagouDays.length ? fetchPagouDailyTotals(pagouDays) : Promise.resolve({ byDay: new Map() }),
    dlocalDays.length ? fetchDlocalDailyTotals(dlocalDays) : Promise.resolve({ byDay: new Map() }),
    pagarmeDays.length ? fetchPagarmeDailyTotals(pagarmeDays) : Promise.resolve({ byDay: new Map() }),
    wantsFullSnapshot
      ? collectSnapshot(guruToken)
      : wantsCheapSnapshot
        ? collectCheapSnapshot(snapshotFlags)
        : Promise.resolve(null)
  ]);

  return {
    rows: [
      ...buildPlatformRows(guruDays, 'guru', guruByDay, snapshot, today),
      ...buildPlatformRows(paddleDays, 'paddle', paddleResult.byDay, snapshot, today),
      ...buildPlatformRows(pagouDays, 'pagou', pagouResult.byDay, snapshot, today),
      ...buildPlatformRows(dlocalDays, 'dlocal', dlocalResult.byDay, snapshot, today),
      ...buildPlatformRows(pagarmeDays, 'pagarme', pagarmeResult.byDay, snapshot, today)
    ],
    days,
    snapshot
  };
}

/**
 * Busca os dias informados nas fontes, sem gravar. O snapshot de assinantes so
 * e coletado quando o dia de hoje esta no lote, porque e uma medida do
 * momento, nao do dia.
 */
export async function collectRevenueDays(days, { guruToken, includeSnapshot } = {}) {
  if (!days.length) return { rows: [], days: [], snapshot: null };
  if (!guruToken) throw new Error('GURU_TOKEN não configurado');
  return collectRevenuePlan(
    Object.fromEntries(PLATFORMS.map(platform => [platform, days])),
    { guruToken, includeSnapshot }
  );
}

/** Igual a collectRevenueDays, mas persiste o resultado na tabela. */
export async function syncRevenueDays(days, options = {}) {
  const result = await collectRevenueDays(days, options);
  await upsertRevenueRows(result.rows);
  return result;
}

export async function syncRevenuePlan(plan, options = {}) {
  const result = await collectRevenuePlan(plan, options);
  await upsertRevenueRows(result.rows);
  return result;
}

function snapshotFromRow(entry) {
  if (!entry) return null;
  return {
    count: Number(entry.count) || 0,
    recurring: entry.recurring == null ? null : Number(entry.recurring),
    prepaid: entry.prepaid == null ? null : Number(entry.prepaid)
  };
}

/**
 * Quando so Pagou/Pagar.me estao velhas, nao refaz Guru/Paddle/dLocal.
 * Esses snapshots pesados ficam pro cron ou pra quando a propria fonte cara
 * precisa ser sincronizada hoje.
 */
async function collectCheapSnapshot(flags = {}) {
  const existing = await readSubscriberSnapshot();
  const [pagou, pagarme] = await Promise.all([
    flags.pagou ? fetchPagouSubscriberSnapshot() : Promise.resolve(null),
    flags.pagarme ? fetchPagarmeSubscriberSnapshot() : Promise.resolve(null)
  ]);
  return {
    guru: snapshotFromRow(existing.guru),
    paddle: snapshotFromRow(existing.paddle),
    pagou: pagou
      ? { count: pagou.count, recurring: pagou.recurring, prepaid: pagou.prepaid }
      : snapshotFromRow(existing.pagou),
    dlocal: snapshotFromRow(existing.dlocal),
    pagarme: pagarme
      ? { count: pagarme.count, recurring: pagarme.recurring, prepaid: pagarme.prepaid }
      : snapshotFromRow(existing.pagarme)
  };
}

async function collectSnapshot(guruToken) {
  const [guruCount, paddle, pagou, dlocal, pagarme] = await Promise.all([
    fetchGuruActiveSubscribers(guruToken),
    fetchPaddleSubscriberSnapshot(),
    fetchPagouSubscriberSnapshot(),
    fetchDlocalSubscriberSnapshot(),
    fetchPagarmeSubscriberSnapshot()
  ]);

  const paddleEmails = paddle.emails || [];
  const pagouEmails = pagou.emails || [];
  const dlocalEmails = dlocal.emails || [];
  const pagarmeEmails = pagarme.emails || [];
  const occupied = new Set([...paddleEmails, ...dlocalEmails]);
  const overlapCandidates = [
    ...paddleEmails,
    ...pagouEmails.filter((email) => !occupied.has(email)),
    ...pagarmeEmails.filter((email) => !occupied.has(email) && !pagouEmails.includes(email))
  ];
  const guruOverlapEmails = await filterEmailsWithActiveGuru(overlapCandidates, guruToken);
  const assigned = assignUniqueSubscribers({
    guruCount,
    paddleEmails,
    pagouEmails,
    dlocalEmails,
    pagarmeEmails,
    guruOverlapEmails
  });

  const dlocalRecurring = Math.min(dlocal.recurring || 0, assigned.dlocal);
  const pagarmeRecurring = Math.min(pagarme.recurring || 0, assigned.pagarme);
  return {
    unique: assigned.unique,
    guru: { count: guruCount, recurring: null, prepaid: null },
    paddle: { count: paddle.count, recurring: paddle.recurring, prepaid: paddle.prepaid },
    pagou: { count: assigned.pagou, recurring: null, prepaid: assigned.pagou },
    dlocal: {
      count: assigned.dlocal,
      recurring: dlocalRecurring,
      prepaid: assigned.dlocal - dlocalRecurring
    },
    pagarme: {
      count: assigned.pagarme,
      recurring: pagarmeRecurring,
      prepaid: assigned.pagarme - pagarmeRecurring
    }
  };
}

function money(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

/** Converte o USD da Pagou pra BRL pelo câmbio implícito do dia (bruto BRL / bruto USD). */
function pagouBrlBlock(totals) {
  const usdGross = Number(totals.gross_cents) || 0;
  const brlGross = Number(totals.transactions_scanned) || 0;
  const toBrl = (usdCents) => {
    if (usdGross <= 0) return 0;
    return Math.round((Number(usdCents) || 0) * brlGross / usdGross);
  };
  return {
    gross_cents: brlGross,
    net_cents: toBrl(totals.net_cents),
    refund_gross_cents: toBrl(totals.refund_gross_cents),
    refund_net_cents: toBrl(totals.refund_net_cents)
  };
}

function sumTotals(rows) {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.gross_cents += Number(row.gross_cents) || 0;
    totals.net_cents += Number(row.net_cents) || 0;
    totals.sales_count += Number(row.sales_count) || 0;
    totals.refund_gross_cents += Number(row.refund_gross_cents) || 0;
    totals.refund_net_cents += Number(row.refund_net_cents) || 0;
    totals.refund_count += Number(row.refund_count) || 0;
    totals.transactions_scanned += Number(row.transactions_scanned) || 0;
    totals.source_pages += Number(row.source_pages) || 0;
  }
  return totals;
}

function platformBlock(totals) {
  return {
    approved: {
      gross: money(totals.gross_cents),
      net: money(totals.net_cents),
      count: totals.sales_count
    },
    refunded: {
      gross: money(totals.refund_gross_cents),
      net: money(totals.refund_net_cents),
      count: totals.refund_count
    },
    pages_fetched: totals.source_pages,
    transactions_in_range: totals.transactions_scanned
  };
}

/**
 * Monta o resumo de um intervalo a partir das rows da tabela, no mesmo formato
 * que a tela ja consumia.
 */
export function summarizeRange(start, end, rows, snapshot) {
  const days = daysBetween(start, end);
  const inRange = rows.filter(row => row.day >= start && row.day <= end);
  const guruRows = inRange.filter(row => row.platform === 'guru');
  const paddleRows = inRange.filter(row => row.platform === 'paddle');
  const pagouRows = inRange.filter(row => row.platform === 'pagou');
  const dlocalRows = inRange.filter(row => row.platform === 'dlocal');
  const pagarmeRows = inRange.filter(row => row.platform === 'pagarme');
  const brlRows = [...guruRows, ...paddleRows, ...dlocalRows, ...pagarmeRows];

  const guruTotals = sumTotals(guruRows);
  const paddleTotals = sumTotals(paddleRows);
  const pagouTotals = sumTotals(pagouRows);
  const dlocalTotals = sumTotals(dlocalRows);
  const pagarmeTotals = sumTotals(pagarmeRows);
  const combined = sumTotals(brlRows);
  const pagouBrl = pagouBrlBlock(pagouTotals);

  const grossByDay = new Map();
  for (const row of brlRows) {
    grossByDay.set(row.day, (grossByDay.get(row.day) || 0) + (Number(row.gross_cents) || 0));
  }
  for (const row of pagouRows) {
    grossByDay.set(row.day, (grossByDay.get(row.day) || 0) + (Number(row.transactions_scanned) || 0));
  }

  const guruSnapshot = snapshot?.guru;
  const paddleSnapshot = snapshot?.paddle;
  const pagouSnapshot = snapshot?.pagou;
  const dlocalSnapshot = snapshot?.dlocal;
  const pagarmeSnapshot = snapshot?.pagarme;
  const guru = platformBlock(guruTotals);
  const paddle = platformBlock(paddleTotals);
  const pagou = platformBlock(pagouTotals);
  const dlocal = platformBlock(dlocalTotals);
  const pagarme = platformBlock(pagarmeTotals);
  pagou.currency = 'BRL';
  pagou.approved.gross = money(pagouBrl.gross_cents);
  pagou.approved.net = money(pagouBrl.net_cents);
  pagou.approved.brl = money(pagouBrl.gross_cents);
  pagarme.currency = 'BRL';
  guru.active_subscribers = { count: guruSnapshot?.count ?? null };
  paddle.active_subscribers = {
    count: paddleSnapshot?.count ?? null,
    recurring: paddleSnapshot?.recurring ?? null,
    pix_prepaid: paddleSnapshot?.prepaid ?? null,
    pix_active_window_days: PADDLE_PIX_ACTIVE_DAYS
  };
  pagou.active_subscribers = {
    count: pagouSnapshot?.count ?? null,
    recurring: pagouSnapshot?.recurring ?? null,
    prepaid: pagouSnapshot?.prepaid ?? null
  };
  dlocal.active_subscribers = {
    count: dlocalSnapshot?.count ?? null,
    recurring: dlocalSnapshot?.recurring ?? null,
    prepaid: dlocalSnapshot?.prepaid ?? null,
    prepaid_window_days: DLOCAL_ACTIVE_DAYS
  };
  pagarme.active_subscribers = {
    count: pagarmeSnapshot?.count ?? null,
    recurring: pagarmeSnapshot?.recurring ?? null,
    prepaid: pagarmeSnapshot?.prepaid ?? null,
    prepaid_window_days: PAGARME_ACTIVE_DAYS
  };

  const summedSubscribers = (guruSnapshot || paddleSnapshot || pagouSnapshot || dlocalSnapshot || pagarmeSnapshot)
    ? (guruSnapshot?.count || 0)
      + (paddleSnapshot?.count || 0)
      + (pagouSnapshot?.count || 0)
      + (dlocalSnapshot?.count || 0)
      + (pagarmeSnapshot?.count || 0)
    : null;
  const subscriberTotal = snapshot?.unique == null ? summedSubscribers : snapshot.unique;

  return {
    product_id: LEONA_GURU_PRODUCT_ID,
    range: { start, end },
    approved: {
      gross: money(combined.gross_cents + pagouBrl.gross_cents),
      net: money(combined.net_cents + pagouBrl.net_cents),
      count: combined.sales_count + pagouTotals.sales_count
    },
    refunded: {
      gross: money(combined.refund_gross_cents + pagouBrl.refund_gross_cents),
      net: money(combined.refund_net_cents + pagouBrl.refund_net_cents),
      count: combined.refund_count + pagouTotals.refund_count
    },
    daily: days.map(day => ({ day, gross: money(grossByDay.get(day) || 0) })),
    active_subscribers: { count: subscriberTotal },
    platforms: { guru, paddle, pagou, dlocal, pagarme },
    pages_fetched: combined.source_pages,
    days_queried: days.length,
    days_missing: days.filter(day => !grossByDay.has(day)).length,
    transactions_in_range: combined.transactions_scanned
  };
}
