import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAffiliatesPagouPayload } from '../lib/notify-affiliates.js';
import {
  newCheckoutContact,
  newCheckoutPaddleGrossCents,
  newCheckoutTxId,
  notifyNewCheckoutSale,
  notifyPagarmeNewCheckoutFromWebhook,
  notifyPaddleNewCheckoutEvent,
  paddleFullyReversed,
  pagarmeNewCheckoutAffiliateStatus,
  parseNewLeonaOrderCode
} from '../lib/affiliates-new-checkout.js';

test('só o código novo entra na comissão', () => {
  const parsed = parseNewLeonaOrderCode('leona-5062-10-sub-20260922-1790123456');
  assert.equal(parsed.accountId, '5062');
  assert.equal(parsed.qty, 10);
  assert.equal(parsed.kind, 'sub');
  assert.equal(parseNewLeonaOrderCode('leona-839-1-pro-rata-20260922-1790000000')?.kind, 'pro-rata');
  assert.equal(parseNewLeonaOrderCode('leona-22-1-sub'), null);
  assert.equal(parseNewLeonaOrderCode('leona-22-1-prorata'), null);
  assert.equal(parseNewLeonaOrderCode('a2cf57a3-1111-2222-3333-444444444444'), null);
});

test('id da Pagarme ganha pagou: e o da Paddle permanece paddle:', () => {
  process.env.GURU_WEBHOOK_API_TOKEN = 'test-token';
  const pagarme = buildAffiliatesPagouPayload({
    txId: newCheckoutTxId('pagarme', 'or_VXlGzwhoJIP4je1Z'),
    email: 'Dono@Leona.com',
    amountCents: 79000
  });
  assert.equal(pagarme.id, 'pagou:pagarme:or_VXlGzwhoJIP4je1Z');
  assert.equal(pagarme.payment.total, 790);

  const paddle = buildAffiliatesPagouPayload({
    txId: newCheckoutTxId('paddle', 'txn_01m35xq4mwp5snc4me9kp9agp6'),
    email: 'dono@leona.com',
    amountCents: 5986
  });
  assert.equal(paddle.id, 'paddle:txn_01m35xq4mwp5snc4me9kp9agp6');
  assert.equal(paddle.payment.total, 59.86);
});

test('e-mail do dono da conta vence o e-mail do cartão', () => {
  const contact = newCheckoutContact(
    { user: { email: 'Dono@Leona.com', name: 'Dono' } },
    { email: 'cartao@paddle.com', name: 'Cartão' }
  );
  assert.equal(contact.email, 'dono@leona.com');
  assert.equal(contact.name, 'Dono');
});

test('webhook Pagarme do checkout novo avisa e o código antigo não', async () => {
  const calls = [];
  const notify = async (args) => {
    calls.push(args);
    return { ok: true, http: 200, body: { status: 'processed' } };
  };
  const getProfile = async () => ({ user: { email: 'dono@leona.com', name: 'Dono' } });

  const paid = await notifyPagarmeNewCheckoutFromWebhook({
    payload: {
      type: 'order.paid',
      data: {
        id: 'or_novo',
        code: 'leona-5062-10-sub-20260922-1790123456',
        status: 'paid',
        amount: 79000,
        customer: { email: 'pagador@outro.com', name: 'Pagador' },
        charges: [{ paid_amount: 79000, paid_at: '2026-09-22T22:22:00.000Z' }]
      }
    },
    getProfile,
    notify
  });
  assert.equal(paid.handled, true);
  assert.equal(calls[0].txId, 'pagarme:or_novo');
  assert.equal(calls[0].email, 'dono@leona.com');
  assert.equal(calls[0].amountCents, 79000);
  assert.equal(calls[0].status, 'approved');

  const old = await notifyPagarmeNewCheckoutFromWebhook({
    payload: { type: 'order.paid', data: { id: 'or_velho', code: 'leona-22-1-sub', status: 'paid', amount: 12700 } },
    getProfile,
    notify
  });
  assert.equal(old.handled, false);
  assert.equal(calls.length, 1);
});

