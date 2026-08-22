import test from 'node:test';
import assert from 'node:assert/strict';

import { prorataDiscount, PRORATA_COUPON_PREFIX } from '../lib/guru-coupon.js';

test('198 → 71 vira cupom de R$ 127 e prefixo up-leona-', () => {
  const plan = prorataDiscount(198, 71);
  assert.equal(plan.discount, 127);
  assert.equal(plan.cents, 12700);
  assert.equal(plan.code, `${PRORATA_COUPON_PREFIX}v12700`);
  assert.equal(plan.pay, 71);
});

test('mesmo valor da oferta não gera cupom', () => {
  assert.equal(prorataDiscount(198, 198), null);
  assert.equal(prorataDiscount(198, 0), null);
});
