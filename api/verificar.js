import { applyCors } from '../lib/auth.js';
import { isVerificarEmail, lookupVerificarRevenue, normalizeVerificarEmail } from '../lib/verificar-revenue.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Metodo nao permitido' });

  res.setHeader('Cache-Control', 'no-store');

  const email = normalizeVerificarEmail(req.query?.email);
  if (!isVerificarEmail(email)) {
    return res.status(400).json({ error: 'Informe um e-mail valido' });
  }

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN nao configurado' });

  try {
    const found = await lookupVerificarRevenue(email, leonaToken);
    return res.status(found.status).json(found.body);
  } catch (error) {
    console.error('verificar error:', error);
    return res.status(500).json({ error: error.message || 'Erro interno' });
  }
}
