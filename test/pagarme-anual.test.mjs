import test from 'node:test';
import assert from 'node:assert/strict';
import { leonaAmountCents } from '../lib/leona-pricing.js';
import {
  annualAccessPatch,
  annualAmountCents,
  annualDueDateFrom,
  findAnnualInParts,
  fulfillAnnualWebhook,
  pagarmeSubsToCancel,
  parseAnnualCode,
  pickAnnualAccount,
  renewalKeepsPrepaid
} from '../lib/pagarme-anual.js';

test('anual cobra 10 meses no preço de volume, de 1 a 10', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(annualAmountCents),
    [127000, 198000, 297000, 316000, 395000, 474000, 553000, 632000, 711000, 790000]
  );
  for (let qty = 1; qty <= 10; qty++) {
    assert.equal(annualAmountCents(qty), leonaAmountCents(qty) * 10);
  }
  assert.equal(parseAnnualCode('leona-anual-10m-10').qty, 10);
  assert.equal(parseAnnualCode('leona-anual-10m-11'), null);
  assert.equal(parseAnnualCode('offer-corvo40-1-48B29E6C'), null);
});

test('o ano conta 365 dias a partir do pagamento, no fuso de Brasília', () => {
  assert.equal(annualDueDateFrom('2026-11-23T15:00:00.000Z'), '2027-11-23');
  assert.equal(annualDueDateFrom('2026-11-23T01:30:00.000Z'), '2027-11-22');
});

test('não reduz conexões nem encurta um vencimento maior', () => {
  const kept = annualAccessPatch(
    { starter_instances: 6, current_period_end: '2028-01-15T23:59:59-03:00' },
    { qty: 4, dueDate: '2027-11-23' }
  );
  assert.equal(kept.qty, 6);
  assert.equal(kept.dueDate, '2028-01-15');

  const raised = annualAccessPatch(
    { starter_instances: 2, current_period_end: '2026-12-22T23:59:59-03:00' },
    { qty: 4, dueDate: '2027-11-23' }
  );
  assert.equal(raised.qty, 4);
  assert.equal(raised.dueDate, '2027-11-23');
});

test('renovação mensal não apaga o ano já pago', () => {
  const prepaid = renewalKeepsPrepaid(
    { starter_instances: 4, current_period_end: '2027-11-23T23:59:59-03:00' },
    { qty: 2, dueDate: '2026-12-23' }
  );
  assert.equal(prepaid.prepaid, true);
  assert.equal(prepaid.qty, 4);
  assert.equal(prepaid.dueDate, '2027-11-23');

  const monthly = renewalKeepsPrepaid(
    { starter_instances: 6, current_period_end: '2026-11-23T23:59:59-03:00' },
    { qty: 2, dueDate: '2026-12-23' }
  );
  assert.equal(monthly.prepaid, false);
  assert.equal(monthly.qty, 2);
  assert.equal(monthly.dueDate, '2026-12-23');
});

test('pagamento do link anual libera 365 dias e para a mensalidade Leona', async () => {
  const calls = [];
  const result = await fulfillAnnualWebhook({
    paymentLinkId: 'pl_anual',
    payload: {
      type: 'charge.paid',
      data: {
        id: 'ch_anual',
        code: 'leona-anual-10m-4',
        customer: { email: 'cliente@example.com' }
      }
    }
  }, {
    getPaymentLink: async () => ({
      ok: true,
      body: { order_code: 'leona-anual-10m-4' }
    }),
    listOrdersByCode: async () => ({
      ok: true,
      body: {
        data: [{
          id: 'or_anual',
          status: 'paid',
          code: 'leona-anual-10m-4',
          amount: 316000,
          customer: { email: 'cliente@example.com' },
          charges: [{ id: 'ch_anual', status: 'paid', paid_amount: 316000, paid_at: '2026-11-23T18:00:00.000Z' }]
        }]
      }
    }),
    lookupAccounts: async (email) => {
      calls.push(['lookup', email]);
      return {
        ok: true,
        profiles: [{ account_id: 15906, starter_instances: 2, current_period_end: '2026-12-01', subscription_status: 'active' }]
      };
    },
    activate: async (input) => {
      calls.push(['activate', input.accountId, input.qty, input.dueDate]);
      return { ok: true };
    },
    stopMonthly: async (email) => {
      calls.push(['stop', email]);
      return { cancelled: [{ id: 'sub_mensal', ok: true, status: 200 }] };
    }
  });

  assert.equal(result.processed, true);
  assert.equal(result.account_id, '15906');
  assert.equal(result.qty, 4);
  assert.equal(result.due_date, '2027-11-23');
  assert.equal(result.amount_cents, 316000);
  assert.deepEqual(calls, [
    ['lookup', 'cliente@example.com'],
    ['activate', '15906', 4, '2027-11-23'],
    ['stop', 'cliente@example.com']
  ]);
});

