import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePaddleCompletedSync } from '../api/webhook-paddle.js';

test('one_shot usa qty alvo do custom_data, não o item avulso', () => {
  const sync = resolvePaddleCompletedSync({
    items: [{ quantity: 1, price: { unit_price: { amount: '5530' } } }],
    customData: { kind: 'one_shot', qty: '8', source: 'assinatura-international' },
    subscriptionQty: 0,
    nextBilled: '2026-10-19T00:00:00Z'
  });
  assert.equal(sync.oneShot, true);
  assert.equal(sync.qty, 8);
  assert.equal(sync.payload.starter_instances, 8);
  assert.equal(sync.payload.status, 'active');
  assert.equal(sync.payload.due_date, undefined);
});

test('assinatura recorrente ainda lê qty dos items / subscription', () => {
  const sync = resolvePaddleCompletedSync({
    items: [{ quantity: 2 }],
    customData: { source: 'assinatura-international', qty: '2' },
    subscriptionQty: 8,
    nextBilled: '2026-09-29T00:00:00Z'
  });
  assert.equal(sync.oneShot, false);
  assert.equal(sync.qty, 8);
  assert.equal(sync.payload.starter_instances, 8);
  assert.equal(sync.payload.due_date, '2026-09-29');
});
