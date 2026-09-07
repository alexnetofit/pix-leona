import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCreateCardPayload,
  buildPagarmeCardContext,
  canShowPagarmeCardButton,
  guruHasActiveValidSub,
  pagarmeOrderLooksLikeLeona,
  pagarmeSubLooksLikeLeona,
  parsePagarmeCardInput,
  sanitizePagarmeCardLog,
  summarizePagarmeCard
} from '../lib/pagarme-card.js';

test('botão só aparece com Leona ativa, sem Guru válida e Pagar.me elegível', () => {
  const pagarme = { can_change_card: true };
  assert.equal(canShowPagarmeCardButton({
    leonaActive: true,
    guruActiveValid: false,
    pagarme
  }), true);
  assert.equal(canShowPagarmeCardButton({
    leonaActive: false,
    guruActiveValid: false,
    pagarme
  }), false);
  assert.equal(canShowPagarmeCardButton({
    leonaActive: true,
    guruActiveValid: true,
    pagarme
  }), false);
  assert.equal(canShowPagarmeCardButton({
    leonaActive: true,
    guruActiveValid: false,
    otherGatewayActive: true,
    pagarme
  }), false);
  assert.equal(canShowPagarmeCardButton({
    leonaActive: true,
    guruActiveValid: false,
    pagarme: { can_change_card: false }
  }), false);
});

test('Guru ativa com ciclo vigente bloqueia a troca', () => {
  assert.equal(guruHasActiveValidSub({
    subscriptions: [{ status: 'active', cycle_end: '2099-01-01' }]
  }, new Date('2026-09-04T12:00:00Z')), true);
  assert.equal(guruHasActiveValidSub({
    subscriptions: [{ status: 'canceled', cycle_end: '2099-01-01' }]
  }, new Date('2026-09-04T12:00:00Z')), false);
  assert.equal(guruHasActiveValidSub({
    subscriptions: [{ status: 'active', cycle_end: '2026-08-01' }]
  }, new Date('2026-09-04T12:00:00Z')), false);
});

test('reconhece pedido e assinatura Leona na Pagar.me', () => {
  assert.equal(pagarmeOrderLooksLikeLeona({ code: 'leona-11761-4-sub' }), true);
  assert.equal(pagarmeOrderLooksLikeLeona({
    code: 'uuid',
    items: [{ description: 'Plano Starter - 3 conexões' }]
  }), true);
  assert.equal(pagarmeOrderLooksLikeLeona({
    code: 'trilha-1',
    items: [{ description: 'Resgate trilha' }]
  }), false);
  assert.equal(pagarmeSubLooksLikeLeona({ code: 'leona-1-sub', status: 'active' }), true);
  assert.equal(pagarmeSubLooksLikeLeona({
    items: [{ description: 'Leona Flow — 4 conexões' }]
  }), true);
});

test('contexto Pagar.me libera troca quando há cobrança Leona e cartão, sem Guru', () => {
  const ctx = buildPagarmeCardContext({
    customer: { id: 'cus_1' },
    cards: [{ status: 'active', last_four_digits: '8586', brand: 'Visa' }],
    subscriptions: [],
    orders: [{
      status: 'paid',
      items: [{ description: 'Plano Starter - 3 conexões' }],
      charges: [{ payment_method: 'credit_card' }]
    }],
    guru: { subscriptions: [{ status: 'canceled' }] }
  });
  assert.equal(ctx.found, true);
  assert.equal(ctx.can_change_card, true);
  assert.equal(ctx.last4, '8586');
  assert.equal(ctx.brand, 'Visa');
  assert.equal(ctx.has_subscription, false);
  assert.equal(ctx.is_pagarme_billing, true);
  assert.equal(ctx.payment_method, 'credit_card');
});

test('contexto Pagar.me bloqueia se a Guru ainda estiver ativa', () => {
  const ctx = buildPagarmeCardContext({
    customer: { id: 'cus_1' },
    cards: [{ last_four_digits: '1111', brand: 'Mastercard' }],
    orders: [{
      status: 'paid',
      items: [{ description: 'Plano Starter - 1 conexão' }],
      charges: [{ payment_method: 'credit_card' }]
    }],
    guru: { subscriptions: [{ status: 'active', cycle_end: '2099-12-01' }] }
  });
  assert.equal(ctx.can_change_card, false);
});

test('pedido só de trilha não libera o botão', () => {
  const ctx = buildPagarmeCardContext({
    customer: { id: 'cus_1' },
    cards: [{ last_four_digits: '2222' }],
    orders: [{
      status: 'paid',
      items: [{ description: 'Resgate trilha' }],
      charges: [{ payment_method: 'credit_card' }]
    }]
  });
  assert.equal(ctx.can_change_card, false);
});

test('parse do cartão e payload nunca vazam no log', () => {
  const card = parsePagarmeCardInput({
    card: { number: '4000000000000010', holder_name: 'ANA', exp: '1230', cvv: '123' }
  });
  assert.equal(card.number, '4000000000000010');
  assert.equal(card.exp_month, 12);
  assert.equal(card.exp_year, 2030);
  const payload = buildCreateCardPayload({ card });
  assert.equal(payload.number, '4000000000000010');
  assert.equal(payload.billing_address.zip_code, '12308301');
  const log = sanitizePagarmeCardLog({ last4: '0010', brand: 'Visa', card, number: card.number, cvv: '123' });
  assert.equal(log.last4, '0010');
  assert.equal(log.number, undefined);
  assert.equal(log.cvv, undefined);
  assert.equal(log.card, undefined);
  assert.deepEqual(summarizePagarmeCard({ last_four_digits: '0010', brand: 'Visa' }), {
    last4: '0010',
    brand: 'Visa',
    exp_month: null,
    exp_year: null
  });
});

test('página da assinatura tem botão de cartão e mantém o upgrade', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const page = readFileSync(join(here, '../public/assinatura.html'), 'utf8');
  assert.match(page, /function showPagarmeCardButton/);
  assert.match(page, /findActiveValidGuruSub\(accountGuru\)/);
  assert.match(page, /pagarme && pagarme\.can_change_card/);
  assert.match(page, /Trocar cartão/);
  assert.match(page, /id="cardChangeModal"/);
  assert.match(page, /\/api\/pagarme-card/);
  assert.match(page, /pagarme_public_key/);
  assert.match(page, /html \+= renderUpgradePanel\(bp, i\);/);
  assert.match(page, /\/api\/pagarme-downgrade/);
  assert.match(page, /function renderPagarmeDowngradeNotice/);
  assert.doesNotMatch(page, /pagarmeCardOnly/);
  assert.doesNotMatch(page, /console\.log\(card/);
});
