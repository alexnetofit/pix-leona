import { sbSelectWhere } from '../lib/supabase.js';
import { buildLeonaPayBoard, historyTokenMatches } from '../lib/leona-pay-history.js';
import { LEONA_PAY_HISTORY_PAGE } from '../lib/leona-pay-history-page.js';
import { LEONA_PAY_QUEUE_PROVIDER } from '../lib/leona-pay-group-queue.js';

function notFound(res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.status(404).send('Não encontrado');
}

async function loadBoard() {
  const [queueRows, webhookRows] = await Promise.all([
    sbSelectWhere('assinatura_access_logs', {
      eq: { provider: LEONA_PAY_QUEUE_PROVIDER },
      order: 'created_at.asc',
      limit: 1000
    }),
    sbSelectWhere('assinatura_access_logs', {
      eq: { action: 'leona_pay_group_webhook' },
      order: 'created_at.desc',
      limit: 500
    })
  ]);
  return buildLeonaPayBoard({ queueRows, webhookRows });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return notFound(res);
  if (!historyTokenMatches(req.query.t, process.env.LEONA_PAY_HISTORY_TOKEN)) return notFound(res);
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (String(req.query.dados || '') === '1') {
    try {
      return res.status(200).json(await loadBoard());
    } catch (error) {
      console.error('leona-pay-historico', error.message);
      return res.status(500).json({ error: 'Não foi possível carregar' });
    }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(LEONA_PAY_HISTORY_PAGE);
}
