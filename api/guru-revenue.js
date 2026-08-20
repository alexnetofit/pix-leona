/**
 * api/guru-revenue.js — Faturamento consolidado (Guru + Paddle + Pagou) da tela /guru.
 *
 * Body JSON:
 *   {
 *     start: "YYYY-MM-DD",          // dia inicial em America/Sao_Paulo
 *     end:   "YYYY-MM-DD",          // dia final em America/Sao_Paulo
 *     compare_start: "YYYY-MM-DD",  // opcional: periodo de comparacao
 *     compare_end:   "YYYY-MM-DD",
 *     force: true                   // opcional: refaz a coleta na fonte
 *   }
 *
 * O caminho normal le o agregado diario de `revenue_daily`, alimentado pelo
 * cron /api/cron/revenue-sync. Consultar a Guru na hora custava ~50s pra 30
 * dias (paginacao por cursor, ~3,4s por pagina), e o comparativo dobrava isso.
 *
 * O periodo de comparacao vem do cliente porque quem sabe a intencao e a tela:
 * "mes" compara com o mesmo trecho do mes anterior, "7 dias" com os 7 dias
 * imediatamente anteriores. Ler dois intervalos da tabela sai praticamente de
 * graca, entao os dois voltam na mesma resposta.
 *
 * Sem credencial de Supabase o endpoint cai no modo direto (consulta as fontes
 * a cada chamada), que e o comportamento antigo.
 */
import { applyCors } from '../lib/auth.js';
import {
  collectRevenueDays,
  findSyncPlan,
  readRevenueRows,
  readSubscriberSnapshot,
  revenueCacheEnabled,
  summarizeRange,
  syncRevenuePlan
} from '../lib/revenue-daily.js';
import { brtToday, daysBetween, isValidDay, shiftDays } from '../lib/revenue-source.js';

/** Teto do intervalo que pode ser lido da tabela (barato). */
const MAX_READ_DAYS = 400;
/** Teto do intervalo que pode ser coletado na fonte (caro). */
const MAX_LIVE_DAYS = 62;
/**
 * Numa abertura de tela comum so vale a pena buscar na fonte os dias recentes
 * que o cron possa ter perdido. Buraco em dia antigo fica pro cron ou pro
 * botao de atualizar, pra ninguem esperar 50s sem pedir.
 */
const MAX_INLINE_SYNC_DAYS = 2;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
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

  const { start, end, compare_start: compareStart, compare_end: compareEnd, force } = req.body || {};

  if (!isValidDay(start) || !isValidDay(end)) {
    return badRequest(res, 'Informe start e end no formato YYYY-MM-DD');
  }
  if (start > end) return badRequest(res, 'start não pode ser maior que end');

  const hasCompare = compareStart !== undefined || compareEnd !== undefined;
  if (hasCompare) {
    if (!isValidDay(compareStart) || !isValidDay(compareEnd)) {
      return badRequest(res, 'Informe compare_start e compare_end no formato YYYY-MM-DD');
    }
    if (compareStart > compareEnd) {
      return badRequest(res, 'compare_start não pode ser maior que compare_end');
    }
  }

  res.setHeader('Cache-Control', 'private, no-store');

  try {
    const payload = revenueCacheEnabled()
      ? await servedFromCache({
        start,
        end,
        compareStart: hasCompare ? compareStart : null,
        compareEnd: hasCompare ? compareEnd : null,
        force: force === true,
        guruToken
      })
      : await servedLive({ start, end, guruToken });

    res.setHeader('X-Leona-Revenue-Source', payload.cache.status);
    return res.status(200).json(payload);
  } catch (error) {
    console.error('guru-revenue error:', error);
    return res.status(error.status || 500).json({
      error: error.message,
      detail: error.detail,
      day: error.day
    });
  }
}

