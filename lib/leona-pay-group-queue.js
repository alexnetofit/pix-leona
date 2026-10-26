/**
 * Fila dos grupos do Leona Pay.
 * O webhook só guarda a aprovação. Um cron manda um grupo por vez,
 * com 5 a 10 minutos entre um e outro, das 06:00 até 00:00 em Brasília.
 * Fora dessa janela a fila espera. Vários aceites de uma vez entram
 * em ordem e não saem juntos.
 *
 * As linhas ficam em assinatura_access_logs com provider próprio para
 * não depender de uma tabela nova, e o purge de 48h ignora esse provider.
 */
import { sbInsert, sbSelectWhere, sbUpdate, sbUpdateWhere } from './supabase.js';
import {
  assertOurWhatsappInstance,
  createLeonaPayGroup,
  leonaPayApi,
  leonaPhoneForEmail,
  parseApprovedBusiness
} from './leona-pay-group.js';

export const LEONA_PAY_QUEUE_PROVIDER = 'leona-pay-queue';
export const LEONA_PAY_QUEUE_ACTION = {
  pending: 'leona_pay_group_pending',
  processing: 'leona_pay_group_processing',
  done: 'leona_pay_group_done',
  failed: 'leona_pay_group_failed',
  state: 'leona_pay_group_state'
};

const OPEN_ACTIONS = [
  LEONA_PAY_QUEUE_ACTION.pending,
  LEONA_PAY_QUEUE_ACTION.processing,
  LEONA_PAY_QUEUE_ACTION.done
];
const DELAY_MIN_MS = 5 * 60 * 1000;
const DELAY_MAX_MS = 10 * 60 * 1000;
const STALE_LOCK_MS = 3 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export function brasiliaHour(date) {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(date).find((part) => part.type === 'hour')?.value;
  return Number(hour);
}

export function withinLeonaPaySendWindow(date) {
  const hour = brasiliaHour(date);
  return hour >= 6 && hour <= 23;
}

export function leonaPayDelayMs(random = Math.random) {
  const roll = Number(random());
  const unit = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999) : 0;
  return DELAY_MIN_MS + Math.floor(unit * (DELAY_MAX_MS - DELAY_MIN_MS + 1));
}

function queueDetails(row) {
  return row?.details && typeof row.details === 'object' ? row.details : {};
}

export function supabaseQueueDb() {
  return {
    async findOpen({ businessId, email }) {
      const eq = { provider: LEONA_PAY_QUEUE_PROVIDER };
      if (businessId) eq.account_id = businessId;
      else if (email) eq.email = email;
      else return null;
      const rows = await sbSelectWhere('assinatura_access_logs', {
        eq,
        in: { action: OPEN_ACTIONS },
        order: 'created_at.asc',
        limit: 1
      });
      return rows[0] || null;
    },
    async insert({ email, businessId, payload }) {
      return sbInsert('assinatura_access_logs', {
        action: LEONA_PAY_QUEUE_ACTION.pending,
        provider: LEONA_PAY_QUEUE_PROVIDER,
        email: email || null,
        account_id: businessId || null,
        details: {
          status: 'pending',
          payload,
          attempts: 0,
          lockedAt: null,
          finishedAt: null,
          groupJid: null,
          result: null,
          lastError: null
        }
      });
    },
    async getState() {
      const rows = await sbSelectWhere('assinatura_access_logs', {
        eq: { provider: LEONA_PAY_QUEUE_PROVIDER, action: LEONA_PAY_QUEUE_ACTION.state },
        order: 'created_at.desc',
        limit: 1
      });
      return rows[0] || null;
    },
    async setNextEligible(date) {
      const state = await this.getState();
      const details = {
        ...queueDetails(state),
        nextEligibleAt: date.toISOString()
      };
      if (state?.id) {
        await sbUpdate('assinatura_access_logs', { id: state.id }, { details });
        return;
      }
      await sbInsert('assinatura_access_logs', {
        action: LEONA_PAY_QUEUE_ACTION.state,
        provider: LEONA_PAY_QUEUE_PROVIDER,
        email: null,
        account_id: 'state',
        details
      });
    },
    async releaseStale(cutoff) {
      const rows = await sbSelectWhere('assinatura_access_logs', {
        eq: { provider: LEONA_PAY_QUEUE_PROVIDER, action: LEONA_PAY_QUEUE_ACTION.processing },
        order: 'created_at.asc',
        limit: 5
      });
      for (const row of rows) {
        const lockedAt = Date.parse(queueDetails(row).lockedAt || '');
        if (Number.isFinite(lockedAt) && lockedAt > cutoff.getTime()) continue;
        await sbUpdateWhere('assinatura_access_logs', {
          eq: { id: row.id, action: LEONA_PAY_QUEUE_ACTION.processing }
        }, {
          action: LEONA_PAY_QUEUE_ACTION.pending,
          details: { ...queueDetails(row), status: 'pending', lockedAt: null }
        });
      }
    },
    async claimNext(now) {
      const rows = await sbSelectWhere('assinatura_access_logs', {
        eq: { provider: LEONA_PAY_QUEUE_PROVIDER, action: LEONA_PAY_QUEUE_ACTION.pending },
        order: 'created_at.asc',
        limit: 1
      });
      const row = rows[0];
      if (!row) return null;
      const attempts = Number(queueDetails(row).attempts || 0) + 1;
      const claimed = await sbUpdateWhere('assinatura_access_logs', {
        eq: { id: row.id, action: LEONA_PAY_QUEUE_ACTION.pending }
      }, {
        action: LEONA_PAY_QUEUE_ACTION.processing,
        details: {
          ...queueDetails(row),
          status: 'processing',
          attempts,
          lockedAt: now.toISOString()
        }
      });
      return claimed?.id ? claimed : null;
    },
    async finish(row, { status, result, error, now }) {
      const action = LEONA_PAY_QUEUE_ACTION[status] || LEONA_PAY_QUEUE_ACTION.failed;
      await sbUpdate('assinatura_access_logs', { id: row.id }, {
        action,
        details: {
          ...queueDetails(row),
          status,
          finishedAt: status === 'pending' ? null : now.toISOString(),
          groupJid: result?.groupJid || queueDetails(row).groupJid || null,
          result: result || null,
          lastError: error ? String(error).slice(0, 500) : null
        }
      });
    }
  };
}

