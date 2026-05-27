import { applyCors } from '../lib/auth.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const adminToken = process.env.TOKEN_ADMIN;
  if (!adminToken) return res.status(500).json({ error: 'TOKEN_ADMIN não configurado' });

  const { token } = req.body || {};
  if (!token || token !== adminToken) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  return res.status(200).json({ success: true });
}