test('estorno Pagarme do checkout novo reusa o mesmo id', async () => {
  const calls = [];
  const result = await notifyPagarmeNewCheckoutFromWebhook({
    payload: {
      type: 'charge.refunded',
      data: {
        id: 'ch_1',
        status: 'refunded',
        paid_amount: 12700,
        order: { id: 'or_novo', code: 'leona-14196-1-sub-20260922-1790000001' }
      }
    },
    getProfile: async () => ({ user: { email: 'if.sadovik@gmail.com', name: 'Sadovik' } }),
    notify: async (args) => {
      calls.push(args);
      return { ok: true, http: 200, body: { status: 'refund_processed' } };
    }
  });
  assert.equal(pagarmeNewCheckoutAffiliateStatus({ type: 'charge.refunded', data: { status: 'refunded' } }), 'refunded');
  assert.equal(result.handled, true);
  assert.equal(calls[0].txId, 'pagarme:or_novo');
  assert.equal(calls[0].status, 'refunded');
});

test('Paddle em COP vira BRL pelo payout e o estorno integral reverte', async () => {
  const cop = {
    id: 'txn_cop',
    billed_at: '2026-09-22T22:27:00.000Z',
    currency_code: 'COP',
    details: {
      totals: { currency_code: 'COP', grand_total: '3865071', earnings: '2898803' },
      payout_totals: { currency_code: 'USD', grand_total: '1170', earnings: '876' }
    }
  };
  assert.equal(newCheckoutPaddleGrossCents(cop, 5.1161), Math.round(1170 * 5.1161));

  const transaction = {
    id: 'txn_cop',
    billed_at: '2026-09-22T22:27:00.000Z',
    custom_data: { leona_order_code: 'leona-12350-1-pro-rata-20260922-1790126559', account_id: '12350' },
    currency_code: 'BRL',
    details: {
      totals: { currency_code: 'BRL', grand_total: '5986', earnings: '4482' }
    }
  };
  const calls = [];
  const approved = await notifyPaddleNewCheckoutEvent({
    event_type: 'transaction.completed',
    data: transaction
  }, {
    getProfile: async () => ({ user: { email: 'glmdigiital@gmail.com', name: 'GLM' } }),
    notify: async (args) => {
      calls.push(args);
      return { ok: true, http: 200, body: { status: 'processed' } };
    }
  });
  assert.equal(approved.handled, true);
  assert.equal(calls[0].txId, 'paddle:txn_cop');
  assert.equal(calls[0].email, 'glmdigiital@gmail.com');
  assert.equal(calls[0].amountCents, 5986);

  const refundedTxn = {
    ...transaction,
    details: {
      ...transaction.details,
      adjusted_totals: { grand_total: '0', earnings: '0' }
    }
  };
  assert.equal(paddleFullyReversed(refundedTxn), true);
  const refunded = await notifyPaddleNewCheckoutEvent({
    event_type: 'adjustment.updated',
    data: { action: 'refund', status: 'approved', transaction_id: 'txn_cop', totals: { total: '3865071' } }
  }, {
    getTransaction: async () => refundedTxn,
    getProfile: async () => ({ user: { email: 'glmdigiital@gmail.com', name: 'GLM' } }),
    notify: async (args) => {
      calls.push(args);
      return { ok: true, http: 200, body: { status: 'refund_processed' } };
    }
  });
  assert.equal(refunded.handled, true);
  assert.equal(calls[1].status, 'refunded');
  assert.equal(calls[1].txId, 'paddle:txn_cop');
});

test('venda Paddle sem código novo não avisa', async () => {
  const result = await notifyPaddleNewCheckoutEvent({
    event_type: 'transaction.completed',
    data: { id: 'txn_old', custom_data: { leona_account_id: '22' }, details: { totals: { grand_total: '12700', currency_code: 'BRL' } } }
  }, {
    notify: async () => {
      throw new Error('não deveria avisar');
    }
  });
  assert.equal(result.handled, false);
});

test('venda aprovada sem valor não chama o painel', async () => {
  const result = await notifyNewCheckoutSale({
    gateway: 'pagarme',
    externalId: 'or_x',
    email: 'a@b.com',
    amountCents: 0,
    status: 'approved',
    notify: async () => {
      throw new Error('não deveria avisar');
    }
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_amount');
});
