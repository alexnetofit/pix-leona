import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPagouSubscriberSnapshot,
  pagouGrossBrlCents,
  pagouNetBrlCents,
  pagouSubscriptionIsRecurring
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

test('pagouSubscriptionIsRecurring so conta PIX automatico com mandato aprovado', () => {
  assert.equal(pagouSubscriptionIsRecurring({
    status: 'active',
    paymentMethod: 'pix_automatic',
    interval: 'month',
    metadata: { kind: 'subscription', provider_recurring: { mandate_status: 'approved' } }
  }), true);
  assert.equal(pagouSubscriptionIsRecurring({
    status: 'active',
    paymentMethod: 'pix_automatic',
    interval: 'month',
    metadata: { kind: 'subscription', provider_recurring: { mandate_status: 'pending' } }
  }), false);
  assert.equal(pagouSubscriptionIsRecurring({
    status: 'incomplete',
    paymentMethod: 'credit_card',
    interval: 'month',
    metadata: { kind: 'subscription' }
  }), false);
  assert.equal(pagouSubscriptionIsRecurring({
    status: 'active',
    paymentMethod: 'credit_card',
    interval: 'month',
    metadata: { kind: 'one_shot' }
  }), false);
});

test('buildPagouSubscriberSnapshot nao soma recorrente com o avulso do mesmo e-mail', () => {
  const snapshot = buildPagouSubscriberSnapshot({
    subscriptions: [
      {
        status: 'active',
        customerEmail: 'recorrente@x.com',
        paymentMethod: 'pix_automatic',
        interval: 'month',
        metadata: { kind: 'subscription', provider_recurring: { mandate_status: 'approved' } }
      },
      {
        status: 'active',
        customerEmail: 'pendente@x.com',
        paymentMethod: 'pix_automatic',
        interval: 'month',
        metadata: { kind: 'subscription', provider_recurring: { mandate_status: 'pending' } }
      }
    ],
    transactions: [
      { buyer: { email: 'recorrente@x.com' } },
      { buyer: { email: 'pendente@x.com' } },
      { buyer: { email: 'avulso@x.com' } },
      { buyer: { email: 'AVULSO@x.com' } }
    ]
  });

  assert.deepEqual(snapshot, { count: 3, recurring: 1, prepaid: 2 });
});
