import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRILHA_SHIPPING_CENTS,
  buildTrilhaCartOrder,
  buildTrilhaOrder,
  parseTrilhaDocument,
  parseTrilhaPhone,
  paymentLinkItems
} from '../lib/trilha-order.js';

test('pedido 50k cobra R$ 29,90 do prêmio, sem linha de frete', () => {
  const order = buildTrilhaOrder({ prizeId: '50k' });
  assert.equal(order.ok, true);
  assert.equal(order.totalCents, 2990);
  assert.equal(order.shippingCents, 0);
  assert.equal(order.freeShipping, true);
  assert.equal(order.items[0].code, 'trilha-50k');
  assert.equal(order.items[0].amount, 2990);
  assert.equal(order.items.some((item) => item.code === 'trilha-frete'), false);
});

test('placa 100k + 1 extra + jaqueta', () => {
  const order = buildTrilhaOrder({
    prizeId: '100k',
    extraQty: 1,
    bumps: { jaqueta: 1, garrafa: 0 }
  });
  assert.equal(order.ok, true);
  assert.equal(order.totalCents, 29700 + 34650 + 12650);
  assert.equal(order.extras, 1);
  assert.deepEqual(order.bumps, { jaqueta: 1 });
});

test('prêmio inexistente', () => {
  const order = buildTrilhaOrder({ prizeId: 'nope' });
  assert.equal(order.ok, false);
});

test('CPF e telefone', () => {
  assert.equal(parseTrilhaDocument('123'), null);
  assert.equal(parseTrilhaDocument('529.982.247-25').document, '52998224725');
  assert.deepEqual(parseTrilhaPhone('(12) 98888-7777'), {
    country_code: '55',
    area_code: '12',
    number: '988887777'
  });
});

test('itens do payment link usam default_quantity', () => {
  const order = buildTrilhaOrder({ prizeId: '250k', extraQty: 2 });
  const extra = paymentLinkItems(order.items).find((item) => item.code.endsWith('-extra'));
  assert.equal(extra.default_quantity, 2);
  assert.equal(extra.amount, 5450);
});

test('carrinho cobra R$ 29,90 em cada pin, não uma vez só', () => {
  const order = buildTrilhaCartOrder({ prizeIds: ['50k', '250k', '500k'] });
  assert.equal(order.ok, true);
  assert.equal(order.shippingCents, 0);
  assert.equal(order.freeShipping, true);
  assert.equal(order.totalCents, 2990 * 3);
  assert.equal(order.items.find((item) => item.code === 'trilha-50k')?.amount, 2990);
  assert.equal(order.items.find((item) => item.code === 'trilha-250k')?.amount, 2990);
  assert.equal(order.items.find((item) => item.code === 'trilha-500k')?.amount, 2990);
  assert.equal(order.items.some((item) => item.code === 'trilha-frete'), false);
});

test('quem já resgatou só paga o custo da unidade extra', () => {
  const order = buildTrilhaCartOrder({
    prizeIds: ['50k'],
    acquiredIds: ['50k']
  });
  assert.equal(order.ok, true);
  assert.equal(order.totalCents, 6750);
  assert.equal(order.items[0].code, 'trilha-50k-extra');
  assert.equal(order.items.some((item) => item.amount === 2990), false);
});

test('já resgatou 50k e pede 250k novo: extra + 29,90', () => {
  const order = buildTrilhaCartOrder({
    prizeIds: ['50k', '250k'],
    extras: { '50k': 2 },
    acquiredIds: ['50k']
  });
  assert.equal(order.ok, true);
  assert.equal(order.totalCents, 6750 * 2 + 2990);
});

test('antecipação cobra o custo, sem o 29,90 e sem zerar na placa', () => {
  const only = buildTrilhaCartOrder({
    prizeIds: ['50k'],
    anticipatedIds: ['50k']
  });
  assert.equal(only.ok, true);
  assert.equal(only.totalCents, 6750);
  assert.deepEqual(only.anticipatedIds, ['50k']);
  assert.equal(only.items.find((item) => item.code === 'trilha-50k')?.amount, 6750);

  const withPlaque = buildTrilhaCartOrder({
    prizeIds: ['50k', '100k'],
    anticipatedIds: ['50k', '100k']
  });
  assert.equal(withPlaque.totalCents, 6750 + 34650);
  assert.equal(withPlaque.items.find((item) => item.code === 'trilha-50k')?.amount, 6750);
  assert.equal(withPlaque.items.find((item) => item.code === 'trilha-100k')?.amount, 34650);
});

test('placa no carrinho não zera os pins — cada um cobra o preço dele', () => {
  const order = buildTrilhaCartOrder({
    prizeIds: ['50k', '100k', '250k'],
    bumps: { garrafa: 1 }
  });
  assert.equal(order.ok, true);
  assert.equal(order.freeShipping, true);
  assert.equal(order.shippingCents, 0);
  assert.equal(order.totalCents, 29700 + 2990 + 2990 + 3750);
  assert.deepEqual(order.prizeIds, ['50k', '100k', '250k']);
  const pin50 = order.items.find((item) => item.code === 'trilha-50k');
  const pin250 = order.items.find((item) => item.code === 'trilha-250k');
  const placa = order.items.find((item) => item.code === 'trilha-100k');
  assert.equal(pin50?.amount, 2990);
  assert.equal(pin250?.amount, 2990);
  assert.equal(placa?.amount, 29700);
  assert.equal(order.items.some((item) => item.code === 'trilha-frete'), false);
  const linkItems = paymentLinkItems(order.items);
  assert.equal(linkItems.find((item) => item.code === 'trilha-50k')?.amount, 2990);
  assert.equal(linkItems.find((item) => item.code === 'trilha-250k')?.amount, 2990);
  assert.equal(linkItems.find((item) => item.code === 'trilha-100k')?.amount, 29700);
});

test('pedido completo 50k→2m + placa cobra 297 + 5×29,90', () => {
  const order = buildTrilhaCartOrder({
    prizeIds: ['50k', '100k', '250k', '500k', '1m', '2m']
  });
  assert.equal(order.ok, true);
  assert.equal(order.totalCents, 29700 + 2990 * 5);
  assert.equal(order.items.filter((item) => item.amount === 0).length, 0);
});
