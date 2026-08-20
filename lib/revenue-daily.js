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
  PADDLE_PIX_ACTIVE_DAYS,
  brtToday,
  daysBetween,
  emptyTotals,
  fetchGuruActiveSubscribers,
  fetchGuruDailyTotals,
  fetchPagouDailyTotals,
  fetchPagouSubscriberSnapshot,
  fetchPaddleDailyTotals,
  fetchPaddleSubscriberSnapshot,
  shiftDays
} from './revenue-source.js';
import { LEONA_GURU_PRODUCT_ID } from './guru.js';

const TABLE = 'revenue_daily';
export const PLATFORMS = ['guru', 'paddle', 'pagou'];

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
 * Dias que precisam ser buscados na fonte: sem registro, ou recentes demais
 * pra confiar no que esta gravado.
 */
export function findDaysToSync(days, rows, { today = brtToday() } = {}) {
  const index = new Map(rows.map(row => [rowKey(row.day, row.platform), row]));
  const recentCutoff = shiftDays(today, -RECENT_DAYS + 1);
  const now = Date.now();

  return days.filter(day => {
    for (const platform of PLATFORMS) {
      const row = index.get(rowKey(day, platform));
      if (!row) return true;
      if (day >= recentCutoff) {
        const age = now - new Date(row.synced_at).getTime();
        if (!Number.isFinite(age) || age > RECENT_TTL_MS) return true;
      }
    }
    return false;
  });
}

function totalsByPlatform(platform, guruByDay, paddleByDay, pagouByDay, day) {
  if (platform === 'guru') return guruByDay.get(day) || emptyTotals();
  if (platform === 'paddle') return paddleByDay.get(day) || emptyTotals();
  return pagouByDay.get(day) || emptyTotals();
}

function buildRows(days, guruByDay, paddleByDay, pagouByDay, snapshot, today) {
  const syncedAt = new Date().toISOString();
  const rows = [];

  for (const day of days) {
    for (const platform of PLATFORMS) {
      const totals = totalsByPlatform(platform, guruByDay, paddleByDay, pagouByDay, day);
      const platformSnapshot = day === today ? snapshot?.[platform] : null;
      rows.push({
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
      });
    }
  }

  return rows;
}

/**
 * Busca os dias informados nas fontes, sem gravar. O snapshot de assinantes so
 * e coletado quando o dia de hoje esta no lote, porque e uma medida do
 * momento, nao do dia.
 */
export async function collectRevenueDays(days, { guruToken, includeSnapshot } = {}) {
  if (!days.length) return { rows: [], days: [], snapshot: null };
  if (!guruToken) throw new Error('GURU_TOKEN não configurado');

  const today = brtToday();
  const wantsSnapshot = includeSnapshot ?? days.includes(today);

  const [guruByDay, paddleResult, pagouResult, snapshot] = await Promise.all([
    fetchGuruDailyTotals(days, guruToken),
    fetchPaddleDailyTotals(days),
    fetchPagouDailyTotals(days),
    wantsSnapshot ? collectSnapshot(guruToken) : Promise.resolve(null)
  ]);

  return {
    rows: buildRows(days, guruByDay, paddleResult.byDay, pagouResult.byDay, snapshot, today),
    days,
    snapshot
  };
}

/** Igual a collectRevenueDays, mas persiste o resultado na tabela. */
export async function syncRevenueDays(days, options = {}) {
  const result = await collectRevenueDays(days, options);
  await upsertRevenueRows(result.rows);
  return result;
}

async function collectSnapshot(guruToken) {
  const [guruCount, paddle, pagou] = await Promise.all([
    fetchGuruActiveSubscribers(guruToken),
    fetchPaddleSubscriberSnapshot(),
    fetchPagouSubscriberSnapshot()
  ]);
  return {
    guru: { count: guruCount, recurring: null, prepaid: null },
    paddle: { count: paddle.count, recurring: paddle.recurring, prepaid: paddle.prepaid },
    pagou: { count: pagou.count, recurring: pagou.recurring, prepaid: pagou.prepaid }
  };
}

function money(cents) {
  return Math.round(Number(cents) || 0) / 100;
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
  const brlRows = [...guruRows, ...paddleRows];

  const guruTotals = sumTotals(guruRows);
  const paddleTotals = sumTotals(paddleRows);
  const pagouTotals = sumTotals(pagouRows);
  const combined = sumTotals(brlRows);

  const grossByDay = new Map();
  for (const row of brlRows) {
    grossByDay.set(row.day, (grossByDay.get(row.day) || 0) + (Number(row.gross_cents) || 0));
  }

  const guruSnapshot = snapshot?.guru;
  const paddleSnapshot = snapshot?.paddle;
  const pagouSnapshot = snapshot?.pagou;
  const guru = platformBlock(guruTotals);
  const paddle = platformBlock(paddleTotals);
  const pagou = platformBlock(pagouTotals);
  pagou.currency = 'USD';
  pagou.approved.brl = money(pagouTotals.transactions_scanned);
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

  const subscriberTotal = (guruSnapshot || paddleSnapshot || pagouSnapshot)
    ? (guruSnapshot?.count || 0) + (paddleSnapshot?.count || 0) + (pagouSnapshot?.count || 0)
    : null;

  return {
    product_id: LEONA_GURU_PRODUCT_ID,
    range: { start, end },
    approved: {
      gross: money(combined.gross_cents),
      net: money(combined.net_cents),
      count: combined.sales_count
    },
    refunded: {
      gross: money(combined.refund_gross_cents),
      net: money(combined.refund_net_cents),
      count: combined.refund_count
    },
    daily: days.map(day => ({ day, gross: money(grossByDay.get(day) || 0) })),
    active_subscribers: { count: subscriberTotal },
    platforms: { guru, paddle, pagou },
    pages_fetched: combined.source_pages,
    days_queried: days.length,
    days_missing: days.filter(day => !grossByDay.has(day)).length,
    transactions_in_range: combined.transactions_scanned
  };
}
