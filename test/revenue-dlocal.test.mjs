import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDlocalSubscriberSnapshot,
  dlocalGrossBrlCents,
  dlocalNetBrlCents,
  isDlocalOneShotPayment,
  isDlocalSubActive
} from '../lib/revenue-source.js';

test('dlocalGrossBrlCents usa o BRL do cliente, nao o USD do settlement', () => {
  assert.equal(dlocalGrossBrlCents({
    amount: 127,
    currency: 'BRL',
    balance_amount: 21.83,
    balance_currency: 'USD'
  }), 12700);
  assert.equal(dlocalGrossBrlCents({
    amount: 22.63,
    currency: 'USD'
  }, 5.61143), Math.round(22.63 * 5.61143 * 100));
  assert.equal(dlocalGrossBrlCents({ amount: 22.63, currency: 'USD' }), 0);
});

test('dlocalNetBrlCents escala o USD pelo cambio implicito da venda', () => {
  assert.equal(dlocalNetBrlCents({
    amount: 127,
    currency: 'BRL',
    balance_amount: 21.83,
    balance_fee: 0.8,
    balance_currency: 'USD'
  }), Math.round(12700 * 21.83 / 22.63));
  assert.equal(dlocalNetBrlCents({
    amount: 100,
    currency: 'BRL',
    balance_amount: 94.2,
    balance_currency: 'BRL'
  }), 9420);
});

test('avulso e cobranca de assinatura nao se misturam', () => {
  assert.equal(isDlocalOneShotPayment({
    order_id: 'leona-12534-6-prorata-1787712323006'
  }), true);
  assert.equal(isDlocalOneShotPayment({
    order_id: 'ST-ttl8I64FJT10Irhx0u1mYs6ZpoekCTmi-0',
    description: 'leona-starter-1'
  }), false);
  assert.equal(isDlocalOneShotPayment({
    order_id: 'leona-14221-1-sub-1787712323006'
  }), false);
});

test('assinatura ativa so conta CONFIRMED/ACTIVE sem cancelamento', () => {
  assert.equal(isDlocalSubActive({ status: 'CONFIRMED', active: true, client_email: 'a@x.com' }), true);
  assert.equal(isDlocalSubActive({ status: 'CONFIRMED', active: false }), false);
  assert.equal(isDlocalSubActive({ status: 'CREATED', active: false }), false);
  assert.equal(isDlocalSubActive({ status: 'CANCELLED', active: true }), false);
});

test('snapshot soma assinatura + avulso 30d sem duplicar o mesmo e-mail', () => {
  const snapshot = buildDlocalSubscriberSnapshot({
    subscriptions: [
      { status: 'CONFIRMED', active: true, client_email: 'recorrente@x.com' },
      { status: 'CONFIRMED', active: false, client_email: 'cancelado@x.com' },
      { status: 'CREATED', client_email: 'pendente@x.com' }
    ],
    payments: [
      { status: 'PAID', order_id: 'leona-1-3-prorata-1', payer: { email: 'avulso@x.com' } },
      { status: 'PAID', order_id: 'leona-1-3-prorata-2', payer: { email: 'AVULSO@x.com' } },
      { status: 'PAID', order_id: 'leona-9-1-prorata-3', payer: { email: 'recorrente@x.com' } },
      { status: 'PAID', order_id: 'ST-abc-0', description: 'leona-starter-1', payer: { email: 'subpay@x.com' } },
      { status: 'PENDING', order_id: 'leona-2-1-prorata-4', payer: { email: 'ainda-nao@x.com' } }
    ]
  });

  assert.deepEqual(snapshot, {
    count: 2,
    recurring: 1,
    prepaid: 1,
    emails: ['recorrente@x.com', 'avulso@x.com']
  });
});
