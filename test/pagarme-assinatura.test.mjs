import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcLeonaProrata, leonaAmountReais } from '../lib/leona-pricing.js';
import {
  extractPagarmeCycleKey,
  extractPagarmePix,
  extractPagarmeSubscriptionId,
  friendlyPagarmeError,
  pagarmeDigitalCustomer,
  pagarmeOrderLooksPaid,
  pagarmeSubscriptionActive,
  pagarmeWebhookLooksFailed,
  pagarmeWebhookLooksPaid
} from '../lib/pagarme.js';
import { pickPagarmeSubscriptionItem } from '../lib/pagarme-downgrade.js';
import {
  assinaturaCheckoutLooksPaid,
  assinaturaReturnUrl,
  buildPagarmeAssinaturaOrderPayload,
  buildPagarmeAssinaturaPaymentLinkPayload,
  inferQtyFromPagarmeSubscription,
  pagarmeAssinaturaLinkCustomer,
  resolvePagarmeAssinaturaCharge,
  subscriptionDueDate
} from '../lib/pagarme-assinatura.js';
import {
  buildPagarmePlanPayload,
  pagarmePlanCodeForQty,
  pagarmePlanMatchesQty,
  pagarmePlanNameForQty
} from '../lib/pagarme-plans.js';

test('pró-rata 5→7 usa (delta × dias) / 30', () => {
  const now = new Date('2026-08-27T12:00:00-03:00');
  const end = '2026-09-11T23:59:59-03:00';
  const calc = calcLeonaProrata(leonaAmountReais(5), leonaAmountReais(7), end, now);
  assert.equal(calc.diasRestantes, 16);
  assert.equal(calc.diasCobrados, 16);
  assert.equal(calc.proRata, 84.27);
});

test('pró-rata 1→3 com 31 dias restantes não passa de R$ 170', () => {
  const now = new Date('2026-09-03T12:00:00-03:00');
  const end = '2026-10-04T11:00:00-03:00';
  const calc = calcLeonaProrata(leonaAmountReais(1), leonaAmountReais(3), end, now);
  assert.equal(calc.diasRestantes, 31);
  assert.equal(calc.diasCobrados, 30);
  assert.equal(calc.proRata, 170);
  assert.equal(calc.proRata, leonaAmountReais(3) - leonaAmountReais(1));
});

