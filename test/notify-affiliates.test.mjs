import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAffiliatesPagouPayload,
  isAffiliateReversal
} from '../lib/notify-affiliates.js';

test('monta payload do webhook de afiliados com id pagou:', () => {
  process.env.GURU_WEBHOOK_API_TOKEN = 'test-token';
  const payload = buildAffiliatesPagouPayload({
    txId: '01a02985-6ce7-701d-8936-7948e0bcbff1',
    email: 'JacksonLopesNeves@gmail.com',
    name: 'Jackson',
    amountCents: 12700,
    paidAt: '2026-08-22T12:55:04.000Z',
    status: 'approved'
  });
  assert.equal(payload.api_token, 'test-token');
  assert.equal(payload.webhook_type, 'transaction');
  assert.equal(payload.status, 'approved');
  assert.equal(payload.id, 'pagou:01a02985-6ce7-701d-8936-7948e0bcbff1');
  assert.equal(payload.contact.email, 'jacksonlopesneves@gmail.com');
  assert.equal(payload.payment.total, 127);
  assert.equal(payload.payment.gross, 127);
});

test('não duplica o prefixo pagou:', () => {
  process.env.GURU_WEBHOOK_API_TOKEN = 'test-token';
  const payload = buildAffiliatesPagouPayload({
    txId: 'pagou:abc',
    email: 'a@b.com',
    amountCents: 100
  });
  assert.equal(payload.id, 'pagou:abc');
});

test('reconhece estorno e chargeback da Pagou', () => {
  assert.equal(isAffiliateReversal('transaction.refunded', 'paid'), 'refunded');
  assert.equal(isAffiliateReversal('transaction.paid', 'refunded'), 'refunded');
  assert.equal(isAffiliateReversal('transaction.chargedback', 'paid'), 'chargeback');
  assert.equal(isAffiliateReversal('transaction.paid', 'waiting_payment'), null);
});
