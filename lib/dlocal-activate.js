/**
 * Libera a Leona a partir de um pagamento PAID da dLocal Go.
 * Usado pelo webhook oficial da dLocal Go (POST { payment_id }).
 */
import { logAssinaturaEvent } from './assinatura-log.js';
import { resolveLeonaAccount } from './leona.js';
import { dueDatePlusDays } from './leona-pricing.js';
import { isAffiliateReversal, notifyAffiliatesPagou } from './notify-affiliates.js';
import { sbConfigured, sbDeleteWhere, sbInsert, sbSelect, sbSelectWhere, sbUpdate } from './supabase.js';
import { activateLeonaAndCancelLegacy } from './activate-after-payment.js';
import {
  dlocalPaymentFailed,
  dlocalPaymentPaid,
  parseDlocalOrderId,
  qtyFromDlocalPlanName
} from './dlocal-go.js';

export function pickDlocalEmail(payment = {}, payload = {}) {
  return (
    payment.payer?.email ||
    payment.client_email ||
    payload.payer?.email ||
    payload.client_email ||
    payload.email ||
    payload.subscription?.client_email ||
    null
  );
}

export function pickDlocalAmountCents(payment = {}) {
  const amount = Number(payment.amount ?? payment.local_amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

function laterDate(left, right) {
  const a = left ? String(left).slice(0, 10) : '';
  const b = right ? String(right).slice(0, 10) : '';
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
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
    console.error('dlocal-activate: dedupe', err.message);
    return false;
  }
}

async function forgetEvent(eventId) {
  if (!eventId || !sbConfigured()) return;
  try {
    await sbDeleteWhere('dlocal_processed_events', { event_id: String(eventId) });
  } catch (err) {
    console.error('dlocal-activate: forget', err.message);
  }
}

export async function resolveDlocalIntent({ accountId, email, qty, paymentId, orderId }) {
  if (!sbConfigured()) return null;
  try {
    if (paymentId) {
      const byPayment = await sbSelect('dlocal_checkout_intents', {
        eq: { dlocal_payment_id: String(paymentId) },
        order: 'created_at.desc',
        limit: 5
      });
      if (byPayment[0]) return byPayment[0];
    }

    const pending = email
      ? await sbSelectWhere('dlocal_checkout_intents', {
          eq: { status: 'pending' },
          ilike: { email: String(email).trim() },
          order: 'created_at.desc',
          limit: 20
        })
      : await sbSelect('dlocal_checkout_intents', {
          eq: { status: 'pending' },
          order: 'created_at.desc',
          limit: 80
        });

    return pending.find((row) => {
      if (orderId && row.title && String(row.title) === String(orderId)) return true;
      if (accountId && row.account_id === String(accountId) && qty && Number(row.qty) === Number(qty)) return true;
      if (email && row.email && String(row.email).toLowerCase() === String(email).toLowerCase()) {
        if (!qty || Number(row.qty) === Number(qty)) return true;
      }
      return false;
    }) || null;
  } catch (err) {
    console.error('dlocal-activate: intent', err.message);
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
    console.error('dlocal-activate: mark intent', err.message);
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
    console.error('dlocal-activate: mark subscription', err.message);
  }
}

/**
 * @param {object} payment pagamento já buscado na API da dLocal
 * @param {object} [opts]
 * @param {object} [opts.payload] body cru do webhook
 * @param {object} [opts.req]
 * @param {string} [opts.source]
 */
export async function processDlocalPaidPayment(payment, {
  payload = {},
  req = null,
  source = 'webhook'
} = {}) {
  const paymentId = payment?.id || null;
  const email = pickDlocalEmail(payment, payload);
  const buyerName = payment.payer?.name
    || [payment.payer?.first_name, payment.payer?.last_name].filter(Boolean).join(' ')
    || payment.client_first_name
    || null;
  const orderId = payment.order_id || payment.external_id || null;
  const status = String(payment.status || '').toUpperCase();
  let amountCents = pickDlocalAmountCents(payment);

  if (!paymentId) {
    return { processed: false, error: 'payment_id ausente' };
  }

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
      details: { payment_id: paymentId, status, order_id: orderId, source }
    });
    return { processed: false, ignored: true, status };
  }

  if (!dlocalPaymentPaid(payment)) {
    return { processed: false, ignored: true, status };
  }

  const ref = parseDlocalOrderId(orderId) || parseDlocalOrderId(payment.description);
  const intent = await resolveDlocalIntent({
    accountId: ref?.accountId,
    email,
    qty: ref?.qty,
    paymentId,
    orderId
  });

  let accountId = ref?.accountId || intent?.account_id || null;
  let qty = ref?.qty || intent?.qty || qtyFromDlocalPlanName(payment.description) || null;
  if (Number(intent?.amount_cents) > 0) amountCents = Number(intent.amount_cents);

  const resolved = await resolveLeonaAccount({
    accountId,
    email,
    leonaToken: process.env.LEONA_BILLING_TOKEN
  });
  if (resolved?.account_id) accountId = resolved.account_id;
  const profile = resolved?.profile || null;

  if (!accountId || !qty || !profile) {
    console.error('dlocal-activate: sem account/qty', {
      paymentId,
      email,
      orderId,
      ref,
      intent: intent?.id,
      match: resolved?.source || null
    });
    logAssinaturaEvent(req, {
      action: 'dlocal_webhook_unresolved',
      provider: 'dlocal',
      email,
      account_id: accountId,
      details: {
        payment_id: paymentId,
        order_id: orderId,
        ref,
        intent_id: intent?.id || null,
        source,
        match: resolved?.source || null
      }
    });
    return { processed: false, error: 'account_id/qty não resolvidos', payment_id: paymentId, email };
  }

  const already = await rememberEvent(paymentId, accountId, status, { qty, orderId, source });
  if (already) {
    return { processed: false, duplicate: true, payment_id: paymentId, account_id: accountId, qty };
  }

  const metaKind = String(intent?.details?.kind || ref?.kind || '').toLowerCase();
  const oneShot = metaKind === 'one_shot' || metaKind === 'prorata';

  const currentEnd = profile.current_period_end;
  const qtyChanged = Number(qty) !== Number(profile.starter_instances || 0);
  const keepCycle = oneShot
    && qtyChanged
    && currentEnd
    && new Date(currentEnd) > new Date();
  let dueDate = keepCycle
    ? String(currentEnd).slice(0, 10)
    : dueDatePlusDays(30);
  if (!oneShot) {
    dueDate = laterDate(dueDate, currentEnd) || dueDate;
  }

  const activated = await activateLeonaAndCancelLegacy({
    accountId,
    qty,
    dueDate,
    email,
    reason: keepCycle
      ? 'Upgrade pró-rata via dLocal Go (ciclo mantido)'
      : 'Migrada para dLocal Go após pagamento',
    profile,
    keepCycle
  });

  if (!activated.ok) {
    await forgetEvent(paymentId);
  } else {
    await markIntentPaid(intent, paymentId);
    if (!oneShot) {
      await markSubscriptionPaid({ accountId, email, qty, paymentId });
    }
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
      source,
      match: resolved?.source || null,
      leona_ok: activated.ok,
      leona_error: activated.leona?.body?.error || activated.error || null,
      guru: activated.guru,
      paddle: activated.paddle
    }
  });

  console.log('dlocal-activate: processado', {
    payment_id: paymentId,
    account_id: accountId,
    qty,
    due_date: dueDate,
    source,
    leona_ok: activated.ok
  });

  return {
    processed: activated.ok,
    payment_id: paymentId,
    account_id: accountId,
    qty,
    due_date: dueDate,
    guru: activated.guru,
    paddle: activated.paddle,
    error: activated.ok ? null : (activated.leona?.body?.error || activated.error || 'falha ao atualizar Leona')
  };
}
