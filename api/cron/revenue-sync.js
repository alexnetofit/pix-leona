/**
 * api/cron/revenue-sync.js — Mantem `revenue_daily` atualizada.
 *
 * Janelas, escolhidas pela query `window`:
 *   - recent (default): hoje e ontem. Roda de 5 em 5 minutos, e o que deixa a
 *     tela /guru mostrando numero fresco sem consultar a Guru na hora.
 *   - rescan: os ultimos 30 dias. Roda uma vez por dia, de madrugada, porque
 *     reembolso e chargeback chegam depois e mudam o numero de um dia que ja
 *     estava fechado.
 *   - backfill: `days` dias pra tras (teto de MAX_BACKFILL_DAYS). Nao tem cron;
 *     e chamada manual, usada pra carga inicial do historico.
 */
import { revenueCacheEnabled, syncRevenueDays } from '../../lib/revenue-daily.js';
import { brtToday, daysBetween, shiftDays } from '../../lib/revenue-source.js';
import { timingSafeStringEqual } from '../../lib/paddle-session.js';

const RECENT_DAYS = 2;
const RESCAN_DAYS = 30;
const MAX_BACKFILL_DAYS = 120;

/**
 * A Guru gasta ~3,4s por pagina de 100 transacoes e o lote roda 4 dias em
 * paralelo, entao o tempo cresce junto com a janela: 30 dias levam ~50s e 120
 * dias chegam perto do teto de 300s configurado no vercel.json.
 */
function resolveSpan(window, requestedDays) {
  if (window === 'backfill') {
    const parsed = Number.parseInt(requestedDays, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return RESCAN_DAYS;
    return Math.min(parsed, MAX_BACKFILL_DAYS);
  }
  return window === 'rescan' ? RESCAN_DAYS : RECENT_DAYS;
}

function authorized(req) {
  const expected = process.env.CRON_SECRET || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  if (!revenueCacheEnabled()) {
    return res.status(200).json({ skipped: 'supabase_not_configured' });
  }

  const guruToken = process.env.GURU_TOKEN;
  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });

  const requested = String(req.query?.window || 'recent');
  const window = ['recent', 'rescan', 'backfill'].includes(requested) ? requested : 'recent';
  const span = resolveSpan(window, req.query?.days);
  const today = brtToday();
  const days = daysBetween(shiftDays(today, -(span - 1)), today);

  const startedAt = Date.now();
  try {
    const result = await syncRevenueDays(days, { guruToken, includeSnapshot: true });
    return res.status(200).json({
      window,
      days_synced: result.days.length,
      range: { start: days[0], end: days[days.length - 1] },
      subscribers: result.snapshot
        ? {
          guru: result.snapshot.guru?.count ?? null,
          paddle: result.snapshot.paddle?.count ?? null,
          pagou: result.snapshot.pagou?.count ?? null,
          dlocal: result.snapshot.dlocal?.count ?? null,
          pagarme: result.snapshot.pagarme?.count ?? null
        }
        : null,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (error) {
    console.error('revenue-sync error:', error);
    return res.status(error.status || 500).json({
      error: error.message,
      detail: error.detail,
      day: error.day,
      elapsed_ms: Date.now() - startedAt
    });
  }
}
