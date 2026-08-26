/**
 * Reconcilia PAID da dLocal Go que o webhook de assinatura não entregou.
 * Roda 1x por hora (Vercel cron + CRON_SECRET). Também aceita chamada manual.
 */
import { processDlocalPaidPayment } from '../../lib/dlocal-activate.js';
import { dlocalGoConfigured, dlocalPaymentPaid, listAllDlocalPayments } from '../../lib/dlocal-go.js';
import { timingSafeStringEqual } from '../../lib/paddle-session.js';

function authorized(req) {
  const expected = process.env.CRON_SECRET || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

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
  if (!authorized(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  if (!dlocalGoConfigured()) {
    return res.status(200).json({ skipped: 'dlocal_not_configured' });
  }
  if (!process.env.LEONA_BILLING_TOKEN) {
    return res.status(500).json({ error: 'LEONA_BILLING_TOKEN ausente' });
  }

  const startDate = brtDay(-2);
  const endDate = brtDay(0);
  const listed = await listAllDlocalPayments({ startDate, endDate, maxPages: 20 });
  const paid = listed.rows.filter((row) => dlocalPaymentPaid(row));
  const results = [];

  for (const payment of paid) {
    try {
      const result = await processDlocalPaidPayment(payment, { source: 'reconcile' });
      results.push({
        payment_id: payment.id,
        email: payment.payer?.email || payment.client_email || null,
        ...result
      });
    } catch (err) {
      console.error('dlocal-reconcile: falha', payment.id, err.message);
      results.push({ payment_id: payment.id, processed: false, error: err.message });
    }
  }

  return res.status(200).json({
    ok: true,
    startDate,
    endDate,
    scanned: listed.rows.length,
    paid: paid.length,
    processed: results.filter((row) => row.processed).length,
    duplicates: results.filter((row) => row.duplicate).length,
    unresolved: results.filter((row) => row.error === 'account_id/qty não resolvidos').length,
    results
  });
}
