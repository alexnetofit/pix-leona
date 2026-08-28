/**
 * Webhook Pagar.me: trilha (Ponto Hub) ou assinatura Leona.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import {
  extractPagarmeCycleId,
  extractPagarmeOrderId,
  extractPagarmePaymentLinkId,
  extractPagarmeSubscriptionId,
  pagarmeInvoicePaid,
  pagarmeWebhookLooksPaid
} from '../lib/pagarme.js';
import {
  findPagarmeAssinaturaIntent,
  processPagarmeAssinaturaPaid,
  processPagarmeSubscriptionInvoicePaid,
  reconcilePendingPagarmeAssinatura
} from '../lib/pagarme-assinatura.js';
import {
  findTrilhaCheckoutByPaymentLink,
  fulfillPaidPaymentLink,
  reconcilePendingTrilhaCheckouts
} from '../lib/trilha-fulfill.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method === 'GET' && !req.query?.id && !req.query?.payment_link_id) {
    return res.status(200).json({ ok: true, service: 'pagarme' });
  }
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const paymentLinkId = extractPagarmePaymentLinkId(payload, req.query || {});
  const orderId = extractPagarmeOrderId(payload, req.query || {});
  const subscriptionId = extractPagarmeSubscriptionId(payload, req.query || {});
  const invoicePaid = pagarmeInvoicePaid(payload);

  let result;
  if (invoicePaid && subscriptionId && await findPagarmeAssinaturaIntent(subscriptionId)) {
    result = {
      kind: 'assinatura',
      ...(await processPagarmeSubscriptionInvoicePaid({
        subscriptionId,
        cycleId: extractPagarmeCycleId(payload),
        req,
        source: 'webhook'
      }))
    };
  } else if (paymentLinkId) {
    const trilha = await findTrilhaCheckoutByPaymentLink(paymentLinkId);
    if (trilha) {
      result = { kind: 'trilha', ...(await fulfillPaidPaymentLink(paymentLinkId, { source: 'webhook', payload })) };
    } else if (await findPagarmeAssinaturaIntent(paymentLinkId)) {
      result = { kind: 'assinatura', ...(await processPagarmeAssinaturaPaid(paymentLinkId, { payload, req, source: 'webhook' })) };
    } else {
      result = { kind: null, processed: false, error: 'checkout não encontrado' };
    }
  } else if (orderId && await findPagarmeAssinaturaIntent(orderId)) {
    result = { kind: 'assinatura', ...(await processPagarmeAssinaturaPaid(orderId, { payload, req, source: 'webhook' })) };
  } else if (pagarmeWebhookLooksPaid(payload)) {
    const trilha = await reconcilePendingTrilhaCheckouts({ max: 20, payload });
    const assinatura = await reconcilePendingPagarmeAssinatura({ max: 20, payload, req });
    result = { kind: 'reconcile', trilha, assinatura, processed: Boolean(trilha?.ok || assinatura?.processed) };
  } else {
    return res.status(200).json({ received: true, processed: false, ignored: payload.type || null });
  }

  logAssinaturaEvent(req, {
    action: result.kind === 'assinatura'
      ? (result.processed ? 'pagarme_assinatura_paid' : 'pagarme_assinatura_failed')
      : (result.ok ? 'trilha_pontohub_ok' : 'trilha_pontohub_failed'),
    provider: 'pagarme',
    account_id: result.account_id || null,
    details: { payment_link_id: paymentLinkId, type: payload.type || null, ...result }
  });
  return res.status(200).json({ received: true, payment_link_id: paymentLinkId, ...result });
}
