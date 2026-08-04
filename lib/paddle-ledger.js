/**
 * Persistencia server-only do ledger Paddle.
 *
 * Este modulo usa exclusivamente os helpers PostgREST autenticados com a
 * service_role. Nao deve ser importado por codigo executado no cliente.
 *
 * Todo acesso passa por `assertPaddleFirstEnabled`: enquanto
 * PADDLE_FIRST_ENABLED nao for "true" o ledger inteiro fica inerte, do mesmo
 * jeito que ficava quando o Supabase nao tinha credencial configurada. Isso
 * permite ligar o Supabase pra outras features (ex: cache de faturamento) sem
 * despertar a cobranca Paddle-first por acidente.
 */
import {
  sbInsert as sbInsertRaw,
  sbRpc as sbRpcRaw,
  sbSelect as sbSelectRaw,
  sbSelectWhere as sbSelectWhereRaw,
  sbUpdate as sbUpdateRaw,
  sbUpdateWhere as sbUpdateWhereRaw,
  sbUpsert as sbUpsertRaw
} from './supabase.js';

export function paddleFirstEnabled() {
  return String(process.env.PADDLE_FIRST_ENABLED || '').trim().toLowerCase() === 'true';
}

function assertPaddleFirstEnabled() {
  if (!paddleFirstEnabled()) {
    throw new Error('Ledger Paddle-first desligado (PADDLE_FIRST_ENABLED != true)');
  }
}

function gated(fn) {
  return (...args) => {
    assertPaddleFirstEnabled();
    return fn(...args);
  };
}

const sbInsert = gated(sbInsertRaw);
const sbRpc = gated(sbRpcRaw);
const sbSelect = gated(sbSelectRaw);
const sbSelectWhere = gated(sbSelectWhereRaw);
const sbUpdate = gated(sbUpdateRaw);
const sbUpdateWhere = gated(sbUpdateWhereRaw);
const sbUpsert = gated(sbUpsertRaw);

