import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPagouSubscriberSnapshot,
  pagouGrossBrlCents,
  pagouNetBrlCents
} from '../lib/revenue-source.js';

test('pagouGrossBrlCents usa o que o cliente pagou, nao o settlement', () => {
  assert.equal(pagouGrossBrlCents({
    amount: 3815,
    paid_amount: 19800,
    base_price: 19800
  }), 19800);
  assert.equal(pagouGrossBrlCents({
    payment: { amount: 2448, base_price: 12700 }
  }), 12700);
  assert.equal(pagouGrossBrlCents({
    amount: 12700,
    paid_amount: 12700,
    base_price: 12700
  }), 12700);
});

test('pagouNetBrlCents escala settlement e mantem PIX em real', () => {
  assert.equal(pagouNetBrlCents({
    amount: 3815,
    paid_amount: 19800,
    fee: { net_amount: 3586 }
  }), Math.round(19800 * 3586 / 3815));
  assert.equal(pagouNetBrlCents({
    amount: 12700,
    paid_amount: 12700,
    fee: { net_amount: 12369 }
  }), 12369);
});

test('buildPagouSubscriberSnapshot conta e-mail unico pago, sem olhar assinatura', () => {
  const snapshot = buildPagouSubscriberSnapshot({
    transactions: [
      { buyer: { email: 'recorrente@x.com' } },
      { buyer: { email: 'avulso@x.com' } },
      { buyer: { email: 'AVULSO@x.com' } },
      { buyer: { email: '' } }
    ]
  });

  assert.deepEqual(snapshot, { count: 2, recurring: null, prepaid: 2 });
});
