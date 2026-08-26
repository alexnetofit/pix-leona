import { timingSafeStringEqual } from '../../lib/paddle-session.js';
import { reconcilePendingTrilhaCheckouts } from '../../lib/trilha-fulfill.js';

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
  const result = await reconcilePendingTrilhaCheckouts({ max: 30 });
  return res.status(200).json(result);
}
