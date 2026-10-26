/**
 * Manda o próximo grupo do Leona Pay que estiver na fila.
 * Um por vez, só das 06:00 até 00:00 em Brasília, com 5 a 10 minutos de espera.
 */
import { timingSafeStringEqual } from '../../lib/paddle-session.js';
import { runLeonaPayGroupQueue } from '../../lib/leona-pay-group-queue.js';

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
  try {
    const result = await runLeonaPayGroupQueue();
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('cron leona-pay-group-queue', error.message);
    return res.status(500).json({ ok: false, error: 'falha ao processar a fila' });
  }
}
