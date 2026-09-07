/**
 * Reconcilia PIX/cartão Pagar.me da /assinatura que o webhook não liberou.
 * Roda a cada 10 min (Vercel cron + CRON_SECRET).
 */
import { listAllPagarmeOrders, pagarmeConfigured, pagarmeOrderLooksPaid } from '../../lib/pagarme.js';
import {
  findPagarmeAssinaturaIntent,
  parseLeonaPagarmeOrderCode,
  processPagarmeAssinaturaPaid,
  reconcilePendingPagarmeAssinatura
} from '../../lib/pagarme-assinatura.js';
import { timingSafeStringEqual } from '../../lib/paddle-session.js';

function authorized(req) {
  const expected = process.env.CRON_SECRET || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

function createdSinceDaysAgo(days) {
  const ms = Date.now() - days * 86400000;
  return new Date(ms).toISOString();
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  if (!pagarmeConfigured()) {
    return res.status(200).json({ skipped: 'pagarme_not_configured' });
  }
  if (!process.env.LEONA_BILLING_TOKEN) {
    return res.status(500).json({ error: 'LEONA_BILLING_TOKEN ausente' });
  }

  const pending = await reconcilePendingPagarmeAssinatura({ max: 40, req, source: 'cron' });
  const listed = await listAllPagarmeOrders({
    status: 'paid',
    createdSince: createdSinceDaysAgo(2),
    maxPages: 15
  });
  const results = [];
  for (const order of listed.rows) {
    if (!pagarmeOrderLooksPaid(order)) continue;
    const parsed = parseLeonaPagarmeOrderCode(order.code);
    if (!parsed && !(await findPagarmeAssinaturaIntent(order.id))) continue;
    try {
      const result = await processPagarmeAssinaturaPaid(order.id, { req, source: 'cron' });
      results.push({
        order_id: order.id,
        code: order.code,
        email: order.customer?.email || null,
        ...result
      });
    } catch (err) {
      console.error('pagarme-reconcile: falha', order.id, err.message);
      results.push({ order_id: order.id, processed: false, error: err.message });
    }
  }

  return res.status(200).json({
    ok: true,
    pending_processed: pending.processed || 0,
    scanned: listed.rows.length,
    tried: results.length,
    processed: results.filter((row) => row.processed).length,
    results
  });
}
