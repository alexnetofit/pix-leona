/**
 * Webhook Pagar.me: trilha (Ponto Hub) ou assinatura Leona.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import {
  extractPagarmeOrderId,
  extractPagarmePaymentLinkId,
  extractPagarmeSubscriptionId,
  pagarmeWebhookLooksFailed,
  pagarmeWebhookLooksPaid
} from '../lib/pagarme.js';
import { cancelAssinaturaCardLinkIfLimited } from '../lib/pagarme-card-limits.js';
import {
  findPagarmeAssinaturaIntent,
  processPagarmeAssinaturaPaid,
  processPagarmeSubscriptionRenewal,
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

  let result;
  try {
    if (paymentLinkId) {
      const trilha = await findTrilhaCheckoutByPaymentLink(paymentLinkId);
      if (trilha) {
        result = { kind: 'trilha', ...(await fulfillPaidPaymentLink(paymentLinkId, { source: 'webhook', payload })) };
      } else {
        const intent = await findPagarmeAssinaturaIntent(paymentLinkId);
        if (intent) {
          if (pagarmeWebhookLooksPaid(payload)) {
            result = { kind: 'assinatura', ...(await processPagarmeAssinaturaPaid(paymentLinkId, { payload, req, source: 'webhook' })) };
          } else if (pagarmeWebhookLooksFailed(payload)) {
            const limited = await cancelAssinaturaCardLinkIfLimited({
              email: intent.email,
              paymentLinkId
            });
            result = { kind: 'assinatura', processed: false, ignored: true, limited };
          } else {
            result = { kind: 'assinatura', processed: false, ignored: true };
          }
        } else if (pagarmeWebhookLooksPaid(payload)) {
          const assinatura = await reconcilePendingPagarmeAssinatura({ max: 20, req });
          result = { kind: 'reconcile', assinatura, processed: Boolean(assinatura?.processed) };
        } else {
          result = { kind: null, processed: false, error: 'checkout não encontrado' };
        }
      }
    } else if (orderId && await findPagarmeAssinaturaIntent(orderId)) {
      result = { kind: 'assinatura', ...(await processPagarmeAssinaturaPaid(orderId, { payload, req, source: 'webhook' })) };
    } else if (subscriptionId && pagarmeWebhookLooksPaid(payload)) {
      result = { kind: 'assinatura', ...(await processPagarmeSubscriptionRenewal(subscriptionId, { payload, req, source: 'webhook' })) };
    } else if (pagarmeWebhookLooksPaid(payload)) {
      const trilha = await reconcilePendingTrilhaCheckouts({ max: 20, payload });
      const assinatura = await reconcilePendingPagarmeAssinatura({ max: 20, req });
      result = { kind: 'reconcile', trilha, assinatura, processed: Boolean(trilha?.ok || assinatura?.processed) };
    } else {
      return res.status(200).json({ received: true, processed: false, ignored: payload.type || null });
    }
  } catch (err) {
    // 5xx de propósito: a Pagar.me reenvia 3x, e o corpo abaixo mostra o erro
    // real no painel dela em vez do "A server error has occurred" da Vercel.
    console.error('webhook-pagarme:', err);
    logAssinaturaEvent(req, {
      action: 'pagarme_assinatura_failed',
      provider: 'pagarme',
      details: {
        payment_link_id: paymentLinkId,
        order_id: orderId,
        type: payload.type || null,
        crash: err.message || String(err),
        stack: String(err.stack || '').split('\n').slice(0, 6).join(' | ')
      }
    });
    return res.status(502).json({
      received: true,
      processed: false,
      error: err.message || 'webhook-pagarme crash'
    });
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
