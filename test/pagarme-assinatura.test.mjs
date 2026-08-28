import test from 'node:test';
import assert from 'node:assert/strict';
import { calcLeonaProrata, leonaAmountCents, leonaAmountReais } from '../lib/leona-pricing.js';
import {
  extractPagarmeCycleId,
  extractPagarmePix,
  extractPagarmeSubscriptionId,
  friendlyPagarmeError,
  pagarmeDigitalCustomer,
  pagarmeInvoicePaid,
  pagarmeOrderLooksPaid,
  pagarmeSubscriptionActive,
  pagarmeSubscriptionMainItem
} from '../lib/pagarme.js';
import {
  buildPagarmeAssinaturaOrderPayload,
  buildPagarmeSubscriptionPayload,
  createPagarmeAssinaturaCheckout,
  resolvePagarmeAssinaturaCharge
} from '../lib/pagarme-assinatura.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

async function withMockedFetch(handler, fn) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: (opts.method || 'GET').toUpperCase(), body: opts.body };
    calls.push(call);
    return handler(call);
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = realFetch;
  }
}

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

test('ciclo novo no cartão vira assinatura nativa mensal', () => {
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 2,
    kind: 'subscription',
    method: 'credit_card',
    hasActivePagarmeSub: false,
    profile: { starter_instances: 0 }
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.mode, 'subscription');
  assert.equal(charge.oneShot, false);
  assert.equal(charge.keepCycle, false);
  assert.equal(charge.amountCents, leonaAmountCents(2));
});

test('PIX de ciclo novo continua pedido avulso (sem recorrência)', () => {
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 1,
    kind: 'subscription',
    method: 'pix',
    profile: { starter_instances: 0 }
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.mode, 'order');
  assert.equal(charge.oneShot, false);
  assert.equal(charge.amountCents, 12700);
  assert.equal(charge.keepCycle, false);
});

test('upgrade de outra plataforma continua avulso pró-rata (cartão)', () => {
  const now = new Date('2026-08-27T12:00:00-03:00');
  const end = '2026-09-26T23:59:59-03:00';
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 7,
    kind: 'one_shot',
    method: 'credit_card',
    hasActivePagarmeSub: false,
    profile: { starter_instances: 5, current_period_end: end },
    now
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.mode, 'one_shot');
  assert.equal(charge.oneShot, true);
  assert.equal(charge.keepCycle, true);
  assert.equal(charge.dueDate, '2026-09-26');
});

test('sub Pagar.me ativa: atualiza item mensal e cobra só o pró-rata', () => {
  const now = new Date('2026-08-27T12:00:00-03:00');
  const end = '2026-09-26T23:59:59-03:00';
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 7,
    kind: 'subscription',
    method: 'credit_card',
    hasActivePagarmeSub: true,
    profile: { starter_instances: 5, current_period_end: end },
    now
  });
  assert.equal(charge.ok, true);
  assert.equal(charge.mode, 'sub_update');
  assert.equal(charge.oneShot, true);
  assert.equal(charge.keepCycle, true);
  assert.equal(charge.dueDate, '2026-09-26');
  assert.equal(charge.amountCents, Math.round(charge.prorata.proRata * 100));
  assert.ok(charge.amountCents > 0);
});

test('sub Pagar.me ativa no mesmo plano não gera cobrança nova', () => {
  const now = new Date('2026-08-27T12:00:00-03:00');
  const end = '2026-09-26T23:59:59-03:00';
  const charge = resolvePagarmeAssinaturaCharge({
    qty: 5,
    kind: 'subscription',
    method: 'credit_card',
    hasActivePagarmeSub: true,
    profile: { starter_instances: 5, current_period_end: end },
    now
  });
  assert.equal(charge.ok, false);
  assert.equal(charge.status, 409);
});

test('payload da assinatura nativa é mensal prepaid no cartão', () => {
  const payload = buildPagarmeSubscriptionPayload({
    accountId: '15221',
    qty: 2,
    amountCents: leonaAmountCents(2),
    productName: 'Leona Flow — 2 conexões',
    customer: { name: 'Ana', email: 'ana@test.com', document: '39053344705' },
    card: {
      number: '4000000000000010',
      holder_name: 'ANA',
      exp_month: 12,
      exp_year: 2030,
      cvv: '123'
    }
  });
  assert.equal(payload.payment_method, 'credit_card');
  assert.equal(payload.interval, 'month');
  assert.equal(payload.interval_count, 1);
  assert.equal(payload.billing_type, 'prepaid');
  assert.equal(payload.installments, 1);
  assert.equal(payload.items[0].pricing_scheme.price, leonaAmountCents(2));
  assert.equal(payload.items[0].quantity, 1);
  assert.equal(payload.card.billing_address.zip_code, '12308301');
  assert.match(payload.code, /leona-15221-2-sub/);
  assert.equal(payload.metadata.kind, 'subscription');
  assert.equal(payload.customer.document, '39053344705');
  assert.equal(payload.customer.address, undefined);
});

test('webhook invoice.paid identifica assinatura, ciclo e libera por sub_…:cycle_…', () => {
  const payload = {
    type: 'invoice.paid',
    data: {
      id: 'in_abc123',
      status: 'paid',
      subscription: { id: 'sub_XYZ789' },
      cycle: { id: 'cycle_001' }
    }
  };
  assert.equal(pagarmeInvoicePaid(payload), true);
  assert.equal(extractPagarmeSubscriptionId(payload), 'sub_XYZ789');
  assert.equal(extractPagarmeCycleId(payload), 'cycle_001');
  const eventId = `pagarme:${extractPagarmeSubscriptionId(payload)}:${extractPagarmeCycleId(payload)}`;
  assert.equal(eventId, 'pagarme:sub_XYZ789:cycle_001');
});

