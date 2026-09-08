import { resolveLeonaAccount, updateLeonaBillingProfile } from './leona.js';
import { cancelGuruSubscription, findGuruActiveSubscriptionsByEmail } from './guru.js';
import {
  cancelSubscription as cancelPaddleSubscription,
  listCustomersByEmail,
  listSubscriptionsByCustomer
} from './paddle-client.js';

const PADDLE_CANCELABLE = new Set(['active', 'past_due', 'trialing', 'paused']);

/** Pró-rata no ciclo aberto só ajusta qty. A assinatura recorrente continua. */
export function shouldCancelLegacyAfterPayment({ keepCycle } = {}) {
  return keepCycle !== true;
}

export async function activateLeonaAndCancelLegacy({
  accountId,
  qty,
  dueDate,
  email,
  reason = 'Pago via dLocal Go',
  profile: givenProfile = null,
  keepCycle = false
}) {
  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  const guruToken = process.env.GURU_TOKEN;
  const log = [];

  let resolvedId = accountId != null ? String(accountId).trim() : '';
  let profile = givenProfile || null;
  if (!profile) {
    const resolved = await resolveLeonaAccount({
      accountId: resolvedId,
      email,
      leonaToken
    });
    profile = resolved?.profile || null;
    if (resolved?.account_id) resolvedId = resolved.account_id;
  }
  if (!profile) {
    console.error('activate-after-payment: conta nao encontrada', resolvedId || email);
    return {
      ok: false,
      error: `conta ${resolvedId || email || '?'} nao encontrada`,
      profile: null,
      leona: null,
      guru: null,
      paddle: null
    };
  }

  const leona = await updateLeonaBillingProfile(resolvedId, {
    starter_instances: Number(qty),
    status: 'active',
    due_date: dueDate
  }, leonaToken);
  const applied = leona.body || {};
  const appliedOk = Boolean(leona.ok)
    && String(applied.subscription_status || applied.status || '') === 'active'
    && Number(applied.starter_instances) === Number(qty);
  console.log('activate-after-payment: leona', resolvedId, qty, dueDate, leona.ok, leona.status, appliedOk);
  log.push({
    step: 'leona',
    ok: appliedOk,
    status: leona.status,
    error: appliedOk ? null : (leona.body?.error || leona.error || 'Leona nao ficou active com a qty paga')
  });

  const profileEmail = String(email || profile.user?.email || '').trim().toLowerCase();
  const cancelLegacy = shouldCancelLegacyAfterPayment({ keepCycle });
  const guru = cancelLegacy
    ? await cancelLegacyGuru({
        guruToken,
        profile,
        email: profileEmail,
        reason
      })
    : { skipped: true, reason: 'keep_cycle_one_shot' };
  const paddle = cancelLegacy
    ? await cancelLegacyPaddle({
        email: profileEmail,
        reason
      })
    : { skipped: true, reason: 'keep_cycle_one_shot' };

  return {
    ok: appliedOk,
    profile,
    leona,
    guru,
    paddle,
    log
  };
}

async function cancelLegacyGuru({ guruToken, profile, email, reason }) {
  if (!guruToken) {
    console.log('activate-after-payment: guru skipped, sem GURU_TOKEN');
    return { skipped: true, reason: 'GURU_TOKEN ausente' };
  }

  const ids = new Set();
  if (profile.guru_account_id) ids.add(String(profile.guru_account_id));
  if (email) {
    try {
      const subs = await findGuruActiveSubscriptionsByEmail(email, guruToken);
      for (const sub of subs || []) {
        if (sub?.id) ids.add(String(sub.id));
      }
    } catch (err) {
      console.error('activate-after-payment: busca guru', err.message);
    }
  }
  if (ids.size === 0) {
    console.log('activate-after-payment: guru sem sub ativa', email || profile.account_id);
    return { skipped: true, reason: 'sem subs Guru ativas' };
  }

  const results = [];
  for (const id of ids) {
    const cancel = await cancelGuruSubscription(id, guruToken, {
      cancel_at_cycle_end: false,
      comment: reason
    });
    console.log('activate-after-payment: cancel guru', id, cancel.ok, cancel.status);
    results.push({
      id,
      ok: cancel.ok,
      status: cancel.status || null,
      error: cancel.ok ? null : (cancel.body?.message || cancel.error || null)
    });
  }
  return { attempted: results.length, results };
}

async function cancelLegacyPaddle({ email, reason }) {
  if (!process.env.PADDLE_API_KEY) {
    console.log('activate-after-payment: paddle skipped, sem credencial');
    return { skipped: true, reason: 'Paddle nao configurada' };
  }
  if (!email) {
    return { skipped: true, reason: 'sem email pra achar Paddle' };
  }

  try {
    const customers = await listCustomersByEmail(email);
    if (!customers.length) {
      console.log('activate-after-payment: paddle sem customer', email);
      return { skipped: true, reason: 'sem customer Paddle' };
    }
    const results = [];
    for (const customer of customers) {
      const subs = await listSubscriptionsByCustomer(customer.id);
      for (const sub of subs) {
        const status = String(sub.status || '').toLowerCase();
        if (!PADDLE_CANCELABLE.has(status)) continue;
        try {
          await cancelPaddleSubscription(sub.id, 'immediately');
          console.log('activate-after-payment: cancel paddle', sub.id, status, reason);
          results.push({ id: sub.id, ok: true, status });
        } catch (err) {
          console.error('activate-after-payment: cancel paddle falhou', sub.id, err.message);
          results.push({ id: sub.id, ok: false, status, error: err.message });
        }
      }
    }
    if (!results.length) {
      return { skipped: true, reason: 'sem subs Paddle ativas' };
    }
    return { attempted: results.length, results };
  } catch (err) {
    console.error('activate-after-payment: paddle', err.message);
    return { skipped: true, error: err.message };
  }
}