test('valor diferente não libera e pedido comum segue o fluxo', async () => {
  let activated = false;
  const mismatch = await fulfillAnnualWebhook({
    orderId: 'or_barato',
    payload: { type: 'order.paid', data: { code: 'leona-anual-10m-1' } }
  }, {
    getOrder: async () => ({
      ok: true,
      body: {
        status: 'paid',
        amount: 12700,
        code: 'leona-anual-10m-1',
        customer: { email: 'cliente@example.com' }
      }
    }),
    activate: async () => {
      activated = true;
      return { ok: true };
    }
  });
  assert.equal(mismatch.processed, false);
  assert.equal(mismatch.error, 'amount_mismatch');
  assert.equal(activated, false);

  let fetched = false;
  const other = await fulfillAnnualWebhook({
    orderId: 'or_mes',
    payload: { type: 'order.paid', data: { code: 'leona-15906-4-sub-20261123' } }
  }, {
    getOrder: async () => {
      fetched = true;
      return { ok: true, body: {} };
    }
  });
  assert.equal(other.handled, false);
  assert.equal(fetched, false);
});

test('sem conta Leona não cria login e não cancela a mensalidade', async () => {
  const calls = [];
  const result = await fulfillAnnualWebhook({
    orderId: 'or_novo',
    payload: { type: 'order.paid', data: { code: 'leona-anual-10m-1' } }
  }, {
    getOrder: async () => ({
      ok: true,
      body: {
        status: 'paid',
        amount: 127000,
        code: 'leona-anual-10m-1',
        customer: { email: 'novo@example.com' },
        charges: [{ status: 'paid', paid_amount: 127000, paid_at: '2026-11-23T18:00:00.000Z' }]
      }
    }),
    lookupAccounts: async () => ({ ok: true, profiles: [] }),
    activate: async () => {
      calls.push('activate');
      return { ok: true };
    },
    stopMonthly: async () => {
      calls.push('stop');
      return { cancelled: [] };
    }
  });
  assert.equal(result.processed, false);
  assert.equal(result.error, 'no_account');
  assert.deepEqual(calls, []);
  assert.equal(pickAnnualAccount([]).error, 'no_account');
  assert.equal(pickAnnualAccount([
    { account_id: 1, subscription_status: 'active' },
    { account_id: 2, subscription_status: 'canceled' }
  ]).profile.account_id, 1);
});

test('só cancela assinatura Leona ativa', () => {
  const targets = pagarmeSubsToCancel([
    { id: 'sub_leona', status: 'active', code: 'leona-15906-4' },
    { id: 'sub_trilha', status: 'active', code: 'trilha-premio' },
    { id: 'sub_cancelada', status: 'canceled', code: 'leona-1' }
  ]);
  assert.deepEqual(targets.map((sub) => sub.id), ['sub_leona']);
  assert.equal(findAnnualInParts({
    link: { order_code: 'leona-anual-10m-2' }
  }).qty, 2);
});
