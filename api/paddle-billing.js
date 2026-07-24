import { applyCors } from '../lib/auth.js';
import { getLeonaBillingProfile } from '../lib/leona.js';
import {
  cancelPaddleSubscriptionAtPeriodEnd,
  executePaddleQuantityChange,
  getPaddleBillingOverview,
  PaddleBillingError,
  previewPaddleQuantityChange
} from '../lib/paddle-billing-service.js';
import { PaddleSessionError, requirePaddleSession } from '../lib/paddle-session.js';

function sendError(res, error) {
  console.error('[paddle-billing]', error);
  if (error instanceof PaddleSessionError) {
    return res.status(401).json({ error: error.message, code: error.code });
  }
  if (error instanceof PaddleBillingError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      details: error.details || undefined
    });
  }
  const status = Number(error?.status);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    error: status >= 400 && status < 500
      ? 'A Paddle recusou a operação'
      : 'Falha ao processar cobrança Paddle'
  });
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    const session = requirePaddleSession(req);
    const leonaToken = process.env.LEONA_BILLING_TOKEN;
    if (!leonaToken) {
      return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });
    }
    const profile = await getLeonaBillingProfile(session.account_id, leonaToken);
    if (!profile) {
      return res.status(404).json({ error: 'Conta Leona não encontrada' });
    }

    if (req.method === 'GET') {
      const overview = await getPaddleBillingOverview(session.account_id, profile);
      return res.status(200).json(overview);
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido' });
    }

    const action = String(req.body?.action || '');
    if (action === 'preview') {
      const result = await previewPaddleQuantityChange(
        session.account_id,
        profile,
        req.body?.target_quantity
      );
      return res.status(200).json(result);
    }
    if (action === 'change_quantity') {
      const result = await executePaddleQuantityChange({
        leonaAccountId: session.account_id,
        profile,
        targetQuantity: req.body?.target_quantity,
        paymentMethod: String(req.body?.payment_method || 'card')
      });
      return res.status(200).json(result);
    }
    if (action === 'cancel_at_period_end') {
      const result = await cancelPaddleSubscriptionAtPeriodEnd(
        session.account_id,
        profile
      );
      return res.status(200).json(result);
    }
    return res.status(400).json({ error: 'Ação inválida' });
  } catch (error) {
    return sendError(res, error);
  }
}
