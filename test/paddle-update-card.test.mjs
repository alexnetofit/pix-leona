import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findManagedPaddleSubscription,
  pickUpdatePaymentMethodUrl
} from '../lib/paddle-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('pickUpdatePaymentMethodUrl prefere o link da assinatura', () => {
  const url = pickUpdatePaymentMethodUrl({
    urls: {
      general: { overview: 'https://portal.example/overview' },
      subscriptions: [
        { id: 'sub_other', update_subscription_payment_method: 'https://portal.example/other' },
        { id: 'sub_mine', update_subscription_payment_method: 'https://portal.example/card' }
      ]
    }
  }, 'sub_mine');
  assert.equal(url, 'https://portal.example/card');
});

test('pickUpdatePaymentMethodUrl cai no overview se a Paddle não mandar o de cartão', () => {
  const url = pickUpdatePaymentMethodUrl({
    urls: {
      general: { overview: 'https://portal.example/overview' },
      subscriptions: [{ id: 'sub_mine' }]
    }
  }, 'sub_mine');
  assert.equal(url, 'https://portal.example/overview');
});

test('findManagedPaddleSubscription ignora sub de outra conta e pega a ativa', async () => {
  process.env.PADDLE_API_KEY = process.env.PADDLE_API_KEY || 'test-key';
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/customers?email=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: 'ctm_1',
            email: 'milo@example.com',
            custom_data: { leona_account_id: '14893' }
          }]
        }),
        headers: { get: () => null }
      };
    }
    if (href.includes('/subscriptions?customer_id=ctm_1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: 'sub_old',
              status: 'canceled',
              custom_data: { leona_account_id: '14893' }
            },
            {
              id: 'sub_other',
              status: 'active',
              custom_data: { leona_account_id: '999' }
            },
            {
              id: 'sub_ok',
              status: 'active',
              custom_data: { leona_account_id: '14893' }
            }
          ]
        }),
        headers: { get: () => null }
      };
    }
    return { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } };
  };

  const found = await findManagedPaddleSubscription({
    email: 'milo@example.com',
    accountIds: ['14893']
  });
  assert.deepEqual(found, {
    customer_id: 'ctm_1',
    subscription_id: 'sub_ok',
    status: 'active'
  });
});

test('/assinatura e /paddle têm o botão Trocar cartão ligado', () => {
  const assinatura = readFileSync(join(here, '../public/assinatura.html'), 'utf8');
  const paddleNext = readFileSync(join(here, '../public/paddle-next.html'), 'utf8');
  const paddle = readFileSync(join(here, '../public/paddle.html'), 'utf8');
  assert.match(assinatura, /Trocar cartão/);
  assert.match(assinatura, /openPaddleCardUpdate/);
  assert.match(assinatura, /\/api\/paddle-update-card/);
  assert.match(paddleNext, /Trocar cartão/);
  assert.match(paddleNext, /action: 'update_payment_method'/);
  assert.doesNotMatch(paddleNext, /paymentBtn'\)\.classList\.add\('hidden'\)/);
  assert.match(paddle, /Trocar cartão/);
  assert.match(paddle, /openPaymentPortal/);
});
