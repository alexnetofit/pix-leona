import { applyCors } from '../lib/auth.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const adminToken = (process.env.TOKEN_ADMIN || '').trim();
  const supportToken = (process.env.SUPPORT_CHAT_TOKEN || '').trim();
  const { token, scope } = req.body || {};
  const tokenClean = token ? String(token).trim() : '';
  const isSupport = scope === 'support';

  if (isSupport) {
    if (!supportToken) return res.status(500).json({ error: 'SUPPORT_CHAT_TOKEN não configurado' });
    if (!tokenClean || tokenClean !== supportToken) {
      return res.status(401).json({ error: 'Token inválido' });
    }
    return res.status(200).json({ success: true, scope: 'support' });
  }

  if (!adminToken) return res.status(500).json({ error: 'TOKEN_ADMIN não configurado' });

  if (!tokenClean || tokenClean !== adminToken) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  return res.status(200).json({ success: true, scope: 'admin' });
}
