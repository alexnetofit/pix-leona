import test from 'node:test';
import assert from 'node:assert/strict';
import { calcLeonaProrata, leonaAmountReais } from '../lib/leona-pricing.js';
import {
  extractPagarmePix,
  friendlyPagarmeError,
  pagarmeDigitalCustomer,
  pagarmeOrderLooksPaid
} from '../lib/pagarme.js';
import {
  buildPagarmeAssinaturaOrderPayload,
  resolvePagarmeAssinaturaCharge
} from '../lib/pagarme-assinatura.js';

test('pró-rata 5→7 usa (delta × dias) / 30', () => {
  const now = new Date('2026-08-27T12:00:00-03:00');
  const end = '2026-09-11T23:59:59-03:00';
  const calc = calcLeonaProrata(leonaAmountReais(5), leonaAmountReais(7), end, now);
  assert.equal(calc.diasRestantes, 16);
  assert.equal(calc.proRata, 84.27);
});

test('assinatura nova cobra o mês cheio', () => {
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 1,
    kind: 'subscription',
    profile: { starter_instances: 0 }
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.oneShot, false);
  assert.equal(charge.amountCents, 12700);
  assert.equal(charge.keepCycle, false);
});

test('upgrade mid-cycle cobra só o pró-rata e mantém vencimento', () => {
  const now = new Date('2026-08-27T12:00:00-03:00');
  const end = '2026-09-26T23:59:59-03:00';
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 7,
    kind: 'one_shot',
    profile: { starter_instances: 5, current_period_end: end },
    now
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.oneShot, true);
  assert.equal(charge.keepCycle, true);
  assert.equal(charge.dueDate, '2026-09-26');
  assert.equal(charge.amountCents, Math.round(charge.prorata.proRata * 100));
  assert.ok(charge.amountCents > 0);
});

test('pedido PIX da assinatura não pede endereço', () => {
  const payload = buildPagarmeAssinaturaOrderPayload({
    accountId: '15221',
    qty: 1,
    oneShot: false,
    amountCents: 12700,
    productName: 'Leona Flow — 1 conexão',
    customer: { name: 'Ana', email: 'ana@test.com', document: '39053344705' },
    method: 'pix'
  });
  assert.equal(payload.payments[0].payment_method, 'pix');
  assert.equal(payload.items[0].amount, 12700);
  assert.match(payload.items[0].code, /leona-15221-1-sub/);
  assert.equal(payload.customer.email, 'ana@test.com');
  assert.equal(payload.customer.document, '39053344705');
  assert.equal(payload.customer.document_type, 'CPF');
  assert.equal(payload.customer.address, undefined);
  assert.equal(payload.customer.address_type, undefined);
});

test('pedido cartão usa endereço da empresa, não do cliente', () => {
  const payload = buildPagarmeAssinaturaOrderPayload({
    accountId: '15221',
    qty: 1,
    oneShot: false,
    amountCents: 12700,
    productName: 'Leona Flow — 1 conexão',
    customer: { name: 'Ana', email: 'ana@test.com' },
    method: 'credit_card',
    card: {
      number: '4000000000000010',
      holder_name: 'ANA',
      exp_month: 12,
      exp_year: 2030,
      cvv: '123'
    }
  });
  assert.equal(payload.payments[0].payment_method, 'credit_card');
  assert.equal(payload.customer.address, undefined);
  assert.equal(payload.payments[0].credit_card.card.billing_address.zip_code, '12308301');
  assert.match(payload.payments[0].credit_card.card.billing_address.line_1, /Antonio Lopes da Costa/i);
});

test('cliente digital não inclui endereço', () => {
  const customer = pagarmeDigitalCustomer({ name: 'Ana', email: 'ana@test.com', document: '39053344705' });
  assert.equal(customer.address, undefined);
  assert.equal(customer.document, '39053344705');
  assert.ok(customer.phones.mobile_phone.number);
});

test('erro de documento da Pagar.me vira texto em português', () => {
  assert.equal(friendlyPagarmeError('The customer Document is required.'), 'Informe o CPF ou CNPJ');
  assert.equal(friendlyPagarmeError('The Customer Document is necessary'), 'Informe o CPF ou CNPJ');
});

test('PIX e paid do pedido Pagar.me', () => {
  assert.equal(pagarmeOrderLooksPaid({ status: 'pending' }), false);
  assert.equal(pagarmeOrderLooksPaid({ status: 'paid' }), true);
  assert.equal(extractPagarmePix({
    charges: [{ payment_method: 'pix', last_transaction: { qr_code: '000201010212' } }]
  }).qr_code, '000201010212');
});
