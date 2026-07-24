import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

export const PADDLE_SESSION_COOKIE = 'leona_paddle_session';
export const PADDLE_TICKET_TTL_SECONDS = 5 * 60;
export const PADDLE_SESSION_TTL_SECONDS = 30 * 60;

const TOKEN_VERSION = 1;

export class PaddleSessionError extends Error {
  constructor(message, code = 'INVALID_TOKEN') {
    super(message);
    this.name = 'PaddleSessionError';
    this.code = code;
  }
}

function requireSecret(secret) {
  const value = typeof secret === 'string' ? secret : '';
  if (!value) {
    throw new PaddleSessionError('PADDLE_LINK_SECRET não configurado', 'MISSING_SECRET');
  }
  return value;
}

function nowInSeconds(now) {
  if (now instanceof Date) return Math.floor(now.getTime() / 1000);
  if (Number.isFinite(now)) return Math.floor(now);
  return Math.floor(Date.now() / 1000);
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(encodedPayload, secret) {
  return createHmac('sha256', requireSecret(secret))
    .update(encodedPayload)
    .digest('base64url');
}

export function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''));
  const rightBuffer = Buffer.from(String(right ?? ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function createToken({ type, accountId, email, secret, ttlSeconds, now, claims = null }) {
  const normalizedAccountId = String(accountId ?? '').trim();
  if (!normalizedAccountId) {
    throw new PaddleSessionError('account_id obrigatório', 'INVALID_ACCOUNT_ID');
  }

  const iat = nowInSeconds(now);
  const payload = {
    v: TOKEN_VERSION,
    typ: type,
    account_id: normalizedAccountId,
    nonce: randomBytes(12).toString('base64url'),
    iat,
    exp: iat + ttlSeconds
  };

  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (normalizedEmail) payload.email = normalizedEmail;
  if (claims && typeof claims === 'object' && !Array.isArray(claims)) {
    for (const [key, value] of Object.entries(claims)) {
      if (!['v', 'typ', 'account_id', 'nonce', 'iat', 'exp', 'email'].includes(key)) {
        payload[key] = value;
      }
    }
  }

  const encodedPayload = encode(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

function verifyToken(token, { type, secret, now }) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PaddleSessionError('Token inválido');
  }

  const [encodedPayload, providedSignature] = parts;
  const expectedSignature = sign(encodedPayload, secret);
  if (!timingSafeStringEqual(providedSignature, expectedSignature)) {
    throw new PaddleSessionError('Assinatura inválida', 'INVALID_SIGNATURE');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new PaddleSessionError('Payload inválido');
  }

  const currentTime = nowInSeconds(now);
  if (
    payload?.v !== TOKEN_VERSION ||
    payload?.typ !== type ||
    typeof payload.account_id !== 'string' ||
    !payload.account_id ||
    typeof payload.nonce !== 'string' ||
    !payload.nonce ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    payload.exp <= payload.iat
  ) {
    throw new PaddleSessionError('Payload inválido');
  }
  if (payload.exp <= currentTime) {
    throw new PaddleSessionError('Token expirado', 'TOKEN_EXPIRED');
  }
  if (payload.iat > currentTime + 30) {
    throw new PaddleSessionError('Token emitido no futuro', 'INVALID_IAT');
  }

  return payload;
}

export function createPaddleTicket({
  accountId,
  email,
  secret = process.env.PADDLE_LINK_SECRET,
  now
}) {
  return createToken({
    type: 'paddle_ticket',
    accountId,
    email,
    secret,
    ttlSeconds: PADDLE_TICKET_TTL_SECONDS,
    now
  });
}

export function verifyPaddleTicket(
  token,
  { secret = process.env.PADDLE_LINK_SECRET, now } = {}
) {
  return verifyToken(token, {
    type: 'paddle_ticket',
    secret,
    now
  });
}

export function createPaddleSession({
  accountId,
  secret = process.env.PADDLE_LINK_SECRET,
  now
}) {
  return createToken({
    type: 'paddle_session',
    accountId,
    secret,
    ttlSeconds: PADDLE_SESSION_TTL_SECONDS,
    now
  });
}

export function verifyPaddleSession(
  token,
  { secret = process.env.PADDLE_LINK_SECRET, now } = {}
) {
  return verifyToken(token, {
    type: 'paddle_session',
    secret,
    now
  });
}

export function createPaddleCheckoutToken({
  accountId,
  customerId,
  transactionId,
  intentId,
  secret = process.env.PADDLE_LINK_SECRET,
  now
}) {
  if (!customerId || !transactionId || !intentId) {
    throw new PaddleSessionError('Checkout incompleto', 'INVALID_CHECKOUT');
  }
  return createToken({
    type: 'paddle_checkout',
    accountId,
    secret,
    ttlSeconds: 30 * 60,
    now,
    claims: {
      customer_id: String(customerId),
      transaction_id: String(transactionId),
      intent_id: String(intentId)
    }
  });
}

export function verifyPaddleCheckoutToken(
  token,
  { secret = process.env.PADDLE_LINK_SECRET, now } = {}
) {
  const payload = verifyToken(token, {
    type: 'paddle_checkout',
    secret,
    now
  });
  if (!payload.customer_id || !payload.transaction_id || !payload.intent_id) {
    throw new PaddleSessionError('Checkout incompleto', 'INVALID_CHECKOUT');
  }
  return payload;
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (typeof cookieHeader !== 'string') return cookies;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

export function serializePaddleSessionCookie(token) {
  return [
    `${PADDLE_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${PADDLE_SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax'
  ].join('; ');
}

export function requirePaddleSession(
  req,
  { secret = process.env.PADDLE_LINK_SECRET, now } = {}
) {
  const cookieHeader = req?.headers?.cookie || req?.headers?.Cookie || '';
  const token = parseCookies(cookieHeader)[PADDLE_SESSION_COOKIE];
  if (!token) {
    throw new PaddleSessionError('Sessão Paddle ausente', 'SESSION_REQUIRED');
  }
  return verifyPaddleSession(token, { secret, now });
}
