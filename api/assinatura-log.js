/**
 * POST  /api/assinatura-log   — grava evento da /assinatura (publico)
 * GET   /api/assinatura-log   — lista logs (SUPPORT_CHAT_TOKEN)
 */
import { applyCors } from '../lib/auth.js';
import { listAssinaturaLogs, logAssinaturaEvent } from '../lib/assinatura-log.js';
import { sbConfigured } from '../lib/supabase.js';

function supportOk(req) {
  const expected = (process.env.SUPPORT_CHAT_TOKEN || '').trim();
  if (!expected) return false;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return token === expected;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method === 'GET') {
    if (!supportOk(req)) return res.status(401).json({ error: 'Token inválido' });
    if (!sbConfigured()) return res.status(500).json({ error: 'Supabase não configurado' });
    try {
      const q = req.query || {};
      const rows = await listAssinaturaLogs({
        email: q.email || '',
        account_id: q.account_id || '',
        provider: q.provider || '',
        limit: q.limit
      });
      return res.status(200).json({ logs: rows });
    } catch (err) {
      console.error('assinatura-log GET', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const body = req.body || {};
  const action = String(body.action || '').trim();
  if (!action) return res.status(400).json({ error: 'action obrigatório' });

  const row = await logAssinaturaEvent(req, {
    action,
    provider: body.provider || 'guru',
    email: body.email,
    account_id: body.account_id,
    details: body.details
  });
  return res.status(200).json({ ok: true, id: row?.id || null });
}
