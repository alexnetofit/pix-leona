import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPaddleLeonaTransaction,
  paddleSaleBrlCents
} from '../lib/revenue-source.js';

const PTAX = 5.1161;

function copSale({ refunded = false } = {}) {
  return {
    currency_code: 'COP',
    custom_data: {
      account_id: '12350',
      leona_billing: true,
      leona_order_code: 'leona-12350-1-pro-rata-20260922-1790126559'
    },
    items: [{ price: { name: 'Leona Instances' } }],
    details: {
      totals: {
        currency_code: 'COP',
        grand_total: '3865071',
        earnings: '2894456'
      },
      adjusted_totals: {
        currency_code: 'COP',
        grand_total: refunded ? '0' : '3865071',
        earnings: refunded ? '0' : '2894456'
      },
      payout_totals: {
        currency_code: 'USD',
        grand_total: '1170',
        earnings: '876'
      }
    }
  };
}

test('checkout novo da Paddle entra mesmo sem o preco antigo', () => {
  assert.equal(isPaddleLeonaTransaction(copSale()), true);
  assert.equal(isPaddleLeonaTransaction({
    items: [{ product: { name: 'Leona Flow' } }]
  }), true);
  assert.equal(isPaddleLeonaTransaction({
    custom_data: { account_id: '12350' },
    items: [{ product: { name: 'Outro produto' } }]
  }), false);
});

test('venda em real continua no total cobrado', () => {
  assert.deepEqual(paddleSaleBrlCents({
    currency_code: 'BRL',
    details: {
      totals: { currency_code: 'BRL', grand_total: '12700', earnings: '11000' }
    }
  }), {
    gross: 12700,
    net: 11000,
    refundGross: 0,
    refundNet: 0
  });
});

test('peso colombiano vira real pelo payout em dolar e o PTAX', () => {
  const kept = paddleSaleBrlCents(copSale(), PTAX);
  assert.equal(kept.gross, Math.round(1170 * PTAX));
  assert.equal(kept.net, Math.round(876 * PTAX));
  assert.equal(kept.refundGross, 0);

  const refunded = paddleSaleBrlCents(copSale({ refunded: true }), PTAX);
  assert.equal(refunded.gross, kept.gross);
  assert.equal(refunded.refundGross, kept.gross);
  assert.equal(refunded.refundNet, kept.net);
});

test('moeda estrangeira sem cambio nao inventa real', () => {
  assert.equal(paddleSaleBrlCents(copSale(), null), null);
});
