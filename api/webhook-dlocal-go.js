/**
 * POST /api/webhook-dlocal-go
 * Libera a Leona quando a dLocal Go confirma pagamento.
 * Cancela Guru e Paddle se existirem.
 *
 * Colar no painel dLocal Go: https://client.leonaflow.com/api/webhook-dlocal-go
 */
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { pickDlocalEmail, processDlocalPaidPayment } from '../lib/dlocal-activate.js';
import {
  extractDlocalPaymentId,
  getDlocalPayment,
  listDlocalPayments,
  dlocalPaymentPaid
} from '../lib/dlocal-go.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'dlocal-go',
      webhook: 'https://client.leonaflow.com/api/webhook-dlocal-go'
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) {
    console.error('webhook-dlocal-go: LEONA_BILLING_TOKEN ausente');
    return res.status(500).json({ error: 'Configuração incompleta' });
  }

  const payload = req.body || {};
  let paymentId = extractDlocalPaymentId(payload, req.query || {});
  if (!paymentId) {
    const hintEmail = pickDlocalEmail({}, payload);
    if (hintEmail) {
      const day = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const listed = await listDlocalPayments({
        email: hintEmail,
        startDate: yesterday,
        endDate: day,
        size: 20
      });
      const paid = (Array.isArray(listed.body?.data) ? listed.body.data : []).find((row) => dlocalPaymentPaid(row));
      if (paid?.id) paymentId = paid.id;
    }
  }
  console.log('webhook-dlocal-go: recebido', {
    payment_id: paymentId,
    keys: Object.keys(payload || {}),
    status: payload.status || null
  });

  logAssinaturaEvent(req, {
    action: 'dlocal_webhook',
    provider: 'dlocal',
    email: pickDlocalEmail({}, payload),
    account_id: null,
    details: { payment_id: paymentId, raw_status: payload.status || null, keys: Object.keys(payload || {}) }
  });

  if (!paymentId) {
    console.error('webhook-dlocal-go: sem payment_id', payload);
    return res.status(200).json({ received: true, processed: false, error: 'payment_id ausente' });
  }

  const fetched = await getDlocalPayment(paymentId);
  const payment = fetched.body || {};
  if (!fetched.ok || !payment.id) {
    console.error('webhook-dlocal-go: get payment falhou', paymentId, fetched.status, fetched.body);
    return res.status(200).json({ received: true, processed: false, error: 'pagamento não encontrado na dLocal' });
  }

  const result = await processDlocalPaidPayment(payment, { payload, req, source: 'webhook' });
  return res.status(200).json({ received: true, ...result });
}