async function servedFromCache({ start, end, compareStart, compareEnd, force, guruToken }) {
  const readStart = compareStart && compareStart < start ? compareStart : start;
  const readEnd = compareEnd && compareEnd > end ? compareEnd : end;
  const readDays = daysBetween(readStart, readEnd, MAX_READ_DAYS + 1);
  if (readDays.length > MAX_READ_DAYS) {
    throw Object.assign(
      new Error(`Intervalo grande demais. Máximo: ${MAX_READ_DAYS} dias.`),
      { status: 400 }
    );
  }

  const startedAt = Date.now();
  // As duas leituras sao independentes, e o Supabase fica em outra regiao: em
  // sequencia elas custariam duas idas e voltas.
  let [rows, snapshot] = await Promise.all([
    readRevenueRows(readStart, readEnd),
    readSubscriberSnapshot()
  ]);

  const pending = findSyncPlan(readDays, rows);
  const synced = selectPlanToSyncInline(pending, force);

  if (planHasDays(synced)) {
    await syncRevenuePlan(synced, { guruToken });
    [rows, snapshot] = await Promise.all([
      readRevenueRows(readStart, readEnd),
      readSubscriberSnapshot()
    ]);
  }

  const current = summarizeRange(start, end, rows, snapshot);
  // Assinantes ativos e medida do agora, entao nao faz sentido repetir o numero
  // atual dentro do periodo passado.
  const previous = compareStart
    ? summarizeRange(compareStart, compareEnd, rows, null)
    : null;

  const outdated = countPlanDays(pending) - countPlanDays(synced);
  const missing = current.days_missing + (previous?.days_missing || 0);
  return {
    ...current,
    previous,
    fetch_ms: Date.now() - startedAt,
    cache: {
      status: missing > 0 ? 'partial' : 'cached',
      days_synced_now: countPlanDays(synced),
      days_outdated: outdated > 0 ? outdated : 0,
      age_seconds: snapshotAgeSeconds(snapshot)
    }
  };
}

/**
 * Guru e cara: sem `force` so os 2 dias recentes. Pagou e barata, entao
 * preenche o intervalo inteiro (teto de MAX_LIVE_DAYS) sem reconsultar Guru.
 */
function selectPlanToSyncInline(pending, force) {
  return {
    guru: selectDaysToSyncInline(pending.guru, force),
    paddle: selectDaysToSyncInline(pending.paddle, force),
    pagou: (pending.pagou || []).slice(-MAX_LIVE_DAYS)
  };
}

function selectDaysToSyncInline(pending, force) {
  if (!pending?.length) return [];
  if (force) return pending.slice(-MAX_LIVE_DAYS);
  const recentCutoff = shiftDays(brtToday(), -MAX_INLINE_SYNC_DAYS + 1);
  return pending.filter(day => day >= recentCutoff).slice(-MAX_INLINE_SYNC_DAYS);
}

function planHasDays(plan) {
  return Boolean(plan.guru?.length || plan.paddle?.length || plan.pagou?.length);
}

function countPlanDays(plan) {
  return new Set([...(plan.guru || []), ...(plan.paddle || []), ...(plan.pagou || [])]).size;
}

function snapshotAgeSeconds(snapshot) {
  const stamps = Object.values(snapshot || {})
    .map(entry => new Date(entry.synced_at).getTime())
    .filter(Number.isFinite);
  if (!stamps.length) return 0;
  return Math.max(0, Math.floor((Date.now() - Math.max(...stamps)) / 1000));
}

/**
 * Modo direto: usado enquanto a tabela de cache nao esta disponivel. Aqui o
 * comparativo e deliberadamente ignorado — buscar tambem o periodo anterior
 * dobraria o intervalo consultado na Guru (~50s a cada 30 dias) e derrubaria a
 * requisicao por tempo. Melhor entregar o periodo pedido sem os deltas.
 */
async function servedLive({ start, end, guruToken }) {
  const days = daysBetween(start, end, MAX_LIVE_DAYS + 1);
  if (days.length > MAX_LIVE_DAYS) {
    throw Object.assign(
      new Error(`Intervalo grande demais. Máximo: ${MAX_LIVE_DAYS} dias.`),
      { status: 400 }
    );
  }

  const startedAt = Date.now();
  const { rows, snapshot } = await collectRevenueDays(days, {
    guruToken,
    includeSnapshot: true
  });

  return {
    ...summarizeRange(start, end, rows, snapshot),
    previous: null,
    fetch_ms: Date.now() - startedAt,
    cache: { status: 'live', age_seconds: 0 }
  };
}
