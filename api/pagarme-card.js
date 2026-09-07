/**
 * GET  /api/pagarme-card — status do cartão Pagar.me (last4, pode trocar).
 * POST /api/pagarme-card — troca o cartão no customer e, se houver, na assinatura.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { assertAccountAccess } from '../lib/leona.js';
import {
  canShowPagarmeCardButton,
  guruHasActiveValidSub,
  loadPagarmeCardContext,
  parsePagarmeCardInput,
  sanitizePagarmeCardLog,
  updatePagarmeStoredCard
} from '../lib/pagarme-card.js';
import { pagarmeConfigured, pagarmePublicKey } from '../lib/pagarme.js';
import { findGuruSubscriptionsByEmail } from '../lib/guru.js';

async function loadGuruForEmail(email) {
  const token = process.env.GURU_TOKEN;
  if (!token || !email) return { found: false, subscriptions: [] };
  try {
    const subscriptions = await findGuruSubscriptionsByEmail(email, token, { onlyActive: true });
    return { found: subscriptions.length > 0, subscriptions };
  } catch (err) {
    console.error('pagarme-card: guru', err.message);
    return { found: false, subscriptions: [] };
  }
}

function isLeonaActive(profile, now = new Date()) {
  if (String(profile?.subscription_status || '') !== 'active') return false;
  if (profile?.current_period_end && new Date(profile.current_period_end) <= now) return false;
  return true;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });
  if (!pagarmeConfigured()) return res.status(500).json({ error: 'PAGARME_KEY não configurada' });

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const accountId = src.account_id != null ? String(src.account_id).trim() : '';
  const email = src.email;

  const access = await assertAccountAccess({
    accountId,
    queryEmail: email,
    leonaToken,
    route: '/api/pagarme-card'
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const profileEmail = access.profileEmail || String(email || '').trim().toLowerCase();
  const [guru, pagarme] = await Promise.all([
    loadGuruForEmail(profileEmail),
    loadPagarmeCardContext({ email: profileEmail })
  ]);
  const leonaActive = isLeonaActive(access.profile);
  const guruActiveValid = guruHasActiveValidSub(guru);
  const canChange = canShowPagarmeCardButton({
    leonaActive,
    guruActiveValid,
    pagarme: { ...pagarme, can_change_card: pagarme.can_change_card && !guruActiveValid }
  });

  if (req.method === 'GET') {
    return res.status(200).json({
      can_change_card: canChange,
      last4: pagarme.last4,
      brand: pagarme.brand,
      has_subscription: pagarme.has_subscription,
      public_key: pagarmePublicKey() || null
    });
  }

  if (!canChange) {
    logAssinaturaEvent(req, {
      action: 'pagarme_card_denied',
      provider: 'pagarme',
      email: profileEmail,
      account_id: accountId,
      details: sanitizePagarmeCardLog({
        leona_active: leonaActive,
        guru_active: guruActiveValid,
        pagarme_found: pagarme.found
      })
    });
    return res.status(409).json({ error: 'Troca de cartão disponível só para assinatura Pagar.me' });
  }

  const cardToken = src.card_token || src.token || null;
  const card = cardToken ? null : parsePagarmeCardInput(src);
  if (!cardToken && !card) {
    return res.status(400).json({ error: 'Preencha os dados do cartão' });
  }

  const updated = await updatePagarmeStoredCard({
    email: profileEmail,
    cardToken,
    card
  });

  if (!updated.ok) {
    logAssinaturaEvent(req, {
      action: 'pagarme_card_error',
      provider: 'pagarme',
      email: profileEmail,
      account_id: accountId,
      details: sanitizePagarmeCardLog({ error: updated.error, status: updated.status })
    });
    return res.status(updated.status || 502).json({ error: updated.error });
  }

  logAssinaturaEvent(req, {
    action: 'pagarme_card_updated',
    provider: 'pagarme',
    email: profileEmail,
    account_id: String(access.profile.account_id ?? accountId),
    details: sanitizePagarmeCardLog({
      last4: updated.last4,
      brand: updated.brand,
      has_subscription: updated.has_subscription,
      updated_subscriptions: updated.updated_subscriptions
    })
  });

  return res.status(200).json({
    success: true,
    last4: updated.last4,
    brand: updated.brand,
    has_subscription: updated.has_subscription
  });
}
