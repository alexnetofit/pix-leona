import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldCancelLegacyAfterPayment } from '../lib/activate-after-payment.js';
import { paddleEventTouchesLeona } from '../api/webhook-paddle.js';

test('pró-rata no ciclo aberto não cancela Paddle/Guru', () => {
  assert.equal(shouldCancelLegacyAfterPayment({ keepCycle: true }), false);
  assert.equal(shouldCancelLegacyAfterPayment({ keepCycle: false }), true);
  assert.equal(shouldCancelLegacyAfterPayment({}), true);
});

test('cancelamento Paddle não mexe no Leona', () => {
  assert.equal(paddleEventTouchesLeona('subscription.canceled'), false);
  assert.equal(paddleEventTouchesLeona('transaction.completed'), true);
  assert.equal(paddleEventTouchesLeona('subscription.activated'), true);
  assert.equal(paddleEventTouchesLeona('subscription.updated'), true);
});
