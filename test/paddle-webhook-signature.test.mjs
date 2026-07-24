import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifyPaddleWebhookSignature } from '../api/webhook-paddle-ledger.js';

const SECRET = 'pdl_ntfset_test_secret';
const RAW = '{"event_id":"evt_1"}';
const NOW = Date.parse('2026-07-23T15:00:00Z');
const TS = Math.floor(NOW / 1000);

function signature(raw = RAW, timestamp = TS) {
  return createHmac('sha256', SECRET)
    .update(`${timestamp}:${raw}`)
    .digest('hex');
}

test('aceita assinatura Paddle válida dentro da tolerância', () => {
  assert.equal(
    verifyPaddleWebhookSignature(RAW, `ts=${TS};h1=${signature()}`, SECRET, NOW),
    true
  );
});

test('rejeita corpo adulterado e assinatura expirada', () => {
  assert.equal(
    verifyPaddleWebhookSignature(`${RAW} `, `ts=${TS};h1=${signature()}`, SECRET, NOW),
    false
  );
  const oldTs = TS - 301;
  assert.equal(
    verifyPaddleWebhookSignature(
      RAW,
      `ts=${oldTs};h1=${signature(RAW, oldTs)}`,
      SECRET,
      NOW
    ),
    false
  );
});

test('aceita qualquer h1 válida durante rotação de segredo', () => {
  assert.equal(
    verifyPaddleWebhookSignature(
      RAW,
      `ts=${TS};h1=invalid;h1=${signature()}`,
      SECRET,
      NOW
    ),
    true
  );
});
