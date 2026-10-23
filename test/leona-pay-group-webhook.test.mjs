import test from 'node:test';
import assert from 'node:assert/strict';
import { leonaPayWebhookRecord } from '../lib/leona-pay-group-webhook.js';

test('guarda o corpo inteiro e acha e-mail solto ou aninhado', () => {
  const flat = leonaPayWebhookRecord(
    { name: 'Ana', phone: '12999999999', email: 'Ana@Example.com', extra: 1 },
    { contentType: 'application/json', query: { src: 'test' } }
  );
  assert.equal(flat.action, 'leona_pay_group_webhook');
  assert.equal(flat.provider, 'leona-pay');
  assert.equal(flat.email, 'ana@example.com');
  assert.equal(flat.details.body.phone, '12999999999');
  assert.equal(flat.details.body.extra, 1);
  assert.equal(flat.details.query.src, 'test');

  const nested = leonaPayWebhookRecord({ lead: { email: 'lead@x.com', nome: 'Leo' } });
  assert.equal(nested.email, 'lead@x.com');
  assert.equal(nested.details.body.lead.nome, 'Leo');

  const approved = leonaPayWebhookRecord({
    event: 'business.approved',
    owner: { name: 'Ana Souza', email: 'Ana@Loja.com' }
  }, { group: { name: 'Ana Souza - Leona Pay' } });
  assert.equal(approved.email, 'ana@loja.com');
  assert.equal(approved.details.group.name, 'Ana Souza - Leona Pay');
});

test('corpo que não é objeto vai em raw', () => {
  const row = leonaPayWebhookRecord('nome=Ana');
  assert.equal(row.email, null);
  assert.equal(row.details.body.raw, 'nome=Ana');
});
