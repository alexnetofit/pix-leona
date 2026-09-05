/**
 * POST /api/paddle-update-card
 * Gera o link do portal Paddle pra trocar o cartão — sem cobrança.
 * Usado pela /assinatura (e-mail + account_id, mesmo anti-IDOR do checkout).
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { assertAccountAccess, findLeonaAccountByEmail } from '../lib/leona.js';
import {
  createCustomerPortalSession,
  findManagedPaddleSubscription,
  pickUpdatePaymentMethodUrl
} from '../lib/paddle-client.js';

function ensurePaddleEnv() {
  if (!process.env.PADDLE_ENVIRONMENT) process.env.PADDLE_ENVIRONMENT = 'production';
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  res.setHeader('Cache-Control', 'no-store');

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'Configuração incompleta' });
  if (!process.env.PADDLE_API_KEY) {
    return res.status(503).json({ error: 'Troca de cartão Paddle indisponível. Fale com o suporte.' });
  }

  const { email, account_id } = req.body || {};
  const accountIdRaw = account_id != null ? String(account_id).trim() : '';
  const queryEmail = email ? String(email).trim().toLowerCase() : '';

  let profile = null;
  let profileEmail = queryEmail;
  let accountId = accountIdRaw;

  if (accountIdRaw) {
    const access = await assertAccountAccess({
      accountId: accountIdRaw,
      queryEmail,
      leonaToken,
      route: '/api/paddle-update-card'
    });
    if (!access.ok) return res.status(access.status).json(access.body);
    profile = access.profile;
    profileEmail = access.profileEmail || queryEmail;
    accountId = String(access.profile?.account_id || accountIdRaw);
  } else if (queryEmail) {
    const found = await findLeonaAccountByEmail(queryEmail, leonaToken);
    if (!found?.profile) {
      return res.status(404).json({ error: 'Conta Leona não encontrada' });
    }
    profile = found.profile;
    profileEmail = String(found.profile?.user?.email || queryEmail).trim().toLowerCase();
    accountId = String(found.account_id || found.profile.account_id || '');
  } else {
    return res.status(400).json({ error: 'Informe um e-mail ou account_id' });
  }

  try {
    ensurePaddleEnv();
    const managed = await findManagedPaddleSubscription({
      email: profileEmail,
      accountIds: accountId ? [accountId] : []
    });
    if (!managed) {
      return res.status(404).json({ error: 'Nenhuma assinatura Paddle ativa nesta conta' });
    }

    const portal = await createCustomerPortalSession(managed.customer_id, {
      subscriptionIds: [managed.subscription_id]
    });
    const url = pickUpdatePaymentMethodUrl(portal, managed.subscription_id);
    if (!url) {
      return res.status(502).json({ error: 'Paddle não gerou o link de troca de cartão' });
    }

    logAssinaturaEvent(req, {
      action: 'click_update_card',
      provider: 'paddle',
      email: profileEmail,
      account_id: accountId || profile?.account_id || null,
      details: { subscription_id: managed.subscription_id }
    });

    return res.status(200).json({
      update_payment_method: url,
      subscription_id: managed.subscription_id
    });
  } catch (error) {
    console.error('paddle-update-card', error);
    return res.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({
      error: error.message || 'Falha ao abrir a troca de cartão'
    });
  }
}
