import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  brlToUsd,
  dlocalCheckoutPaymentFields,
  dlocalGoAppUrl,
  dlocalGoReturnUrl,
  dlocalPaymentPaid,
  extractDlocalNotificationRef,
  extractDlocalPaymentId,
  normalizeDlocalWebhookPayload,
  isCardMethod,
  isIntlRegion,
  isOneShotKind,
  isPixMethod,
  makeDlocalOrderId,
  parseDlocalOrderId,
  checkoutUrlWithPayer,
  sanitizeCheckoutPayerName,
  subscribeUrlWithPayer,
  parseUsdToBrlRate,
  planDescriptionForQty,
  planNameForQty,
  isDlocalLeonaPlanName,
  qtyFromDlocalPlanName
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

test('makeDlocalOrderId volta a ser parseável e passa na regex da dLocal', () => {
  const id = makeDlocalOrderId('14221', 3, 'subscription');
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  const parsed = parseDlocalOrderId(id);
  assert.equal(parsed.accountId, '14221');
  assert.equal(parsed.qty, 3);
  assert.equal(parsed.kind, 'sub');
});

test('qty do plano de assinatura da Go', () => {
  assert.equal(qtyFromDlocalPlanName('leona-starter-1'), 1);
  assert.equal(qtyFromDlocalPlanName('leona-starter-5-usd'), 5);
  assert.equal(qtyFromDlocalPlanName('ST-abc-0'), null);
  assert.equal(isDlocalLeonaPlanName('leona-starter-1'), true);
  assert.equal(isDlocalLeonaPlanName('leona-starter-5-usd'), true);
  assert.equal(isDlocalLeonaPlanName('leona-off'), false);
});

test('sucesso do checkout volta pro app da Leona', () => {
  const prev = process.env.LEONA_APP_URL;
  delete process.env.LEONA_APP_URL;
  assert.equal(dlocalGoAppUrl(), 'https://app.leonaflow.com');
  if (prev !== undefined) process.env.LEONA_APP_URL = prev;
});

test('checkout avulso é cartão 1x ou PIX (voucher), sem TED', () => {
  assert.deepEqual(dlocalCheckoutPaymentFields(), {
    payment_type: 'CREDIT_CARD,VOUCHER',
    max_installments: 1
  });
  assert.deepEqual(dlocalCheckoutPaymentFields('pix'), {
    payment_type: 'VOUCHER',
    max_installments: 1
  });
  assert.deepEqual(dlocalCheckoutPaymentFields('card'), {
    payment_type: 'CREDIT_CARD',
    max_installments: 1
  });
  assert.equal(isPixMethod('pix'), true);
  assert.equal(isPixMethod('voucher'), true);
  assert.equal(isPixMethod('card'), false);
  assert.equal(isCardMethod('cartao'), true);
  assert.equal(isCardMethod('pix'), false);
});

test('extrai payment_id DP- do webhook', () => {
  assert.equal(extractDlocalPaymentId({ payment_id: 'DP-8050275' }), 'DP-8050275');
  assert.equal(extractDlocalPaymentId({ id: 'DP-1' }), 'DP-1');
  assert.equal(extractDlocalPaymentId({ id: 'not-a-payment' }), null);
  assert.deepEqual(extractDlocalNotificationRef({ payment_id: 'ST-abc-0' }), {
    paymentId: null,
    orderId: 'ST-abc-0',
    subscriptionId: null,
    planId: null
  });
  assert.deepEqual(
    extractDlocalNotificationRef(normalizeDlocalWebhookPayload('{"payment_id":"DP-9"}')),
    { paymentId: 'DP-9', orderId: null, subscriptionId: null, planId: null }
  );
  assert.deepEqual(extractDlocalNotificationRef({ subscription_id: 163779, plan_id: 23762 }), {
    paymentId: null,
    orderId: null,
    subscriptionId: '163779',
    planId: '23762'
  });
});

test('retorno da assinatura aponta pro nosso endpoint', () => {
  assert.equal(
    dlocalGoReturnUrl({ headers: { host: 'client.leonaflow.com', 'x-forwarded-proto': 'https' } }),
    'https://client.leonaflow.com/api/dlocal-go-return'
  );
});