export async function enqueueLeonaPayGroup(body, { db = supabaseQueueDb() } = {}) {
  const parsed = parseApprovedBusiness(body);
  if (!parsed.ok) return parsed;
  const existing = await db.findOpen({
    businessId: parsed.businessId,
    email: parsed.email
  });
  if (existing?.id) {
    return { ok: true, queued: true, already: true, id: existing.id };
  }
  const row = await db.insert({
    email: parsed.email,
    businessId: parsed.businessId,
    payload: body
  });
  return { ok: true, queued: true, already: false, id: row?.id || null };
}

export async function runLeonaPayGroupQueue({
  now = new Date(),
  random = Math.random,
  env = process.env,
  client = null,
  create = createLeonaPayGroup,
  lookupPhone = leonaPhoneForEmail,
  db = supabaseQueueDb(),
  maxAttempts = MAX_ATTEMPTS
} = {}) {
  if (!withinLeonaPaySendWindow(now)) {
    return { ok: true, action: 'wait', reason: 'fora do horário' };
  }

  const state = await db.getState();
  const nextEligibleAt = queueDetails(state).nextEligibleAt || null;
  if (nextEligibleAt && Date.parse(nextEligibleAt) > now.getTime()) {
    return { ok: true, action: 'wait', reason: 'intervalo', nextEligibleAt };
  }

  const api = client || leonaPayApi(env);
  const instance = await assertOurWhatsappInstance(api);
  if (!instance.ok) {
    return { ok: false, action: 'wait', reason: instance.reason };
  }

  await db.releaseStale(new Date(now.getTime() - STALE_LOCK_MS));
  const row = await db.claimNext(now);
  if (!row) return { ok: true, action: 'idle' };

  const details = queueDetails(row);
  const attempts = Number(details.attempts || 0);
  let result = null;
  try {
    const parsed = parseApprovedBusiness(details.payload);
    let phone = null;
    if (parsed.ok && !parsed.phone && parsed.email) {
      try {
        phone = await lookupPhone(parsed.email);
      } catch {
        phone = null;
      }
    }
    result = await create(details.payload, { env, client: api, phone, skipInstanceCheck: true });
  } catch (error) {
    result = { ok: false, reason: error?.message || 'falha ao criar o grupo' };
  }

  const sent = Boolean(result?.ok && result.groupJid);
  const terminal = !sent && attempts >= maxAttempts;
  const status = sent ? 'done' : (terminal ? 'failed' : 'pending');
  const next = new Date(now.getTime() + leonaPayDelayMs(random));
  await db.finish(row, {
    status,
    result,
    error: sent ? null : (result?.reason || 'falha ao criar o grupo'),
    now
  });
  await db.setNextEligible(next);

  return {
    ok: sent,
    action: sent ? 'sent' : status,
    id: row.id,
    groupJid: result?.groupJid || null,
    reason: sent ? null : (result?.reason || null),
    nextEligibleAt: next.toISOString()
  };
}
