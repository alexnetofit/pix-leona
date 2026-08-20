import { purgeAssinaturaLogs } from '../../lib/assinatura-log.js';
import { timingSafeStringEqual } from '../../lib/paddle-session.js';

function authorized(req) {
  const expected = process.env.CRON_SECRET || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    await purgeAssinaturaLogs();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('assinatura-logs-purge', err);
    return res.status(500).json({ error: err.message });
  }
}
