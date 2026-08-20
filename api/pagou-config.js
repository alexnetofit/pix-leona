/**
 * GET /api/pagou-config
 * Só a public key — o front usa no Payment Element.
 */
import { applyCors } from '../lib/auth.js';
import { pagouPublicKey } from '../lib/pagou.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const publicKey = pagouPublicKey();
  return res.status(200).json({
    public_key: publicKey || null,
    configured: Boolean(publicKey)
  });
}
