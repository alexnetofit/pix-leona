/**
 * POST /api/webhook-pagou
 * Libera a conta Leona quando a Pagou confirma pagamento.
 *
 * Cadastrar no painel Pagou: https://client.leonaflow.com/api/webhook-pagou
 */
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { findLeonaAccountByEmail, getLeonaBillingProfile, updateLeonaBillingProfile } from '../lib/leona.js';
import { cancelGuruSubscription } from '../lib/guru.js';
import { dueDatePlusDays, parseLeonaRef } from '../lib/leona-pricing.js';
import { isAffiliateReversal, notifyAffiliatesPagou } from '../lib/notify-affiliates.js';
import { getPagouSubscription, getPagouTransaction } from '../lib/pagou.js';
import { sbConfigured, sbInsert, sbSelect, sbUpdate } from '../lib/supabase.js';

const PAID_EVENTS = new Set([
  'transaction.paid',
  'subscription.started',
  'subscription.renewed'
]);

const FAIL_EVENTS = new Set([
  'transaction.cancelled',
  'transaction.canceled',
  'transaction.refused',
  'transaction.refunded',
  'transaction.chargedback',
  'subscription.payment_failed',
  'subscription.past_due',
  'subscription.canceled',
  'subscription.chargeback_received'
]);

const PAID_STATUSES = new Set(['paid']);
const FAIL_STATUSES = new Set([
  'refused',
  'cancelled',
  'canceled',
  'failed',
  'chargedback',
  'chargeback',
  'refunded',
  'waiting_payment',
  'pending'
]);

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

function eventName(payload) {
  return String(
    payload?.data?.event_type ||
    payload?.event_type ||
    payload?.type ||
    payload?.event ||
    ''
  ).trim();
}

function extractRef(payload, extra = {}) {
  const meta = extra.metadata || payload?.data?.metadata || {};
  if (meta.account_id && meta.qty) {
    return { accountId: String(meta.account_id), qty: Number(meta.qty) };
  }
  const candidates = [
    extra.title,
    extra.external_ref,
    extra.externalRef,
    extra.correlation_id,
    extra.description,
    extra.comment,
    meta.leona_ref,
    pick(payload, 'data.correlation_id', 'data.external_ref', 'data.title', 'correlation_id', 'external_ref'),
    extra.products?.[0]?.external_id,
    extra.products?.[0]?.title,
    extra.products?.[0]?.name
  ];
  for (const c of candidates) {
    const parsed = parseLeonaRef(c);
    if (parsed) return parsed;
    const qtyOnly = String(c || '').match(/^leona-starter-(\d+)$/i);
    if (qtyOnly) return { accountId: null, qty: Number(qtyOnly[1]) };
    const planQty = String(c || '').match(/(\d+)\s*conex/i);
    if (planQty) return { accountId: null, qty: Number(planQty[1]) };
  }
  return null;
}

async function rememberEvent(eventId, accountId, action, details) {
  if (!eventId || !sbConfigured()) return false;
  try {
    await sbInsert('pagou_processed_events', {
      event_id: String(eventId),
      account_id: accountId || null,
      action,
      details: details || {}
    });
    return false;
  } catch (err) {
    if (String(err.message || '').includes('23505') || String(err.message || '').toLowerCase().includes('duplicate')) {
      return true;
    }
    console.error('webhook-pagou: dedupe', err.message);
    return false;
  }
}

async function resolveIntent({ accountId, email, qty, amountCents, checkoutUrl }) {
  if (!sbConfigured()) return null;
  try {
    const rows = await sbSelect('pagou_checkout_intents', {
      eq: { status: 'pending' },
      order: 'created_at.desc',
      limit: 40
    });
    return rows.find((row) => {
      if (checkoutUrl && row.checkout_url && String(row.checkout_url) === String(checkoutUrl)) return true;
      if (accountId && row.account_id === String(accountId)) return true;
      if (email && row.email && String(row.email).toLowerCase() === String(email).toLowerCase()) {
        if (qty && Number(row.qty) === Number(qty)) return true;
        if (amountCents && Number(row.amount_cents) === Number(amountCents)) return true;
        return true;
      }
      return false;
    }) || null;
  } catch (err) {
    console.error('webhook-pagou: intent', err.message);
    return null;
  }
}

