/**
 * Libera pedidos Pagar.me pagos cujo webhook não atualizou a Leona.
 * Roda a cada 2 minutos (Vercel cron + CRON_SECRET).
 */
import { reconcilePendingPagarmeAssinatura } from '../../lib/pagarme-assinatura.js';
import { timingSafeStringEqual } from '../../lib/paddle-session.js';

function authorized(req) {
  const expected = process.env.CRON_SECRET || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  const result = await reconcilePendingPagarmeAssinatura({ max: 80, req });
  return res.status(200).json({ ok: true, ...result });
}
