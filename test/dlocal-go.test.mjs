import test from 'node:test';
import assert from 'node:assert/strict';

import {
  brlToUsd,
  extractDlocalPaymentId,
  isIntlRegion,
  isOneShotKind,
  makeDlocalOrderId,
  parseDlocalOrderId,
  parseUsdToBrlRate,
  planNameForQty
} from '../lib/dlocal-go.js';
import { buildAffiliatesPagouPayload } from '../lib/notify-affiliates.js';

test('parseia order_id leona:conta:qty:kind', () => {
  const parsed = parseDlocalOrderId('leona:12534:6:prorata:171234');
  assert.deepEqual(parsed, { accountId: '12534', qty: 6, kind: 'prorata' });
});

test('parseia order_id legado leona-conta-qty-prorata', () => {
  const parsed = parseDlocalOrderId('leona-12534-6-prorata-1787712323006');
  assert.deepEqual(parsed, { accountId: '12534', qty: 6, kind: 'one_shot' });
});

test('makeDlocalOrderId volta a ser parseável', () => {
  const id = makeDlocalOrderId('14221', 3, 'subscription');
  const parsed = parseDlocalOrderId(id);
  assert.equal(parsed.accountId, '14221');
  assert.equal(parsed.qty, 3);
  assert.equal(parsed.kind, 'sub');
});

test('extrai payment_id DP- do webhook', () => {
  assert.equal(extractDlocalPaymentId({ payment_id: 'DP-8050275' }), 'DP-8050275');
  assert.equal(extractDlocalPaymentId({ id: 'DP-1' }), 'DP-1');
  assert.equal(extractDlocalPaymentId({ id: 'not-a-payment' }), null);
});

test('classifica kind one_shot', () => {
  assert.equal(isOneShotKind('prorata'), true);
  assert.equal(isOneShotKind('subscription'), false);
  assert.equal(planNameForQty(6), 'leona-starter-6');
  assert.equal(planNameForQty(6, 'USD'), 'leona-starter-6-usd');
  assert.equal(isIntlRegion('international'), true);
  assert.equal(isIntlRegion('br'), false);
});

test('converte BRL pra USD com o câmbio da dLocal', () => {
  assert.equal(parseUsdToBrlRate({ from: 'USD', to: 'BRL', rate: 5.61143 }), 5.61143);
  assert.equal(brlToUsd(127, 5.61143), 22.63);
});

test('afiliados aceitam prefixo dlocal:', () => {
  process.env.GURU_WEBHOOK_API_TOKEN = 'test-token';
  const payload = buildAffiliatesPagouPayload({
    txId: 'dlocal:DP-8050275',
    email: 'a@b.com',
    amountCents: 17110
  });
  assert.equal(payload.id, 'dlocal:DP-8050275');
  assert.equal(payload.payment.total, 171.1);
});
