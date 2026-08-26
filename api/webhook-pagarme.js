/**
 * Webhook Pagar.me da trilha. Quando o link pl_* é pago, emite o resgate na Ponto Hub.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { extractPagarmePaymentLinkId, pagarmeWebhookLooksPaid } from '../lib/pagarme.js';
import { fulfillPaidPaymentLink, reconcilePendingTrilhaCheckouts } from '../lib/trilha-fulfill.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method === 'GET' && !req.query?.id && !req.query?.payment_link_id) {
    return res.status(200).json({ ok: true, service: 'pagarme-trilha' });
  }
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const paymentLinkId = extractPagarmePaymentLinkId(payload, req.query || {});

  let result;
  if (paymentLinkId) {
    result = await fulfillPaidPaymentLink(paymentLinkId, { source: 'webhook', payload });
  } else if (pagarmeWebhookLooksPaid(payload)) {
    result = await reconcilePendingTrilhaCheckouts({ max: 20, payload });
  } else {
    return res.status(200).json({ received: true, processed: false, ignored: payload.type || null });
  }

  logAssinaturaEvent(req, {
    action: result.ok ? 'trilha_pontohub_ok' : 'trilha_pontohub_failed',
    provider: 'pagarme',
    account_id: null,
    details: { payment_link_id: paymentLinkId, type: payload.type || null, ...result }
  });
  return res.status(200).json({ received: true, payment_link_id: paymentLinkId, ...result });
}