test('invoice.payment_failed não é considerado pago', () => {
  assert.equal(pagarmeInvoicePaid({ type: 'invoice.payment_failed', data: { status: 'pending' } }), false);
  assert.equal(pagarmeInvoicePaid({ type: 'order.paid' }), false);
});

test('subscription.* traz o sub_ direto em data.id', () => {
  const payload = { type: 'subscription.created', data: { id: 'sub_direct', status: 'active' } };
  assert.equal(extractPagarmeSubscriptionId(payload), 'sub_direct');
  assert.equal(pagarmeSubscriptionActive(payload.data), true);
});

test('item mensal principal da assinatura é o de maior preço', () => {
  const sub = {
    items: [
      { id: 'sit_1', pricing_scheme: { price: 9900 } },
      { id: 'sit_2', pricing_scheme: { price: 19800 } }
    ]
  };
  assert.equal(pagarmeSubscriptionMainItem(sub).id, 'sit_2');
  assert.equal(pagarmeSubscriptionMainItem({}), null);
});

test('roteamento: cartão + ciclo novo dispara POST /subscriptions', async () => {
  const result = await withMockedFetch((call) => {
    if (call.url.endsWith('/subscriptions')) {
      return jsonResponse({ id: 'sub_new1', status: 'active', current_cycle: { id: 'cycle_1' } });
    }
    return jsonResponse({});
  }, async (calls) => {
    const out = await createPagarmeAssinaturaCheckout({
      accountId: '15221',
      email: 'ana@test.com',
      name: 'Ana',
      qty: 2,
      kind: 'subscription',
      profile: { starter_instances: 0 },
      method: 'credit_card',
      card: { number: '4000000000000010', holder_name: 'ANA', exp_month: 12, exp_year: 2030, cvv: '123' },
      document: '39053344705'
    });
    assert.equal(out.ok, true);
    assert.equal(out.subscription, true);
    assert.equal(out.id, 'sub_new1');
    assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/subscriptions')));
    assert.ok(!calls.some((c) => c.url.endsWith('/orders')));
    return out;
  });
  assert.ok(result);
});

test('roteamento: PIX de ciclo novo dispara POST /orders (sem recorrência)', async () => {
  await withMockedFetch((call) => {
    if (call.url.endsWith('/orders')) {
      return jsonResponse({
        id: 'or_pix1',
        status: 'pending',
        charges: [{ payment_method: 'pix', last_transaction: { qr_code: 'PIXCODE123' } }]
      });
    }
    return jsonResponse({});
  }, async (calls) => {
    const out = await createPagarmeAssinaturaCheckout({
      accountId: '15221',
      email: 'ana@test.com',
      name: 'Ana',
      qty: 1,
      kind: 'subscription',
      profile: { starter_instances: 0 },
      method: 'pix',
      document: '39053344705'
    });
    assert.equal(out.ok, true);
    assert.equal(out.id, 'or_pix1');
    assert.equal(out.pix.qr_code, 'PIXCODE123');
    assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/orders')));
    assert.ok(!calls.some((c) => c.url.endsWith('/subscriptions')));
  });
});

test('roteamento: sub Pagar.me ativa → PUT no item mensal + POST /orders do pró-rata', async () => {
  process.env.SUPABASE_URL = 'https://sb.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_dummy';
  const end = new Date(Date.now() + 20 * 86400000).toISOString();
  try {
    await withMockedFetch((call) => {
      if (call.url.includes('/rest/v1/dlocal_checkout_intents')) {
        if (call.method === 'GET') {
          return jsonResponse([{
            id: 'row1',
            account_id: '15221',
            qty: 5,
            status: 'paid',
            dlocal_payment_id: 'sub_active1',
            details: { provider: 'pagarme', subscription: true, kind: 'subscription' }
          }]);
        }
        return jsonResponse([{ id: 'row1' }]);
      }
      if (call.url.includes('/subscriptions/sub_active1/items/')) {
        return jsonResponse({ id: 'sit_1' });
      }
      if (call.url.includes('/subscriptions/sub_active1')) {
        return jsonResponse({
          id: 'sub_active1',
          status: 'active',
          items: [{ id: 'sit_1', pricing_scheme: { price: leonaAmountCents(5) } }]
        });
      }
      if (call.url.endsWith('/orders')) {
        return jsonResponse({ id: 'or_prorata1', status: 'pending', charges: [{ status: 'pending' }] });
      }
      return jsonResponse({});
    }, async (calls) => {
      const out = await createPagarmeAssinaturaCheckout({
        accountId: '15221',
        email: 'ana@test.com',
        name: 'Ana',
        qty: 7,
        kind: 'subscription',
        profile: { starter_instances: 5, current_period_end: end },
        method: 'credit_card',
        card: { number: '4000000000000010', holder_name: 'ANA', exp_month: 12, exp_year: 2030, cvv: '123' },
        document: '39053344705'
      });
      assert.equal(out.ok, true);
      assert.equal(out.mode, 'sub_update');
      assert.equal(out.subscription_id, 'sub_active1');
      assert.equal(out.id, 'or_prorata1');
      assert.ok(calls.some((c) => c.method === 'PUT' && c.url.includes('/subscriptions/sub_active1/items/sit_1')));
      assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/orders')));
    });
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});
