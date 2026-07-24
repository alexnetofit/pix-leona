import { applyCors } from '../lib/auth.js';
import { getLeonaBillingProfile } from '../lib/leona.js';
import {
  createPaddleTicket,
  timingSafeStringEqual
} from '../lib/paddle-session.js';

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const issuerToken = process.env.PADDLE_LINK_ISSUER_TOKEN || '';
  const linkSecret = process.env.PADDLE_LINK_SECRET || '';
  const leonaToken = process.env.LEONA_BILLING_TOKEN || '';
  if (!issuerToken || !linkSecret || !leonaToken) {
    return res.status(500).json({ error: 'Configuração de link Paddle incompleta' });
  }

  const providedToken = bearerToken(req);
  if (!providedToken || !timingSafeStringEqual(providedToken, issuerToken)) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const accountId = String(req.body?.account_id ?? '').trim();
  if (!accountId) {
    return res.status(400).json({ error: 'account_id obrigatório' });
  }

  const profile = await getLeonaBillingProfile(accountId, leonaToken);
  if (!profile) {
    return res.status(404).json({ error: 'Conta Leona não encontrada' });
  }

  const profileAccountId = String(profile.account_id ?? accountId).trim();
  if (profile.account_id != null && profileAccountId !== accountId) {
    return res.status(502).json({ error: 'Identidade da conta Leona inconsistente' });
  }

  const email = profile.user?.email || profile.email || undefined;
  const ticket = createPaddleTicket({
    accountId: profileAccountId,
    email,
    secret: linkSecret
  });
  const url = new URL(
    process.env.PADDLE_BILLING_BASE_URL || 'https://client.leonaflow.com/paddle'
  );
  url.searchParams.set('ticket', ticket);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ url: url.toString() });
}
