/**
 * GET /api/pagou-config
 * Public key da Pagou + país sugerido pra decidir Brasil vs Exterior.
 */
import { applyCors } from '../lib/auth.js';
import {
  paddleInternationalReady,
  resolveRequestCountry,
  suggestInternational
} from '../lib/geo-billing.js';
import { pagouPublicKey } from '../lib/pagou.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const publicKey = pagouPublicKey();
  const country = resolveRequestCountry(req);
  return res.status(200).json({
    public_key: publicKey || null,
    configured: Boolean(publicKey),
    country,
    suggest_international: suggestInternational(country),
    paddle_ready: paddleInternationalReady()
  });
}
