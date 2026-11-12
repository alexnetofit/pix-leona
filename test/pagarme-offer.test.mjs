import test from 'node:test';
import assert from 'node:assert/strict';
import { leonaAmountCents } from '../lib/leona-pricing.js';
import {
  CORVO_OFFER,
  buildCorvoOfferPaymentLinkPayload,
  findOfferInParts,
  fulfillCorvoOfferWebhook,
  offerActivationPatch,
  offerAmountCents,
  offerExpiresInMinutes,
  offerItemCode,
  parseOfferItemCode
} from '../lib/pagarme-offer.js';

test('40% em cima do preço de volume, de 1 a 5 conexões', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(offerAmountCents), [7620, 11880, 17820, 18960, 23700]);
  for (const qty of CORVO_OFFER.quantities) {
    assert.equal(offerAmountCents(qty), Math.round(leonaAmountCents(qty) * 0.6));
  }
});

test('código da oferta não parece checkout novo', () => {
  const parsed = parseOfferItemCode(offerItemCode(3));
  assert.equal(parsed.qty, 3);
  assert.equal(parsed.affiliateCode, '48B29E6C');
  assert.equal(parseOfferItemCode('leona-22219-1-sub-20261112-1794513257'), null);
  assert.equal(parseOfferItemCode('offer-corvo40-6-48B29E6C'), null);
});

test('link expira no fim de 12/12 em Brasília e não trava o comprador', () => {
  const before = offerExpiresInMinutes(new Date('2026-11-12T23:00:00Z'));
  assert.ok(before > 60 * 24 * 20);
  assert.equal(offerExpiresInMinutes(new Date('2026-12-13T03:00:00Z')), 1);
  const payload = buildCorvoOfferPaymentLinkPayload({ qty: 1, now: new Date('2026-11-12T23:00:00Z') });
  assert.equal(payload.cart_settings.items[0].amount, 7620);
  assert.equal(payload.order_code, 'offer-corvo40-1-48B29E6C');
  assert.equal(payload.metadata.skip_commission, 'true');
  assert.equal(payload.metadata.affiliate_code, '48B29E6C');
  assert.equal(payload.customer_settings, undefined);
  assert.deepEqual(payload.payment_settings.accepted_payment_methods, ['credit_card', 'pix']);
});

test('ativação vincula o Samuel, não reduz plano e não mexe em outro afiliado', () => {
  const fresh = offerActivationPatch(
    { starter_instances: 0, rewardful_referral: null },
    { qty: 2, affiliateCode: '48B29E6C', dueDate: '2026-12-12' }
  );
  assert.equal(fresh.referral, 'set');
  assert.equal(fresh.commission, 'skipped');
  assert.equal(fresh.patch.affiliate_code, '48B29E6C');
  assert.equal(fresh.patch.starter_instances, 2);
  assert.equal(fresh.patch.due_date, '2026-12-12');

  const bigger = offerActivationPatch(
    { starter_instances: 5, current_period_end: '2027-01-20', rewardful_referral: '48B29E6C' },
    { qty: 1, affiliateCode: '48B29E6C', dueDate: '2026-12-12' }
  );
  assert.equal(bigger.referral, 'already');
  assert.equal(bigger.patch.affiliate_code, undefined);
  assert.equal(bigger.patch.starter_instances, 5);
  assert.equal(bigger.patch.due_date, '2027-01-20');

  const other = offerActivationPatch(
    { starter_instances: 1, rewardful_referral: 'AAAA1111' },
    { qty: 1, affiliateCode: '48B29E6C', dueDate: '2026-12-12' }
  );
  assert.equal(other.referral, 'kept_other');
  assert.equal(other.patch.affiliate_code, undefined);
});

test('pagamento da oferta ativa a conta e não chama comissão', async () => {
  const calls = [];
  const result = await fulfillCorvoOfferWebhook({
    orderId: 'or_offer',
    payload: { type: 'order.paid', data: { id: 'or_offer', code: 'offer-corvo40-2-48B29E6C' } }
  }, {
    getOrder: async () => ({
      ok: true,
      body: {
        id: 'or_offer',
        code: 'offer-corvo40-2-48B29E6C',
        status: 'paid',
        amount: 11880,
        customer: { email: 'cliente@example.com' },
        items: [{ code: 'offer-corvo40-2-48B29E6C', amount: 11880 }]
      }
    }),
    lookupAccounts: async (email) => {
      calls.push(['lookup', email]);
      return { ok: true, profiles: [{ account_id: 99, starter_instances: 0, rewardful_referral: null, user: { email } }] };
    },
    activate: async (input) => {
      calls.push(['activate', input.qty, input.dueDate, input.email]);
      return { ok: true };
    },
    updateProfile: async (id, patch) => {
      calls.push(['referral', id, patch.affiliate_code]);
      return { ok: true, body: { rewardful_referral: patch.affiliate_code } };
    },
    dueDate: '2026-12-12'
  });

  assert.equal(result.processed, true);
  assert.equal(result.commission, 'skipped');
  assert.equal(result.referral, 'set');
  assert.deepEqual(calls, [
    ['lookup', 'cliente@example.com'],
    ['activate', 2, '2026-12-12', 'cliente@example.com'],
    ['referral', '99', '48B29E6C']
  ]);
});

test('pedido que não é da oferta segue o fluxo normal', async () => {
  let fetched = false;
  const result = await fulfillCorvoOfferWebhook({
    orderId: 'or_normal',
    payload: { type: 'order.paid', data: { code: 'leona-22219-1-sub-20261112-1794513257' } }
  }, {
    getOrder: async () => {
      fetched = true;
      return { ok: true, body: {} };
    }
  });
  assert.equal(result.handled, false);
  assert.equal(fetched, false);
});

test('valor diferente do desconto não libera a conta', async () => {
  let activated = false;
  const result = await fulfillCorvoOfferWebhook({
    orderId: 'or_barato',
    payload: { type: 'order.paid', data: { code: 'offer-corvo40-1-48B29E6C' } }
  }, {
    getOrder: async () => ({
      ok: true,
      body: {
        status: 'paid',
        amount: 100,
        code: 'offer-corvo40-1-48B29E6C',
        customer: { email: 'cliente@example.com' }
      }
    }),
    activate: async () => {
      activated = true;
      return { ok: true };
    }
  });
  assert.equal(result.processed, false);
  assert.equal(result.error, 'amount_mismatch');
  assert.equal(activated, false);
});

test('encontra a oferta no item do link', () => {
  const found = findOfferInParts({
    link: { cart_settings: { items: [{ code: 'offer-corvo40-5-48B29E6C' }] } }
  });
  assert.equal(found.qty, 5);
});