const TABLES = Object.freeze({
  accounts: 'paddle_billing_accounts',
  intents: 'paddle_billing_intents',
  events: 'paddle_webhook_events',
  outbox: 'paddle_leona_outbox',
  audit: 'paddle_billing_audit_log'
});

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new TypeError(`${name} e obrigatorio`);
  }
  return value;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} deve ser um objeto`);
  }
  return value;
}

function positiveLimit(value, fallback = 50, maximum = 200) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError('limit deve ser um inteiro positivo');
  }
  return Math.min(value, maximum);
}

function isConflict(error) {
  return error instanceof Error && /\(409\)/.test(error.message);
}

export async function upsertPaddleBillingAccount(account) {
  requireObject(account, 'account');
  requireValue(account.leona_account_id, 'account.leona_account_id');
  requireValue(account.canonical_email, 'account.canonical_email');
  const payload = { ...account };
  delete payload.entitlement_version;
  delete payload.created_at;
  delete payload.updated_at;
  return sbUpsert(TABLES.accounts, payload, { onConflict: 'leona_account_id' });
}

export async function getPaddleBillingAccount(leonaAccountId) {
  requireValue(leonaAccountId, 'leonaAccountId');
  const rows = await sbSelect(TABLES.accounts, {
    eq: { leona_account_id: leonaAccountId },
    limit: 1
  });
  return rows[0] || null;
}

export async function listPaddleBillingAccounts({
  states = ['active', 'past_due', 'paused', 'checkout_pending'],
  limit = 100
} = {}) {
  return sbSelectWhere(TABLES.accounts, {
    in: { state: states },
    order: 'updated_at.asc',
    limit: positiveLimit(limit, 100, 200)
  });
}

export async function createPaddleBillingIntent(intent) {
  requireObject(intent, 'intent');
  requireValue(intent.leona_account_id, 'intent.leona_account_id');
  requireValue(intent.kind, 'intent.kind');
  requireValue(intent.target_quantity, 'intent.target_quantity');
  requireValue(intent.request_fingerprint, 'intent.request_fingerprint');
  try {
    return await sbInsert(TABLES.intents, intent);
  } catch (error) {
    if (!isConflict(error)) throw error;
    const open = await getOpenPaddleBillingIntent(intent.leona_account_id);
    if (open?.request_fingerprint === intent.request_fingerprint) {
      return { ...open, _reused: true };
    }
    const conflict = new Error('Já existe outra operação Paddle aberta para esta conta');
    conflict.code = 'PADDLE_OPERATION_IN_PROGRESS';
    conflict.openIntent = open;
    throw conflict;
  }
}

export async function getOpenPaddleBillingIntent(leonaAccountId) {
  requireValue(leonaAccountId, 'leonaAccountId');
  const rows = await sbSelectWhere(TABLES.intents, {
    eq: { leona_account_id: leonaAccountId },
    in: { status: ['created', 'awaiting_payment', 'paid_pending_apply', 'applying'] },
    order: 'created_at.desc',
    limit: 1
  });
  return rows[0] || null;
}

export async function getPaddleBillingIntent(intentId) {
  requireValue(intentId, 'intentId');
  const rows = await sbSelect(TABLES.intents, {
    eq: { id: intentId },
    limit: 1
  });
  return rows[0] || null;
}

export async function getPaddleBillingIntentByTransaction(paddleTransactionId) {
  requireValue(paddleTransactionId, 'paddleTransactionId');
  const rows = await sbSelect(TABLES.intents, {
    eq: { paddle_transaction_id: paddleTransactionId },
    limit: 1
  });
  return rows[0] || null;
}

export async function listStalePaddleBillingIntents({
  updatedBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  limit = 100
} = {}) {
  return sbSelectWhere(TABLES.intents, {
    in: { status: ['created', 'awaiting_payment', 'paid_pending_apply', 'applying'] },
    lte: { updated_at: updatedBefore },
    order: 'updated_at.asc',
    limit: positiveLimit(limit, 100, 200)
  });
}

export async function updatePaddleBillingIntent(intentId, patch, expectedStatus) {
  requireValue(intentId, 'intentId');
  requireObject(patch, 'patch');

  if (expectedStatus !== undefined) {
    return sbUpdateWhere(
      TABLES.intents,
      { eq: { id: intentId, status: expectedStatus } },
      patch
    );
  }
  return sbUpdate(TABLES.intents, { id: intentId }, patch);
}

/**
 * Insere um webhook uma unica vez.
 * Em duplicata, retorna o evento ja persistido sem reaplicar o payload.
 */
export async function insertPaddleWebhookEvent(event) {
  requireObject(event, 'event');
  requireValue(event.event_id, 'event.event_id');
  requireValue(event.event_type, 'event.event_type');
  requireValue(event.occurred_at, 'event.occurred_at');
  requireObject(event.payload, 'event.payload');

  try {
    const row = await sbInsert(TABLES.events, event);
    return { inserted: true, duplicate: false, event: row };
  } catch (error) {
    if (!isConflict(error)) throw error;
    const existing = await getPaddleWebhookEvent(event.event_id);
    if (!existing) {
      throw new Error('Webhook Paddle conflitou, mas o evento persistido nao foi encontrado');
    }
    return { inserted: false, duplicate: true, event: existing };
  }
}

export async function getPaddleWebhookEvent(eventId) {
  requireValue(eventId, 'eventId');
  const rows = await sbSelect(TABLES.events, {
    eq: { event_id: eventId },
    limit: 1
  });
  return rows[0] || null;
}

export async function listPaddleWebhookEvents({
  statuses = ['pending', 'failed'],
  occurredBefore,
  limit = 50
} = {}) {
  const query = {
    in: { status: statuses },
    order: 'occurred_at.asc',
    limit: positiveLimit(limit)
  };
  if (occurredBefore) query.lte = { occurred_at: occurredBefore };
  return sbSelectWhere(TABLES.events, query);
}

/**
 * Claim otimista: somente um worker consegue trocar a mesma versao da row
 * para processing, pois status e attempts participam do filtro do PATCH.
 */
export async function claimPaddleWebhookEvents({ limit = 10, occurredBefore } = {}) {
  const claimLimit = positiveLimit(limit, 10, 100);
  const claimed = [];
  for (let index = 0; index < claimLimit; index += 1) {
    const rows = await sbRpc('paddle_claim_next_event');
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) break;
    if (occurredBefore && row.occurred_at > occurredBefore) {
      await updatePaddleWebhookEvent(row.event_id, { status: 'pending' }, 'processing');
      break;
    }
    claimed.push(row);
  }
  return claimed;
}

export async function updatePaddleWebhookEvent(eventId, patch, expectedStatus) {
  requireValue(eventId, 'eventId');
  requireObject(patch, 'patch');
  if (expectedStatus !== undefined) {
    return sbUpdateWhere(
      TABLES.events,
      { eq: { event_id: eventId, status: expectedStatus } },
      patch
    );
  }
  return sbUpdate(TABLES.events, { event_id: eventId }, patch);
}

/**
 * A constraint (source_event_id, leona_account_id) torna o enqueue idempotente
 * quando existe evento de origem.
 */
export async function enqueuePaddleLeonaOutbox(entry) {
  requireObject(entry, 'entry');
  requireValue(entry.leona_account_id, 'entry.leona_account_id');
  requireObject(entry.desired_payload, 'entry.desired_payload');

  const rows = await sbRpc('paddle_enqueue_leona', {
    p_leona_account_id: entry.leona_account_id,
    p_source_event_id: entry.source_event_id || null,
    p_desired_payload: entry.desired_payload
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { inserted: true, duplicate: false, entry: row };
}

export async function listPaddleLeonaOutbox({
  statuses = ['pending', 'failed'],
  dueBefore = new Date().toISOString(),
  limit = 50
} = {}) {
  return sbSelectWhere(TABLES.outbox, {
    in: { status: statuses },
    lte: { next_attempt_at: dueBefore },
    order: 'next_attempt_at.asc',
    limit: positiveLimit(limit)
  });
}

export async function claimPaddleLeonaOutbox({
  limit = 10,
  dueBefore = new Date().toISOString()
} = {}) {
  const claimLimit = positiveLimit(limit, 10, 100);
  const claimed = [];
  for (let index = 0; index < claimLimit; index += 1) {
    const rows = await sbRpc('paddle_claim_next_outbox');
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) break;
    if (row.next_attempt_at > dueBefore) {
      await updatePaddleLeonaOutbox(row.id, { status: 'pending' }, 'processing');
      break;
    }
    claimed.push(row);
  }
  return claimed;
}

export async function updatePaddleLeonaOutbox(entryId, patch, expectedStatus) {
  requireValue(entryId, 'entryId');
  requireObject(patch, 'patch');
  if (expectedStatus !== undefined) {
    return sbUpdateWhere(
      TABLES.outbox,
      { eq: { id: entryId, status: expectedStatus } },
      patch
    );
  }
  return sbUpdate(TABLES.outbox, { id: entryId }, patch);
}

export async function appendPaddleBillingAuditLog(entry) {
  requireObject(entry, 'entry');
  requireValue(entry.actor_type, 'entry.actor_type');
  requireValue(entry.action, 'entry.action');
  return sbInsert(TABLES.audit, entry);
}
