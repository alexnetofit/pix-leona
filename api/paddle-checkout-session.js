import { getPaddleBillingIntent } from '../lib/paddle-ledger.js';
import {
  PaddleSessionError,
  requirePaddleSession,
  timingSafeStringEqual,
  verifyPaddleCheckoutToken
} from '../lib/paddle-session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const session = requirePaddleSession(req);
    const token = String(req.query?.token || '');
    const checkout = verifyPaddleCheckoutToken(token);
    if (!timingSafeStringEqual(session.account_id, checkout.account_id)) {
      return res.status(403).json({ error: 'Checkout não pertence a esta conta' });
    }

    const intent = await getPaddleBillingIntent(checkout.intent_id);
    const matchesIntent = intent
      && timingSafeStringEqual(intent.leona_account_id, session.account_id)
      && timingSafeStringEqual(intent.paddle_customer_id, checkout.customer_id)
      && timingSafeStringEqual(intent.paddle_transaction_id, checkout.transaction_id);
    if (!matchesIntent || !['awaiting_payment', 'paid_pending_apply'].includes(intent.status)) {
      return res.status(409).json({ error: 'Checkout indisponível ou já encerrado' });
    }

    const clientToken = process.env.PADDLE_CLIENT_TOKEN;
    if (!clientToken) {
      return res.status(500).json({ error: 'PADDLE_CLIENT_TOKEN não configurado' });
    }
    return res.status(200).json({
      client_token: clientToken,
      environment: process.env.PADDLE_ENVIRONMENT || 'production',
      transaction_id: checkout.transaction_id,
      customer_id: checkout.customer_id,
      account_id: checkout.account_id,
      intent_id: checkout.intent_id,
      payment_method: intent.metadata?.payment_method || null,
      success_url: '/paddle?checkout=success'
    });
  } catch (error) {
    if (error instanceof PaddleSessionError) {
      return res.status(401).json({ error: error.message, code: error.code });
    }
    console.error('[paddle-checkout-session]', error);
    return res.status(500).json({ error: 'Falha ao preparar checkout' });
  }
}
