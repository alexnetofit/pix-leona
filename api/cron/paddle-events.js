import {
  claimPaddleWebhookEvents,
  updatePaddleWebhookEvent
} from '../../lib/paddle-ledger.js';
import { processPaddleWebhookEvent } from '../../lib/paddle-webhook-processor.js';
import { timingSafeStringEqual } from '../../lib/paddle-session.js';

function authorized(req) {
  const expected = process.env.CRON_SECRET || '';
  const header = String(req.headers.authorization || '');
  const provided = header.replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const events = await claimPaddleWebhookEvents({ limit: 20 });
  const results = [];
  for (const event of events) {
    try {
      const result = await processPaddleWebhookEvent(event);
      results.push({ event_id: event.event_id, ok: true, result });
    } catch (error) {
      const terminal = event.attempts >= 10;
      await updatePaddleWebhookEvent(event.event_id, {
        status: terminal ? 'dead_letter' : 'failed',
        last_error: String(error?.message || error).slice(0, 1000)
      }, 'processing');
      results.push({
        event_id: event.event_id,
        ok: false,
        terminal,
        error: String(error?.message || error)
      });
    }
  }
  return res.status(200).json({ claimed: events.length, results });
}
