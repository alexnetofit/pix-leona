import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractContactPhones,
  extractInstances,
  extractProductId,
  extractSrc,
  summarizeGuruWebhook
} from '../lib/guru-webhook-payload.js';

test('extractSrc lê source.source (formato do webhook Guru 2026)', () => {
  assert.equal(extractSrc({ source: { source: '14866' } }), '14866');
});

test('extractSrc lê trackings.source (formato da API Guru)', () => {
  assert.equal(extractSrc({ trackings: { source: '11498' } }), '11498');
});

test('extractSrc aceita source como string', () => {
  assert.equal(extractSrc({ source: '8652' }), '8652');
});

test('extractSrc vazio no upgrade sem checkout', () => {
  assert.equal(extractSrc({
    webhook_type: 'transaction',
    invoice: { type: 'upgrade' },
    contact: { email: 'olacontato007@gmail.com' }
  }), null);
});

test('extractInstances lê o plano Starter', () => {
  assert.equal(extractInstances('Plano Starter - 1 conexão'), 1);
  assert.equal(extractInstances('Plano Starter - 2 conexões'), 2);
  assert.equal(extractInstances('Outro produto'), null);
});

test('extractProductId prefere internal_id', () => {
  assert.equal(extractProductId({
    product: { id: '1775995057', internal_id: 'a1869b83-b28d-4257-a986-1df94558a152' }
  }), 'a1869b83-b28d-4257-a986-1df94558a152');
});

test('extractContactPhones gera o nacional que a Leona aceita', () => {
  const phones = extractContactPhones({
    contact: { phone_number: '11917975606', phone_local_code: '55' }
  });
  assert.ok(phones.includes('11917975606'));
  assert.ok(phones.includes('+11917975606'));
});

test('extractContactPhones remove DDI 55 se vier colado', () => {
  const phones = extractContactPhones({
    contact: { phone_number: '5511917975606', phone_local_code: '55' }
  });
  assert.ok(phones.includes('11917975606'));
});

test('summarizeGuruWebhook não inclui token nem cartão', () => {
  const summary = summarizeGuruWebhook({
    api_token: 'secret',
    webhook_type: 'transaction',
    status: 'approved',
    source: { source: '14866' },
    contact: { email: 'a@b.com' },
    payment: { credit_card: { number: '4111' } }
  });
  assert.equal(summary.src, '14866');
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  assert.equal(JSON.stringify(summary).includes('4111'), false);
});