test('classifica kind one_shot', () => {
  assert.equal(isOneShotKind('prorata'), true);
  assert.equal(isOneShotKind('subscription'), false);
  assert.equal(planNameForQty(6), 'leona-starter-6');
  assert.equal(planNameForQty(6, 'USD'), 'leona-starter-6-usd');
  assert.equal(planDescriptionForQty(1), 'Leona Flow — 1 conexao / mes');
  assert.equal(planDescriptionForQty(3), 'Leona Flow — 3 conexoes / mes');
  assert.equal(isIntlRegion('international'), true);
  assert.equal(isIntlRegion('br'), false);
});

test('converte BRL pra USD com o câmbio da dLocal', () => {
  assert.equal(parseUsdToBrlRate({ from: 'USD', to: 'BRL', rate: 5.61143 }), 5.61143);
  assert.equal(parseUsdToBrlRate([
    { source_currency: 'USD', target_currency: 'CLP', value: 978.78 },
    { source_currency: 'USD', target_currency: 'BRL', value: 5.61143 }
  ]), 5.61143);
  assert.equal(brlToUsd(127, 5.61143), 22.63);
});

test('considera PAID e COMPLETED como pagos', () => {
  assert.equal(dlocalPaymentPaid({ status: 'PAID' }), true);
  assert.equal(dlocalPaymentPaid({ status: 'COMPLETED' }), true);
  assert.equal(dlocalPaymentPaid({ status: 'PENDING' }), false);
});

test('página de assinatura oferece PIX ou cartão no Brasil', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(join(here, '../public/pagou-pay-ui.js'), 'utf8');
  const window = {};
  vm.runInNewContext(code, { window });
  const html = window.PagouPay.formHtml('slot', { email: 'a@b.com', name: 'Victor Hugo', kind: 'subscription' });
  assert.match(html, /id="tabPix-slot"/);
  assert.match(html, /id="tabCard-slot"/);
  assert.match(html, />PIX</);
  assert.match(html, />Cartão</);
  assert.match(html, /id="name-slot"/);
  assert.match(html, /value="Victor Hugo"/);
  assert.doesNotMatch(html, /id="nameField-slot" style="display:none;"/);
  assert.equal(window.PagouPay.payLabel('pix', 'subscription', 'br', 316), 'Pagar R$\u00a0316,00 no PIX');
  assert.equal(window.PagouPay.payLabel('card', 'subscription', 'br', 316), 'Pagar R$\u00a0316,00 no cartão');
  assert.equal(window.PagouPay.payLabel('card', 'subscription', 'international'), 'Assinar no exterior');
});

test('checkout da Go recebe nome na URL', () => {
  assert.equal(sanitizeCheckoutPayerName('  Victor   Hugo  '), 'Victor Hugo');
  const hosted = checkoutUrlWithPayer('https://checkout.dlocalgo.com/validate/abc', {
    email: 'a@b.com',
    name: 'Victor Hugo'
  });
  const hostedUrl = new URL(hosted);
  assert.equal(hostedUrl.searchParams.get('email'), 'a@b.com');
  assert.equal(hostedUrl.searchParams.get('name'), 'Victor Hugo');
  const sub = subscribeUrlWithPayer('https://checkout.dlocalgo.com/validate/plan', {
    email: 'a@b.com',
    name: 'Victor Hugo',
    accountId: '12969',
    qty: 5
  });
  const subUrl = new URL(sub);
  assert.equal(subUrl.searchParams.get('name'), 'Victor Hugo');
  assert.equal(subUrl.searchParams.get('external_id'), 'leona:12969:5');
});

test('PIX mensal grava tag sub e não conta como pró-rata', () => {
  const id = makeDlocalOrderId('2662', 4, 'subscription');
  const parsed = parseDlocalOrderId(id);
  assert.equal(parsed.accountId, '2662');
  assert.equal(parsed.qty, 4);
  assert.equal(parsed.kind, 'sub');
  assert.equal(isOneShotKind(parsed.kind), false);
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
