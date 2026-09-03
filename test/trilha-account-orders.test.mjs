import test from 'node:test';
import assert from 'node:assert/strict';
import {
  presentTrilhaOrders,
  presentTrilhaShipping,
  purchasedPrizeIdsFromCheckouts,
  resolveFactoryState,
  uniqueTrackingCodes
} from '../lib/trilha-account-orders.js';
import { normalizeTrilhaAddress } from '../lib/trilha-fulfill.js';

test('só pedido pago/enviado conta como adquirido', () => {
  const ids = purchasedPrizeIdsFromCheckouts([
    { status: 'pending', prize_id: '50k' },
    { status: 'fulfilled', prize_id: '50k' },
    { status: 'paid', prize_id: '100k', pontohub: { cart: { prizes: { '250k': { extra: 1 } } } } }
  ]);
  assert.deepEqual(ids.sort(), ['100k', '250k', '50k']);
});

test('pedido mostra itens, valor e rastreio pendente', () => {
  const [order] = presentTrilhaOrders([{
    id: 'abc',
    created_at: '2026-09-02T12:00:00.000Z',
    paid_at: '2026-09-02T12:10:00.000Z',
    status: 'fulfilled',
    amount_cents: 2990,
    prize_id: '50k',
    extra_qty: 0,
    bumps: { garrafa: 1 },
    pontohub: {
      results: [{
        productName: 'Kit Pulseira Leona',
        approved: true,
        request_id: 'req-1'
      }]
    }
  }]);
  assert.equal(order.status_label, 'Ainda no carrinho da fábrica');
  assert.equal(order.factory_state, 'in_cart');
  assert.equal(order.address_editable, true);
  assert.equal(order.amount_formatted.includes('29'), true);
  assert.ok(order.items.some((item) => item.id === '50k'));
  assert.ok(order.items.some((item) => item.id === 'garrafa'));
  assert.equal(order.shipments[0].tracking_code, null);
  assert.deepEqual(order.tracking_codes, []);
  assert.deepEqual(order.request_ids, ['req-1']);
});

test('rastreio do pedido é único e endereço vem formatado', () => {
  const [order] = presentTrilhaOrders([{
    id: 'apex',
    name: 'Matheus Pinas',
    status: 'fulfilled',
    amount_cents: 100400,
    prize_id: '50k',
    extra_qty: 1,
    bumps: { garrafa: 2 },
    cep: '35660146',
    pontohub: {
      shipping: {
        street: 'Rua Paraíba',
        number: '91',
        complement: 'Apartamento 502',
        neighborhood: 'São José',
        city: 'Pará de Minas',
        state: 'MG',
        cep: '35660146'
      },
      results: [
        { productName: 'Pin 1M', request_id: 'a', tracking_code: null },
        { productName: 'Pin 1M', request_id: 'b', tracking_code: null }
      ]
    }
  }]);
  assert.match(order.shipping.formatted, /Rua Paraíba, 91 — Apartamento 502/);
  assert.match(order.shipping.formatted, /CEP 35660-146/);
  assert.deepEqual(order.tracking_codes, []);
  assert.deepEqual(uniqueTrackingCodes([
    { tracking_code: 'AA111' },
    { tracking_code: 'AA111' },
    { tracking_code: 'BB222' }
  ]), ['AA111', 'BB222']);
  assert.equal(presentTrilhaShipping({}), null);
  assert.equal(resolveFactoryState({ shipments: [{ status: 'APPROVED' }], trackingCodes: [] }), 'in_cart');
  assert.equal(resolveFactoryState({ shipments: [{ status: 'SENT' }], trackingCodes: [] }), 'shipped');
  assert.equal(normalizeTrilhaAddress({ cep: '35660146', street: 'Rua Paraíba', number: '91', neighborhood: 'São José', city: 'Pará de Minas', state: 'mg' }).ok, true);
  assert.equal(normalizeTrilhaAddress({ cep: '123', street: 'Rua' }).ok, false);
});

test('carrinho expirado some da aba de pedidos', () => {
  const orders = presentTrilhaOrders([
    { status: 'expired', amount_cents: 17240, prize_id: '50k' },
    { status: 'canceled', amount_cents: 9740, prize_id: '50k' },
    { status: 'fulfilled', amount_cents: 100400, prize_id: '50k' }
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, 'fulfilled');
});

test('carrinho antigo some depois do pedido pago', () => {
  const orders = presentTrilhaOrders([
    { id: 'new', status: 'fulfilled', amount_cents: 100400, prize_id: '50k', created_at: '2026-09-02T21:00:00.000Z', paid_at: '2026-09-02T21:03:00.000Z' },
    { id: 'old-172', status: 'pending', amount_cents: 17240, prize_id: '50k', created_at: '2026-09-02T14:44:00.000Z', checkout_url: 'https://pay/old' },
    { id: 'old-97', status: 'pending', amount_cents: 9740, prize_id: '50k', created_at: '2026-09-02T14:26:00.000Z', checkout_url: 'https://pay/older' }
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, 'new');
});

test('só o checkout mais novo fica visível enquanto não pagou', () => {
  const orders = presentTrilhaOrders([
    { id: 'a', status: 'pending', amount_cents: 26140, prize_id: '50k', created_at: '2026-09-02T14:26:00.000Z' },
    { id: 'b', status: 'pending', amount_cents: 17240, prize_id: '50k', created_at: '2026-09-02T14:44:00.000Z' }
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, 'b');
});

test('checkout novo depois do pedido pago continua visível', () => {
  const orders = presentTrilhaOrders([
    { id: 'paid', status: 'fulfilled', amount_cents: 100400, prize_id: '50k', created_at: '2026-09-02T21:00:00.000Z', paid_at: '2026-09-02T21:03:00.000Z' },
    { id: 'extra', status: 'pending', amount_cents: 6750, prize_id: '50k', created_at: '2026-09-02T22:00:00.000Z' }
  ]);
  assert.deepEqual(orders.map((order) => order.id), ['paid', 'extra']);
});
