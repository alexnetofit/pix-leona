import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrilhaOrder,
  parseTrilhaDocument,
  parseTrilhaPhone,
  paymentLinkItems
} from '../lib/trilha-order.js';

test('pedido 50k cobra só o frete', () => {
  const order = buildTrilhaOrder({ prizeId: '50k' });
  assert.equal(order.ok, true);
  assert.equal(order.totalCents, 2990);
  assert.equal(order.items[0].name.startsWith('Frete'), true);
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
  const items = paymentLinkItems(order.items);
  assert.equal(items[1].default_quantity, 2);
  assert.equal(items[1].amount, 5450);
});