test('upgrade 1→3 no ciclo de 31 dias cobra o teto mensal', () => {
  const now = new Date('2026-09-03T12:00:00-03:00');
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 3,
    kind: 'one_shot',
    profile: { starter_instances: 1, current_period_end: '2026-10-04T11:00:00-03:00' },
    now
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.oneShot, true);
  assert.equal(charge.amountCents, 17000);
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

test('link de cartão da assinatura manda nome, e-mail e CPF, sem endereço', () => {
  const payload = buildPagarmeAssinaturaPaymentLinkPayload({
    accountId: '15221',
    qty: 1,
    oneShot: false,
    amountCents: 12700,
    productName: 'Leona Flow — 1 conexão',
    customer: { name: 'Ana', email: 'ana@test.com', document: '39053344705' },
    successUrl: 'https://client.leonaflow.com/assinatura?account_id=15221&email=ana%40test.com&paid=1'
  });
  assert.equal(payload.type, 'order');
  assert.deepEqual(payload.payment_settings.accepted_payment_methods, ['credit_card']);
  assert.equal(payload.customer_settings.customer.email, 'ana@test.com');
  assert.equal(payload.customer_settings.customer.document, '39053344705');
  assert.equal(payload.customer_settings.customer.address, undefined);
  assert.equal(payload.cart_settings.shipping_cost, undefined);
  assert.equal(payload.cart_settings.items[0].amount, 12700);
  assert.equal(payload.payment_settings.credit_card_settings.installments[0].number, 1);
  assert.match(payload.flow_settings.success_url, /\/assinatura\?/);
});

test('plano Pagar.me é mensal prepaid no valor da qty', () => {
  const plan = buildPagarmePlanPayload(3);
  assert.equal(pagarmePlanCodeForQty(3), 'leona-starter-3');
  assert.equal(pagarmePlanNameForQty(3), 'Leona Flow — 3 conexões');
  assert.equal(plan.interval, 'month');
  assert.equal(plan.interval_count, 1);
  assert.equal(plan.billing_type, 'prepaid');
  assert.deepEqual(plan.payment_methods, ['credit_card']);
  assert.equal(plan.items[0].pricing_scheme.price, 29700);
  assert.equal(plan.metadata.code, 'leona-starter-3');
  assert.equal(pagarmePlanMatchesQty({
    name: plan.name,
    description: plan.description,
    items: plan.items,
    metadata: plan.metadata
  }, 3), true);
  assert.equal(pagarmePlanMatchesQty(plan, 1), false);
});

test('customer do link da assinatura não leva telefone nem endereço', () => {
  const customer = pagarmeAssinaturaLinkCustomer({
    name: 'Ana',
    email: 'ana@test.com',
    document: '39053344705'
  });
  assert.equal(customer.address, undefined);
  assert.equal(customer.phones, undefined);
  assert.equal(customer.document_type, 'CPF');
});

test('retorno do cartão volta para a /assinatura', () => {
  assert.equal(
    assinaturaReturnUrl({
      accountId: '15221',
      email: 'ana@test.com',
      publicUrl: 'https://client.leonaflow.com/assinatura'
    }),
    'https://client.leonaflow.com/assinatura?account_id=15221&email=ana%40test.com&paid=1'
  );
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

test('UI da assinatura manda o cartão para o checkout da Stone', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const page = readFileSync(join(here, '../public/pagou-pay-ui.js'), 'utf8');
  assert.doesNotMatch(page, /cardNumber-/);
  assert.match(page, /checkout_url/);
  assert.match(page, /checkout da Stone/);
  const assinatura = readFileSync(join(here, '../public/assinatura.html'), 'utf8');
  assert.match(assinatura, /pagarme-pay\?/);
  assert.match(assinatura, /reconcile/);
  assert.doesNotMatch(assinatura, /get\('paid'\) === '1' && \(email \|\| accountIdParam\)/);
});

test('webhook failed reconhece recusa de cartão', () => {
  assert.equal(pagarmeWebhookLooksFailed({ type: 'charge.payment_failed' }), true);
  assert.equal(pagarmeWebhookLooksFailed({ type: 'order.paid' }), false);
  assert.equal(pagarmeWebhookLooksFailed({ data: { status: 'failed' } }), true);
});

test('webhook de fatura e charge.paid renovam assinatura', () => {
  assert.equal(pagarmeWebhookLooksPaid({ type: 'invoice.paid' }), true);
  assert.equal(extractPagarmeSubscriptionId({
    type: 'charge.paid',
    data: { id: 'ch_1', subscription_id: 'sub_abc' }
  }), 'sub_abc');
  assert.equal(extractPagarmeSubscriptionId({
    data: { id: 'or_xxx', subscription: { id: 'sub_from_obj' } }
  }), 'sub_from_obj');
  assert.equal(extractPagarmeCycleKey({
    type: 'invoice.paid',
    data: { id: 'in_cycle1', subscription_id: 'sub_abc' }
  }), 'in_cycle1');
  assert.equal(inferQtyFromPagarmeSubscription({
    metadata: { qty: '6' },
    plan: { name: 'Leona Flow — 1 conexão' }
  }), 6);
  assert.equal(inferQtyFromPagarmeSubscription({
    plan: { name: 'Leona Flow — 4 conexões' }
  }), 4);
  assert.equal(subscriptionDueDate({
    current_cycle: { end_at: '2026-10-06T23:59:59Z' }
  }), '2026-10-06');
});

test('pedido pago sem assinatura na Pagar.me não quebra o webhook', () => {
  // O checkout da Stone cria pedido avulso: attachPagarmeSubscription volta
  // null, e o default `= {}` do parâmetro não cobre null — só undefined.
  assert.equal(subscriptionDueDate(null), null);
  assert.equal(subscriptionDueDate(undefined), null);
  assert.equal(inferQtyFromPagarmeSubscription(null), 1);
  assert.equal(extractPagarmeCycleKey({ type: 'order.paid', data: { id: 'or_x' } }, null), null);
  assert.equal(pagarmeSubscriptionActive(null), false);
  assert.equal(pickPagarmeSubscriptionItem(null), null);
});

test('cartão no checkout Stone libera pelo pedido pago, não só pelo link', () => {
  assert.equal(assinaturaCheckoutLooksPaid({
    link: { status: 'active', total_paid_sessions: 0 }
  }), false);
  assert.equal(assinaturaCheckoutLooksPaid({
    link: { status: 'active', total_paid_sessions: 0 },
    order: { id: 'or_paid', status: 'paid' }
  }), true);
  assert.equal(assinaturaCheckoutLooksPaid({
    link: { status: 'finished', total_paid_sessions: 1 }
  }), true);
});

test('PIX e paid do pedido Pagar.me', () => {
  assert.equal(pagarmeOrderLooksPaid({ status: 'pending' }), false);
  assert.equal(pagarmeOrderLooksPaid({ status: 'paid' }), true);
  assert.equal(extractPagarmePix({
    charges: [{ payment_method: 'pix', last_transaction: { qr_code: '000201010212' } }]
  }).qr_code, '000201010212');
  assert.equal(extractPagarmePix({
    charges: [{ payment_method: 'pix', last_transaction: { pix: { qr_code: '000201010212nested' } } }]
  }).qr_code, '000201010212nested');
});
