import { applyCors } from '../lib/auth.js';
import { getLeonaBillingProfile } from '../lib/leona.js';
import {
  createPaddleSession,
  serializePaddleSessionCookie,
  timingSafeStringEqual,
  verifyPaddleTicket
} from '../lib/paddle-session.js';

function originIsAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;

  const configured = String(process.env.CORS_ALLOWED_ORIGINS || '').trim();
  if (!configured) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    const protocol = String(req.headers['x-forwarded-proto'] || 'https');
    return origin === `${protocol}://${host}`;
  }

  const allowed = configured
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return allowed.includes('*') || allowed.includes(origin);
}

// Throttle do caminho legado (account_id + email), que é a única forma de
// emitir sessão sem ticket assinado. É best-effort: cada instância serverless
// tem o próprio Map e ele zera em cold start. Serve pra encarecer varredura em
// massa, não pra ser garantia — a garantia é PADDLE_ALLOW_LEGACY_LINKS=false.
const LEGACY_WINDOW_MS = 10 * 60 * 1000;
const LEGACY_MAX_ATTEMPTS = 20;
const legacyAttempts = new Map();

function legacyThrottleExceeded(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' && forwarded
    ? forwarded.split(',')[0].trim()
    : req.socket?.remoteAddress || 'unknown';

  const now = Date.now();
  for (const [key, entry] of legacyAttempts) {
    if (entry.resetAt <= now) legacyAttempts.delete(key);
  }

  const entry = legacyAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    legacyAttempts.set(ip, { count: 1, resetAt: now + LEGACY_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  if (entry.count > LEGACY_MAX_ATTEMPTS) {
    console.warn(`[paddle-session] throttle legado ip=${ip} tentativas=${entry.count}`);
    return true;
  }
  return false;
}

function normalizedProfile(profile, accountId) {
  return {
    account_id: String(profile.account_id ?? accountId),
    email: profile.user?.email ?? profile.email ?? null,
    name:
      profile.user?.name ??
      profile.user?.full_name ??
      profile.name ??
      profile.full_name ??
      null,
    status: profile.subscription_status ?? profile.status ?? null,
    instances: profile.starter_instances ?? profile.instances ?? profile.subscription_instances ?? 0,
    current_period_end: profile.current_period_end ?? null
  };
}

export default async function handler(req, res) {
  if (!originIsAllowed(req)) {
    res.setHeader('Vary', 'Origin');
    return res.status(403).json({ error: 'Origem não permitida' });
  }
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const linkSecret = process.env.PADDLE_LINK_SECRET || '';
  const leonaToken = process.env.LEONA_BILLING_TOKEN || '';
  if (!linkSecret || !leonaToken) {
    return res.status(500).json({ error: 'Configuração de sessão Paddle incompleta' });
  }

  const ticket = String(req.body?.ticket ?? '').trim();
  let accountId;

  if (ticket) {
    try {
      accountId = verifyPaddleTicket(ticket, { secret: linkSecret }).account_id;
    } catch {
      return res.status(401).json({ error: 'Ticket inválido ou expirado' });
    }
  } else {
    const legacyEnabled = process.env.PADDLE_ALLOW_LEGACY_LINKS === 'true';
    const legacyAccountId = String(req.body?.account_id ?? '').trim();
    const legacyEmail = String(req.body?.email ?? '').trim().toLowerCase();
    if (!legacyEnabled || !legacyAccountId || !legacyEmail) {
      return res.status(400).json({ error: 'ticket obrigatório' });
    }
    if (legacyThrottleExceeded(req)) {
      return res.status(429).json({ error: 'Muitas tentativas. Tente de novo em alguns minutos.' });
    }
    accountId = legacyAccountId;
  }

  const profile = await getLeonaBillingProfile(accountId, leonaToken);
  if (!profile) {
    return res.status(404).json({ error: 'Conta Leona não encontrada' });
  }

  const profileAccountId = String(profile.account_id ?? accountId).trim();
  if (profile.account_id != null && profileAccountId !== accountId) {
    return res.status(502).json({ error: 'Identidade da conta Leona inconsistente' });
  }

  if (!ticket) {
    const requestedEmail = String(req.body.email).trim().toLowerCase();
    const profileEmail = String(profile.user?.email ?? profile.email ?? '')
      .trim()
      .toLowerCase();
    if (!profileEmail || !timingSafeStringEqual(requestedEmail, profileEmail)) {
      return res.status(403).json({ error: 'Os dados do link não correspondem' });
    }
  }

  const session = createPaddleSession({
    accountId: profileAccountId,
    secret: linkSecret
  });
  res.setHeader('Set-Cookie', serializePaddleSessionCookie(session));
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json(normalizedProfile(profile, profileAccountId));
}