async function markIntentPaid(intent, txId) {
  if (!intent?.id || !sbConfigured()) return;
  try {
    await sbUpdate('pagou_checkout_intents', { id: intent.id }, {
      status: 'paid',
      pagou_transaction_id: txId || null,
      paid_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('webhook-pagou: mark intent', err.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) {
    console.error('webhook-pagou: LEONA_BILLING_TOKEN ausente');
    return res.status(500).json({ error: 'Configuração incompleta' });
  }

  const payload = req.body || {};
  const name = eventName(payload);
  const eventId = payload.id || payload.requestId || `${name}:${payload?.data?.id || Date.now()}`;
  const family = String(payload.event || '').toLowerCase();
  const resourceId = payload?.data?.id || payload?.data?.object?.id || null;

  logAssinaturaEvent(req, {
    action: name || 'pagou_webhook',
    provider: 'pagou',
    email: payload?.data?.customer_email || payload?.data?.buyer?.email || null,
    account_id: null,
    details: { event_id: eventId, resource_id: resourceId, status: payload?.data?.status || null }
  });

  let extra = {};
  if (resourceId && (family === 'transaction' || name.startsWith('transaction'))) {
    const tx = await getPagouTransaction(resourceId);
    extra = tx.body?.data || tx.body || {};
  } else if (resourceId && (family === 'subscription' || name.startsWith('subscription'))) {
    const sub = await getPagouSubscription(resourceId);
    extra = sub.body?.data || sub.body || {};
  }

  const status = String(extra.status || payload?.data?.status || '').toLowerCase();
  const paidByStatus = PAID_STATUSES.has(status);
  const paidByEvent = PAID_EVENTS.has(name) && (paidByStatus || status === 'active');
  const email = extra.buyer?.email || extra.customer_email || extra.customer?.email || extra.customerEmail || payload?.data?.customer_email || null;
  const amountCents = extra.paid_amount || extra.paidAmount || extra.payment?.amount || extra.amount || extra.base_price || null;
  const buyerName = extra.buyer?.name || extra.customer?.name || extra.customer_name || null;
  const paidAt = extra.paid_at || extra.paidAt || extra.payment?.paid_at || null;

  if (FAIL_EVENTS.has(name) || FAIL_STATUSES.has(status)) {
    const reversal = isAffiliateReversal(name, status);
    if (reversal && resourceId) {
      await notifyAffiliatesPagou({
        txId: resourceId,
        email,
        name: buyerName,
        amountCents,
        paidAt,
        status: reversal
      });
    }
    return res.status(200).json({ received: true, ignored: true, event: name, status });
  }
  if (!paidByStatus && !paidByEvent) {
    return res.status(200).json({ received: true, ignored: true, event: name || 'unknown', status });
  }
  const ref = extractRef(payload, extra);
  const intent = await resolveIntent({
    accountId: ref?.accountId,
    email,
    qty: ref?.qty,
    amountCents,
    checkoutUrl: extra.attribution?.checkout_url || extra.checkout_url || null
  });

  let accountId = ref?.accountId || intent?.account_id || null;
  let qty = ref?.qty || intent?.qty || null;
  if (!accountId && email) {
    const found = await findLeonaAccountByEmail(email, leonaToken);
    if (found?.account_id) accountId = String(found.account_id);
  }
  if (!qty && Number(amountCents) > 0) {
    if (Number(amountCents) === 12700 || Number(amountCents) === 2446 || Number(amountCents) === 2447) qty = 1;
  }

  if (!accountId || !qty) {
    console.error('webhook-pagou: sem account/qty', { eventId, name, email, ref, intent: intent?.id });
    return res.status(200).json({ received: true, processed: false, error: 'account_id/qty não resolvidos' });
  }

  const already = await rememberEvent(eventId, accountId, name, { qty, resourceId });
  if (already) {
    if (resourceId && email) {
      await notifyAffiliatesPagou({
        txId: resourceId,
        email,
        name: buyerName,
        amountCents,
        paidAt,
        status: 'approved'
      });
    }
    return res.status(200).json({ received: true, duplicate: true });
  }

  const profile = await getLeonaBillingProfile(accountId, leonaToken);
  if (!profile) {
    return res.status(200).json({ received: true, processed: false, error: `conta ${accountId} não encontrada` });
  }

  const periodEnd = extra.current_period_end || extra.currentPeriodEnd;
  const metaKind = String(extra.metadata?.kind || intent?.details?.kind || '').toLowerCase();
  const qtyChanged = Number(qty) !== Number(profile.starter_instances || 0);
  const keepCycle = metaKind === 'one_shot'
    && qtyChanged
    && profile.current_period_end
    && new Date(profile.current_period_end) > new Date();
  const dueDate = periodEnd
    ? String(periodEnd).slice(0, 10)
    : keepCycle
      ? String(profile.current_period_end).slice(0, 10)
      : dueDatePlusDays(30);

  const update = await updateLeonaBillingProfile(accountId, {
    starter_instances: Number(qty),
    status: 'active',
    due_date: dueDate
  }, leonaToken);

  if (update.ok && profile.guru_account_id && process.env.GURU_TOKEN) {
    const cancel = await cancelGuruSubscription(profile.guru_account_id, process.env.GURU_TOKEN, {
      cancel_at_cycle_end: false,
      comment: 'Migrada para Pagou após pagamento na /assinatura'
    });
    console.log('webhook-pagou: cancel Guru', profile.guru_account_id, cancel.ok);
  }

  await markIntentPaid(intent, resourceId);

  if (update.ok && resourceId && email) {
    await notifyAffiliatesPagou({
      txId: resourceId,
      email,
      name: buyerName || profile.user?.name || null,
      amountCents,
      paidAt,
      status: 'approved'
    });
  }

  logAssinaturaEvent(req, {
    action: update.ok ? 'pagou_webhook_paid' : 'pagou_webhook_failed',
    provider: 'pagou',
    email: email || profile.user?.email || null,
    account_id: accountId,
    details: {
      event: name,
      qty,
      amount_cents: amountCents,
      due_date: dueDate,
      leona_ok: update.ok,
      leona_error: update.body?.error || update.error || null,
      resource_id: resourceId
    }
  });

  return res.status(200).json({
    received: true,
    processed: update.ok,
    account_id: accountId,
    qty,
    due_date: dueDate
  });
}
