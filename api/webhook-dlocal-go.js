/**
 * POST /api/webhook-dlocal-go
 * Libera a Leona quando a dLocal Go confirma pagamento.
 * Cancela Guru e Paddle se existirem.
 *
 * Colar no painel dLocal Go: https://client.leonaflow.com/api/webhook-dlocal-go
 */
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { findLeonaAccountByEmail, getLeonaBillingProfile } from '../lib/leona.js';
import { dueDatePlusDays } from '../lib/leona-pricing.js';
import { isAffiliateReversal, notifyAffiliatesPagou } from '../lib/notify-affiliates.js';
import { sbConfigured, sbInsert, sbSelect, sbUpdate } from '../lib/supabase.js';
import { activateLeonaAndCancelLegacy } from '../lib/activate-after-payment.js';
import {
  dlocalPaymentFailed,
  dlocalPaymentPaid,
  extractDlocalPaymentId,
  getDlocalPayment,
  parseDlocalOrderId
} from '../lib/dlocal-go.js';

function pickEmail(payment = {}, payload = {}) {
  return (
    payment.payer?.email ||
    payment.client_email ||
    payload.payer?.email ||
    payload.email ||
    null
  );
}

function pickAmountCents(payment = {}) {
  const amount = Number(payment.amount ?? payment.local_amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

async function rememberEvent(eventId, accountId, action, details) {
  if (!eventId || !sbConfigured()) return false;
  try {
    await sbInsert('dlocal_processed_events', {
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
    console.error('webhook-dlocal-go: dedupe', err.message);
    return false;
  }
}

async function resolveIntent({ accountId, email, qty, paymentId, orderId }) {
  if (!sbConfigured()) return null;
  try {
    const rows = await sbSelect('dlocal_checkout_intents', {
      eq: { status: 'pending' },
      order: 'created_at.desc',
      limit: 60
    });
    return rows.find((row) => {
      if (paymentId && row.dlocal_payment_id && String(row.dlocal_payment_id) === String(paymentId)) return true;
      if (orderId && row.title && String(row.title) === String(orderId)) return true;
      if (accountId && row.account_id === String(accountId) && qty && Number(row.qty) === Number(qty)) return true;
      if (email && row.email && String(row.email).toLowerCase() === String(email).toLowerCase()) {
        if (qty && Number(row.qty) === Number(qty)) return true;
      }
      return false;
    }) || null;
  } catch (err) {
    console.error('webhook-dlocal-go: intent', err.message);
    return null;
  }
}

async function markIntentPaid(intent, paymentId) {
  if (!intent?.id || !sbConfigured()) return;
  try {
    await sbUpdate('dlocal_checkout_intents', { id: intent.id }, {
      status: 'paid',
      dlocal_payment_id: paymentId || intent.dlocal_payment_id || null,
      paid_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('webhook-dlocal-go: mark intent', err.message);
  }
}

async function markSubscriptionPaid({ accountId, email, qty, paymentId }) {
  if (!sbConfigured() || !accountId) return;
  try {
    const rows = await sbSelect('dlocal_subscriptions', {
      eq: { account_id: String(accountId), qty: Number(qty) },
      limit: 1
    });
    if (!rows[0]?.id) return;
    await sbUpdate('dlocal_subscriptions', { id: rows[0].id }, {
      status: 'active',
      email: email || rows[0].email || null,
      last_payment_id: paymentId || null,
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('webhook-dlocal-go: mark subscription', err.message);
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'dlocal-go',
      webhook: 'https://client.leonaflow.com/api/webhook-dlocal-go'
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) {
    console.error('webhook-dlocal-go: LEONA_BILLING_TOKEN ausente');
    return res.status(500).json({ error: 'Configuração incompleta' });
  }

  const payload = req.body || {};
  const paymentId = extractDlocalPaymentId(payload, req.query || {});
  console.log('webhook-dlocal-go: recebido', {
    payment_id: paymentId,
    keys: Object.keys(payload || {}),
    status: payload.status || null
  });

  logAssinaturaEvent(req, {
    action: 'dlocal_webhook',
    provider: 'dlocal',
    email: pickEmail({}, payload),
    account_id: null,
    details: { payment_id: paymentId, raw_status: payload.status || null, keys: Object.keys(payload || {}) }
  });

  if (!paymentId) {
    console.error('webhook-dlocal-go: sem payment_id', payload);
    return res.status(200).json({ received: true, processed: false, error: 'payment_id ausente' });
  }

  const fetched = await getDlocalPayment(paymentId);
  const payment = fetched.body || {};
  if (!fetched.ok || !payment.id) {
    console.error('webhook-dlocal-go: get payment falhou', paymentId, fetched.status, fetched.body);
    return res.status(200).json({ received: true, processed: false, error: 'pagamento não encontrado na dLocal' });
  }

  const email = pickEmail(payment, payload);
  const buyerName = payment.payer?.name || payment.client_first_name || null;
  const orderId = payment.order_id || payment.external_id || null;
  const status = String(payment.status || '').toUpperCase();
  let amountCents = pickAmountCents(payment);

  if (dlocalPaymentFailed(payment)) {
    const reversal = isAffiliateReversal('', status.toLowerCase());
    if (reversal) {
      await notifyAffiliatesPagou({
        txId: `dlocal:${paymentId}`,
        email,
        name: buyerName,
        amountCents,
        paidAt: payment.approved_date || payment.created_date || null,
        status: reversal
      });
    }
    logAssinaturaEvent(req, {
      action: 'dlocal_webhook_ignored',
      provider: 'dlocal',
      email,
      account_id: null,
      details: { payment_id: paymentId, status, order_id: orderId }
    });
    return res.status(200).json({ received: true, ignored: true, status });
  }

  if (!dlocalPaymentPaid(payment)) {
    console.log('webhook-dlocal-go: ainda nao pago', paymentId, status);
    return res.status(200).json({ received: true, ignored: true, status });
  }

  const ref = parseDlocalOrderId(orderId) || parseDlocalOrderId(payment.description);
  const intent = await resolveIntent({
    accountId: ref?.accountId,
    email,
    qty: ref?.qty,
    paymentId,
    orderId
  });

  let accountId = ref?.accountId || intent?.account_id || null;
  let qty = ref?.qty || intent?.qty || null;
  if (Number(intent?.amount_cents) > 0) amountCents = Number(intent.amount_cents);
  if (!accountId && email) {
    const found = await findLeonaAccountByEmail(email, leonaToken);
    if (found?.account_id) accountId = String(found.account_id);
  }

  if (!accountId || !qty) {
    console.error('webhook-dlocal-go: sem account/qty', { paymentId, email, orderId, ref, intent: intent?.id });
    logAssinaturaEvent(req, {
      action: 'dlocal_webhook_unresolved',
      provider: 'dlocal',
      email,
      account_id: accountId,
      details: { payment_id: paymentId, order_id: orderId, ref, intent_id: intent?.id || null }
    });
    return res.status(200).json({ received: true, processed: false, error: 'account_id/qty não resolvidos' });
  }

  const already = await rememberEvent(paymentId, accountId, status, { qty, orderId });
  if (already) {
    console.log('webhook-dlocal-go: duplicado', paymentId, accountId);
    return res.status(200).json({ received: true, duplicate: true, payment_id: paymentId });
  }

  const metaKind = String(intent?.details?.kind || ref?.kind || '').toLowerCase();
  const oneShot = metaKind === 'one_shot' || metaKind === 'prorata';
  const profile = await getLeonaBillingProfile(accountId, leonaToken);
  if (!profile) {
    console.error('webhook-dlocal-go: conta nao encontrada', accountId);
    return res.status(200).json({ received: true, processed: false, error: `conta ${accountId} não encontrada` });
  }

  const currentEnd = profile.current_period_end;
  const qtyChanged = Number(qty) !== Number(profile.starter_instances || 0);
  const keepCycle = oneShot
    && qtyChanged
    && currentEnd
    && new Date(currentEnd) > new Date();
  const dueDate = keepCycle
    ? String(currentEnd).slice(0, 10)
    : dueDatePlusDays(30);

  const activated = await activateLeonaAndCancelLegacy({
    accountId,
    qty,
    dueDate,
    email,
    reason: 'Migrada para dLocal Go após pagamento'
  });

  await markIntentPaid(intent, paymentId);
  if (!oneShot) {
    await markSubscriptionPaid({ accountId, email, qty, paymentId });
  }

  if (activated.ok && email) {
    await notifyAffiliatesPagou({
      txId: `dlocal:${paymentId}`,
      email,
      name: buyerName || activated.profile?.user?.name || null,
      amountCents,
      paidAt: payment.approved_date || payment.created_date || new Date().toISOString(),
      status: 'approved'
    });
  }

  logAssinaturaEvent(req, {
    action: activated.ok ? 'dlocal_webhook_paid' : 'dlocal_webhook_failed',
    provider: 'dlocal',
    email: email || activated.profile?.user?.email || null,
    account_id: accountId,
    details: {
      payment_id: paymentId,
      order_id: orderId,
      qty,
      amount_cents: amountCents,
      due_date: dueDate,
      kind: oneShot ? 'one_shot' : 'subscription',
      leona_ok: activated.ok,
      leona_error: activated.leona?.body?.error || activated.error || null,
      guru: activated.guru,
      paddle: activated.paddle
    }
  });

  console.log('webhook-dlocal-go: processado', {
    payment_id: paymentId,
    account_id: accountId,
    qty,
    due_date: dueDate,
    leona_ok: activated.ok,
    guru: activated.guru,
    paddle: activated.paddle
  });

  return res.status(200).json({
    received: true,
    processed: activated.ok,
    account_id: accountId,
    qty,
    due_date: dueDate,
    guru: activated.guru,
    paddle: activated.paddle
  });
}
