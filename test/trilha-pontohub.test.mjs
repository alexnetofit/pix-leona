import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPontohubFulfillmentLines } from '../lib/trilha-pontohub.js';
import { buildPontohubPlayer } from '../lib/pontohub.js';
import {
  extractPagarmePaymentLinkId,
  extractPagarmePayer,
  pagarmePayerHasAddress,
  pagarmeWebhookLooksPaid
} from '../lib/pagarme.js';
import { mergeTrilhaPayer, paymentLinkLooksAbandoned, paymentLinkLooksPaid } from '../lib/trilha-fulfill.js';

test('kit 50k usa o produto novo com pin', () => {
  const line = buildPontohubFulfillmentLines({ prizeId: '50k' })[0];
  assert.equal(line.productId, '04acfa25-03ee-45d3-8c08-fe1ad2639537');
  assert.equal(line.productName, 'Kit Pulseira Leona + Carta + Envelope + Pin 50k');
});

test('placa 100k usa só productId e productName, sem linkId', () => {
  const lines = buildPontohubFulfillmentLines({ prizeId: '100k', extraQty: 1, bumps: { jaqueta: 1, garrafa: 2 } });
  assert.equal(lines[0].productName, 'Placa Trilha do Predador + Pin 100k + Carta + Box');
  assert.equal(lines[0].productId, 'c24fc253-90e6-40bf-a843-d42d07653bf9');
  assert.equal(lines[0].linkId, undefined);
  assert.equal(lines[1].productName, lines[0].productName);
  assert.equal(lines.filter((l) => l.code === 'garrafa').length, 2);
  assert.equal(lines.find((l) => l.code === 'jaqueta').productId, '3089dcef-dfff-488e-af0c-9bd4f6d55102');
});

test('carrinho manda todos os prêmios e bumps numa leva', () => {
  const lines = buildPontohubFulfillmentLines({
    prizes: { '50k': { extra: 0 }, '100k': { extra: 1 }, '250k': { extra: 0 } },
    bumps: { garrafa: 1 }
  });
  assert.equal(lines.filter((l) => l.code === '50k').length, 1);
  assert.equal(lines.filter((l) => l.code === '100k').length, 2);
  assert.equal(lines.filter((l) => l.code === '250k').length, 1);
  assert.equal(lines.filter((l) => l.code === 'garrafa').length, 1);
});

test('pins compartilham productId e mandam productName distinto', () => {
  const pin250 = buildPontohubFulfillmentLines({ prizeId: '250k' })[0];
  const pin1m = buildPontohubFulfillmentLines({ prizeId: '1m' })[0];
  assert.equal(pin250.productId, pin1m.productId);
  assert.equal(pin250.productName, 'Premiação - Pin 250k + Carta');
  assert.equal(pin1m.productName, 'Premiação - Pin 1M + Carta');
});

test('player monta endereço pelos campos separados', () => {
  const player = buildPontohubPlayer({
    name: 'Maria',
    email: 'maria@leona.com',
    document: '529.982.247-25',
    phone: '(12) 98888-7777',
    cep: '12306-753',
    street: 'Rua Antônio Jordão Mercadante',
    number: '120',
    complement: 'Apto 3',
    neighborhood: 'Jardim Altos de Santana II',
    city: 'Jacareí',
    state: 'sp'
  });
  assert.equal(player.document, '52998224725');
  assert.equal(player.phone, '12988887777');
  assert.equal(player.address.street, 'Rua Antônio Jordão Mercadante');
  assert.equal(player.address.number, '120');
  assert.equal(player.address.complement, 'Apto 3');
  assert.equal(player.address.city, 'Jacareí');
  assert.equal(player.address.state, 'SP');
});

test('extrai pl_ do webhook da Pagar.me', () => {
  assert.equal(extractPagarmePaymentLinkId({ data: { id: 'pl_abc' } }), 'pl_abc');
  assert.equal(extractPagarmePaymentLinkId({ data: { id: 'or_xxx', payment_link: { id: 'pl_from_order' } } }), 'pl_from_order');
  assert.equal(extractPagarmePaymentLinkId({ id: 'or_xxx' }), null);
  assert.equal(pagarmeWebhookLooksPaid({ type: 'order.paid' }), true);
  assert.equal(pagarmeWebhookLooksPaid({ type: 'order.created' }), false);
  assert.equal(paymentLinkLooksPaid({ total_paid_sessions: 1 }), true);
  assert.equal(paymentLinkLooksPaid({ status: 'active', total_paid_sessions: 0 }), false);
  assert.equal(paymentLinkLooksAbandoned({ status: 'expired', total_paid_sessions: 0 }), true);
  assert.equal(paymentLinkLooksAbandoned({ status: 'finished', total_paid_sessions: 1 }), false);
});

test('extrai cliente e endereço do order.paid da Pagar.me', () => {
  const payer = extractPagarmePayer({
    type: 'order.paid',
    data: {
      id: 'or_abc',
      customer: {
        name: 'Alex Alvarez Neto',
        email: 'gabrielgouvea59@gmail.com',
        document: '14472663740',
        phones: { mobile_phone: { country_code: '55', area_code: '12', number: '991426510' } },
        address: {
          zip_code: '12306753',
          city: 'Jacareí',
          state: 'SP',
          line_1: '103, Rua Antônio Jordão Mercadante, Jardim Altos de Santana II'
        }
      }
    }
  });
  assert.equal(payer.document, '14472663740');
  assert.equal(payer.phone, '12991426510');
  assert.equal(payer.cep, '12306753');
  assert.equal(payer.shipping.street, 'Rua Antônio Jordão Mercadante');
  assert.equal(payer.shipping.number, '103');
  assert.equal(payer.shipping.neighborhood, 'Jardim Altos de Santana II');
  assert.equal(pagarmePayerHasAddress(payer), true);

  const merged = mergeTrilhaPayer({ name: 'Conta Demo', email: 'teste123@gmail.com' }, payer);
  assert.equal(merged.cep, '12306753');
  assert.equal(merged.pontohub.shipping.city, 'Jacareí');
  assert.equal(pagarmePayerHasAddress(merged), true);
});
