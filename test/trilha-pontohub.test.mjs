import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPontohubFulfillmentLines } from '../lib/trilha-pontohub.js';
import { buildPontohubPlayer } from '../lib/pontohub.js';
import { extractPagarmePaymentLinkId } from '../lib/pagarme.js';
import { paymentLinkLooksPaid } from '../lib/trilha-fulfill.js';

test('placa 100k usa só productId e productName, sem linkId', () => {
  const lines = buildPontohubFulfillmentLines({ prizeId: '100k', extraQty: 1, bumps: { jaqueta: 1, garrafa: 2 } });
  assert.equal(lines[0].productName, 'Placa Trilha do Predador + Pin 100k + Carta + Box');
  assert.equal(lines[0].productId, 'c24fc253-90e6-40bf-a843-d42d07653bf9');
  assert.equal(lines[0].linkId, undefined);
  assert.equal(lines[1].productName, lines[0].productName);
  assert.equal(lines.filter((l) => l.code === 'garrafa').length, 2);
  assert.equal(lines.find((l) => l.code === 'jaqueta').productId, '3089dcef-dfff-488e-af0c-9bd4f6d55102');
});

test('pins compartilham productId e mandam productName distinto', () => {
  const pin250 = buildPontohubFulfillmentLines({ prizeId: '250k' })[0];
  const pin1m = buildPontohubFulfillmentLines({ prizeId: '1m' })[0];
  assert.equal(pin250.productId, pin1m.productId);
  assert.equal(pin250.productName, 'Premiação - Pin 250k + Carta');
  assert.equal(pin1m.productName, 'Premiação - Pin 1M + Carta');
});

test('player monta endereço via CEP + texto livre', () => {
  const player = buildPontohubPlayer({
    name: 'Maria',
    email: 'maria@leona.com',
    document: '529.982.247-25',
    phone: '(12) 98888-7777',
    cep: '12240-460',
    address: 'Rua das Flores 120, apto 3'
  }, { logradouro: 'Rua das Flores', bairro: 'Centro', localidade: 'Jacarei', uf: 'SP' });
  assert.equal(player.document, '52998224725');
  assert.equal(player.phone, '12988887777');
  assert.equal(player.address.city, 'Jacarei');
  assert.equal(player.address.number, '120');
});

test('extrai pl_ do webhook da Pagar.me', () => {
  assert.equal(extractPagarmePaymentLinkId({ data: { id: 'pl_abc' } }), 'pl_abc');
  assert.equal(extractPagarmePaymentLinkId({ id: 'or_xxx' }), null);
  assert.equal(paymentLinkLooksPaid({ total_paid_sessions: 1 }), true);
  assert.equal(paymentLinkLooksPaid({ status: 'active', total_paid_sessions: 0 }), false);
});
