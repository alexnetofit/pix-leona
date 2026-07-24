import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PADDLE_SESSION_COOKIE,
  PaddleSessionError,
  createPaddleCheckoutToken,
  createPaddleSession,
  createPaddleTicket,
  parseCookies,
  requirePaddleSession,
  serializePaddleSessionCookie,
  verifyPaddleCheckoutToken,
  verifyPaddleTicket
} from '../lib/paddle-session.js';

const SECRET = 'test-secret-that-is-not-used-in-production';
const NOW = 1_800_000_000;

test('aceita ticket válido com identidade e snapshot', () => {
  const ticket = createPaddleTicket({
    accountId: 'account-123',
    email: ' USER@Example.com ',
    secret: SECRET,
    now: NOW
  });

  const payload = verifyPaddleTicket(ticket, {
    secret: SECRET,
    now: NOW + 299
  });

  assert.equal(payload.account_id, 'account-123');
  assert.equal(payload.email, 'user@example.com');
  assert.equal(payload.iat, NOW);
  assert.equal(payload.exp, NOW + 300);
  assert.ok(payload.nonce);
});

test('rejeita ticket expirado', () => {
  const ticket = createPaddleTicket({
    accountId: 'account-123',
    secret: SECRET,
    now: NOW
  });

  assert.throws(
    () => verifyPaddleTicket(ticket, { secret: SECRET, now: NOW + 300 }),
    error =>
      error instanceof PaddleSessionError &&
      error.code === 'TOKEN_EXPIRED'
  );
});

test('rejeita ticket adulterado', () => {
  const ticket = createPaddleTicket({
    accountId: 'account-123',
    secret: SECRET,
    now: NOW
  });
  const [payload, signature] = ticket.split('.');
  const replacement = signature.endsWith('A') ? 'B' : 'A';
  const adulterated = `${payload}.${signature.slice(0, -1)}${replacement}`;

  assert.throws(
    () => verifyPaddleTicket(adulterated, { secret: SECRET, now: NOW }),
    error =>
      error instanceof PaddleSessionError &&
      error.code === 'INVALID_SIGNATURE'
  );
});

test('faz parse de cookies e valida cookie de sessão', () => {
  const session = createPaddleSession({
    accountId: 'account-cookie',
    secret: SECRET,
    now: NOW
  });
  const setCookie = serializePaddleSessionCookie(session);
  const cookiePair = setCookie.split(';', 1)[0];
  const cookieHeader = `theme=dark; ${cookiePair}; encoded=hello%20world`;

  assert.deepEqual(parseCookies(cookieHeader), {
    theme: 'dark',
    [PADDLE_SESSION_COOKIE]: session,
    encoded: 'hello world'
  });

  const payload = requirePaddleSession(
    { headers: { cookie: cookieHeader } },
    { secret: SECRET, now: NOW + 1 }
  );
  assert.equal(payload.account_id, 'account-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=1800/);
});

test('checkout assinado vincula conta, customer, transaction e intent', () => {
  const token = createPaddleCheckoutToken({
    accountId: 'account-checkout',
    customerId: 'ctm_123',
    transactionId: 'txn_123',
    intentId: '00000000-0000-4000-8000-000000000001',
    secret: SECRET,
    now: NOW
  });
  const payload = verifyPaddleCheckoutToken(token, {
    secret: SECRET,
    now: NOW + 60
  });
  assert.equal(payload.account_id, 'account-checkout');
  assert.equal(payload.customer_id, 'ctm_123');
  assert.equal(payload.transaction_id, 'txn_123');
  assert.equal(payload.intent_id, '00000000-0000-4000-8000-000000000001');
});
