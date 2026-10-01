import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findUnpaidRenewal,
  pickUnpaidRenewal,
  pullBackDueDate,
  unpaidRenewalDueDate
} from '../lib/paddle-unpaid.js';
import { processPaddleEvent } from '../api/webhook-paddle.js';

const renewal = (id, startsAt, status = 'past_due', origin = 'subscription_recurring') => ({
  id,
  status,
  origin,
  billing_period: { starts_at: startsAt, ends_at: null }
});

function harness({ unpaid = null, currentPeriodEnd = '2026-11-01T23:59:59-03:00' } = {}) {
  const updates = [];
  const lookups = [];
  return {
    updates,
    lookups,
    opts: {
      leonaToken: 'leona',
      paddleApiKey: 'paddle',
      guruToken: '',
      findUnpaid: async (subscriptionId) => { lookups.push(subscriptionId); return unpaid; },
      getProfile: async () => ({ current_period_end: currentPeriodEnd }),
      updateProfile: async (accountId, payload) => { updates.push({ accountId, payload }); return { ok: true }; }
    }
  };
}

const subscriptionEvent = (eventType, extra = {}) => ({
  event_type: eventType,
  data: {
    id: 'sub_1',
    status: 'active',
    next_billed_at: '2026-11-01T06:27:00Z',
    items: [{ quantity: 2 }],
    custom_data: { leona_account_id: '10740' },
    ...extra
  }
});

test('pickUnpaidRenewal pega a renovação em aberto mais antiga', () => {
  const picked = pickUnpaidRenewal([
    renewal('txn_out', '2026-10-01T06:27:00Z', 'billed'),
    renewal('txn_set', '2026-09-01T06:27:00Z'),
    renewal('txn_paid', '2026-08-01T06:27:00Z', 'completed'),
    renewal('txn_upgrade', '2026-07-01T06:27:00Z', 'past_due', 'subscription_update')
  ]);
  assert.equal(picked.id, 'txn_set');
  assert.equal(unpaidRenewalDueDate(picked), '2026-09-01');
  assert.equal(pickUnpaidRenewal([renewal('txn_paid', '2026-08-01T00:00:00Z', 'completed')]), null);
});

test('pullBackDueDate nunca empurra o vencimento pra frente', () => {
  assert.equal(pullBackDueDate('2026-11-01T23:59:59-03:00', '2026-10-01'), '2026-10-01');
  assert.equal(pullBackDueDate('2026-09-30T23:59:59-03:00', '2026-10-01'), null);
  assert.equal(pullBackDueDate('2026-10-01T23:59:59-03:00', '2026-10-01'), null);
  assert.equal(pullBackDueDate(null, '2026-10-01'), '2026-10-01');
});

test('findUnpaidRenewal consulta transactions da assinatura e devolve erro sem estourar', async () => {
  let path = null;
  const found = await findUnpaidRenewal('sub_1', {
    token: 'k',
    request: async (p) => { path = p; return { data: [renewal('txn_a', '2026-10-01T06:27:00Z')] }; }
  });
  assert.match(path, /subscription_id=sub_1/);
  assert.match(path, /status=billed%2Cpast_due/);
  assert.equal(found.id, 'txn_a');

  const failed = await findUnpaidRenewal('sub_1', { request: async () => { throw new Error('HTTP 500'); } });
  assert.deepEqual(failed, { error: 'HTTP 500' });
});

test('subscription.updated com renovação não paga puxa o vencimento pro início do período', async () => {
  const h = harness({ unpaid: renewal('txn_x', '2026-10-01T06:27:00Z', 'billed') });
  const r = await processPaddleEvent(subscriptionEvent('subscription.updated'), h.opts);
  assert.deepEqual(h.lookups, ['sub_1']);
  assert.deepEqual(h.updates, [{ accountId: 10740, payload: { starter_instances: 2, due_date: '2026-10-01' } }]);
  assert.equal(r.body.renewal_guard.unpaid_transaction_id, 'txn_x');
});

test('subscription.updated sem renovação em aberto segue next_billed_at', async () => {
  const h = harness({ unpaid: null });
  await processPaddleEvent(subscriptionEvent('subscription.updated'), h.opts);
  assert.deepEqual(h.updates[0].payload, { starter_instances: 2, due_date: '2026-11-01' });
});

test('subscription.updated com falha na Paddle não estende, só qty', async () => {
  const h = harness({ unpaid: { error: 'timeout' } });
  await processPaddleEvent(subscriptionEvent('subscription.updated'), h.opts);
  assert.deepEqual(h.updates[0].payload, { starter_instances: 2 });
});

test('subscription.updated com status past_due e sem renovação achada não estende', async () => {
  const h = harness({ unpaid: null });
  await processPaddleEvent(subscriptionEvent('subscription.updated', { status: 'past_due' }), h.opts);
  assert.deepEqual(h.updates[0].payload, { starter_instances: 2 });
});

test('subscription.past_due puxa o vencimento; se já estiver antes, não mexe', async () => {
  const h = harness({ unpaid: renewal('txn_x', '2026-10-01T06:27:00Z') });
  await processPaddleEvent(subscriptionEvent('subscription.past_due', { status: 'past_due' }), h.opts);
  assert.deepEqual(h.updates[0].payload, { due_date: '2026-10-01' });

  const already = harness({ unpaid: renewal('txn_x', '2026-10-01T06:27:00Z'), currentPeriodEnd: '2026-09-30T23:59:59-03:00' });
  const r = await processPaddleEvent(subscriptionEvent('subscription.past_due', { status: 'past_due' }), already.opts);
  assert.equal(already.updates.length, 0);
  assert.equal(r.body.action, 'log_only');

  const none = harness({ unpaid: null });
  await processPaddleEvent(subscriptionEvent('subscription.past_due', { status: 'past_due' }), none.opts);
  assert.equal(none.updates.length, 0);
});

test('transaction.payment_failed da renovação puxa; de upgrade não mexe', async () => {
  const txn = (origin) => ({
    event_type: 'transaction.payment_failed',
    data: {
      id: 'txn_r',
      origin,
      status: 'past_due',
      subscription_id: 'sub_1',
      billing_period: { starts_at: '2026-10-01T06:27:00Z' },
      custom_data: { leona_account_id: '10740' }
    }
  });
  const h = harness();
  await processPaddleEvent(txn('subscription_recurring'), h.opts);
  assert.deepEqual(h.updates, [{ accountId: 10740, payload: { due_date: '2026-10-01' } }]);

  const upgrade = harness();
  const r = await processPaddleEvent(txn('subscription_update'), upgrade.opts);
  assert.equal(upgrade.updates.length, 0);
  assert.equal(r.body.action, 'noop');
});

test('subscription.resumed com renovação não paga ativa sem estender', async () => {
  const h = harness({ unpaid: renewal('txn_x', '2026-10-01T06:27:00Z', 'billed') });
  await processPaddleEvent(subscriptionEvent('subscription.resumed'), h.opts);
  assert.deepEqual(h.updates[0].payload, { status: 'active', starter_instances: 2, due_date: '2026-10-01' });
});
