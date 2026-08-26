/**
 * POST/GET /api/webhook-dlocal-go
 * Webhook oficial da dLocal Go: POST { "payment_id": "DP-xxx" }.
 * Assinatura às vezes manda o order_id ST- no lugar do DP-.
 * GET sem params = health check do painel; GET com payment_id também processa.
 *
 * Colar no painel: Integrations → Notification URL
 * https://client.leonaflow.com/api/webhook-dlocal-go
 */
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { pickDlocalEmail, processDlocalPaidPayment } from '../lib/dlocal-activate.js';
import {
  extractDlocalNotificationRef,
  findDlocalPaymentByOrderId,
  getDlocalPayment,
  listDlocalPayments,
  normalizeDlocalWebhookPayload,
  dlocalPaymentPaid
} from '../lib/dlocal-go.js';

function brtDay(offset = 0) {
  const ms = Date.now() + offset * 86400000;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms));
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const payload = normalizeDlocalWebhookPayload(req.body);
  const ref = extractDlocalNotificationRef(payload, req.query || {});
  const isHealthCheck = req.method === 'GET' && !ref.paymentId && !ref.orderId && !Object.keys(payload).length;

  if (isHealthCheck) {
    return res.status(200).json({
      ok: true,
      service: 'dlocal-go',
      webhook: 'https://client.leonaflow.com/api/webhook-dlocal-go'
    });
  }

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) {
    console.error('webhook-dlocal-go: LEONA_BILLING_TOKEN ausente');
    return res.status(500).json({ error: 'Configuração incompleta' });
  }

  let paymentId = ref.paymentId;
  if (!paymentId && pickDlocalEmail({}, payload)) {
    const listed = await listDlocalPayments({
      email: pickDlocalEmail({}, payload),
      startDate: brtDay(-1),
      endDate: brtDay(0),
      size: 20
    });
    const paid = (Array.isArray(listed.body?.data) ? listed.body.data : []).find((row) => dlocalPaymentPaid(row));
    if (paid?.id) paymentId = paid.id;
  }

  console.log('webhook-dlocal-go: recebido', {
    method: req.method,
    payment_id: paymentId,
    order_id: ref.orderId,
    keys: Object.keys(payload || {}),
    status: payload.status || null
  });

  logAssinaturaEvent(req, {
    action: 'dlocal_webhook',
    provider: 'dlocal',
    email: pickDlocalEmail({}, payload),
    account_id: null,
    details: {
      method: req.method,
      payment_id: paymentId,
      order_id: ref.orderId || null,
      raw_status: payload.status || null,
      keys: Object.keys(payload || {})
    }
  });

  let payment = null;
  if (paymentId) {
    const fetched = await getDlocalPayment(paymentId);
    payment = fetched.body || {};
    if (!fetched.ok || !payment.id) {
      console.error('webhook-dlocal-go: get payment falhou', paymentId, fetched.status, fetched.body);
      return res.status(200).json({ received: true, processed: false, error: 'pagamento não encontrado na dLocal' });
    }
  } else if (ref.orderId) {
    payment = await findDlocalPaymentByOrderId(ref.orderId, {
      startDate: brtDay(-2),
      endDate: brtDay(0)
    });
    if (!payment?.id) {
      console.error('webhook-dlocal-go: order_id sem pagamento', ref.orderId);
      return res.status(200).json({ received: true, processed: false, error: 'order_id não encontrado' });
    }
  } else {
    console.error('webhook-dlocal-go: sem payment_id', payload);
    return res.status(200).json({ received: true, processed: false, error: 'payment_id ausente' });
  }

  const result = await processDlocalPaidPayment(payment, { payload, req, source: 'webhook' });
  return res.status(200).json({ received: true, ...result });
}
