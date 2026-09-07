/**
 * POST /api/pagarme-downgrade — reduz item da assinatura recorrente Pagar.me.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { assertAccountAccess, updateLeonaBillingProfile } from '../lib/leona.js';
import { applyPagarmeSubscriptionDowngrade, resolvePagarmeDowngrade } from '../lib/pagarme-downgrade.js';
import { listPagarmeSubscriptionsByCustomer, findPagarmeCustomerByEmail, pagarmeConfigured } from '../lib/pagarme.js';
import { guruHasActiveValidSub, loadPagarmeCardContext } from '../lib/pagarme-card.js';
import { findGuruSubscriptionsByEmail } from '../lib/guru.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });
  if (!pagarmeConfigured()) return res.status(500).json({ error: 'PAGARME_KEY não configurada' });

  const { account_id, email, qty } = req.body || {};
  const newQty = Number(qty);
  const access = await assertAccountAccess({
    accountId: account_id,
    queryEmail: email,
    leonaToken,
    route: '/api/pagarme-downgrade'
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const currentQty = Number(access.profile?.starter_instances) || 0;
  const decided = resolvePagarmeDowngrade({
    hasSubscription: true,
    currentQty,
    newQty
  });
  if (!decided.ok) return res.status(400).json({ error: decided.error });

  const profileEmail = access.profileEmail || String(email || '').trim().toLowerCase();
  let guruActiveValid = false;
  try {
    const token = process.env.GURU_TOKEN;
    if (token && profileEmail) {
      const subscriptions = await findGuruSubscriptionsByEmail(profileEmail, token, { onlyActive: true });
      guruActiveValid = guruHasActiveValidSub({ found: subscriptions.length > 0, subscriptions });
    }
  } catch (err) {
    console.error('pagarme-downgrade: guru', err.message);
  }
  if (guruActiveValid) {
    return res.status(409).json({ error: 'Esta conta ainda tem assinatura Guru vigente' });
  }

  const pagarme = await loadPagarmeCardContext({ email: profileEmail });
  if (!pagarme.has_subscription) {
    return res.status(409).json({
      error: 'Não há assinatura recorrente na Pagar.me. No PIX o downgrade vale na próxima renovação.',
      code: 'NO_SUBSCRIPTION'
    });
  }

  const customer = await findPagarmeCustomerByEmail(profileEmail);
  const subscriptions = customer?.id ? await listPagarmeSubscriptionsByCustomer(customer.id) : [];
  const applied = await applyPagarmeSubscriptionDowngrade({ subscriptions, qty: newQty });
  if (!applied.ok) {
    return res.status(applied.status || 502).json({ error: applied.error, code: applied.code || null });
  }

  const accountId = String(access.profile?.account_id || account_id);
  const leona = await updateLeonaBillingProfile(
    accountId,
    { starter_instances: newQty },
    leonaToken
  );

  logAssinaturaEvent(req, {
    action: 'pagarme_downgrade',
    provider: 'pagarme',
    email: profileEmail,
    account_id: accountId,
    details: {
      from: currentQty,
      to: newQty,
      subscription_id: applied.subscription_id,
      item_id: applied.item_id,
      amount_cents: applied.amount_cents,
      leona_ok: leona.ok
    }
  });

  return res.status(200).json({
    ok: true,
    qty: newQty,
    amount_cents: applied.amount_cents,
    subscription_id: applied.subscription_id,
    leona_sync: {
      ok: leona.ok,
      starter_instances: newQty,
      error: leona.ok ? null : (leona.body?.error || leona.error || null)
    }
  });
}
