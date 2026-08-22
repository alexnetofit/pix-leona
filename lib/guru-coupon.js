/**
 * Cupom Guru de pró-rata no checkout (oferta cheia − valor de hoje).
 * Código sempre começa com up-leona- pra o webhook preservar o ciclo Leona.
 */
import { GURU_BASE, LEONA_GURU_PRODUCT_ID, guruHeaders } from './guru.js';

export const PRORATA_COUPON_PREFIX = 'up-leona-';

export function prorataDiscount(offerValue, payAmount) {
  const offer = Number(offerValue);
  const pay = Number(payAmount);
  if (!Number.isFinite(offer) || !Number.isFinite(pay) || offer <= 0 || pay <= 0) return null;
  const discount = Math.round((offer - pay) * 100) / 100;
  if (discount < 0.5) return null;
  return {
    offer,
    pay,
    discount,
    cents: Math.round(discount * 100),
    code: `${PRORATA_COUPON_PREFIX}v${Math.round(discount * 100)}`
  };
}

async function listActiveCoupons(headers, hasTransactions) {
  const all = [];
  let cursor = null;
  for (let i = 0; i < 8; i++) {
    const u = new URL(`${GURU_BASE}/coupons`);
    u.searchParams.set('limit', '100');
    u.searchParams.set('is_active', '1');
    u.searchParams.set('has_transactions', hasTransactions ? '1' : '0');
    if (cursor) u.searchParams.set('cursor', cursor);
    const r = await fetch(u, { headers });
    if (!r.ok) break;
    const body = await r.json();
    if (Array.isArray(body.data)) all.push(...body.data);
    cursor = body.next_cursor;
    if (!body.has_more_pages || !cursor) break;
  }
  return all;
}

export async function findCouponByCode(code, guruToken) {
  const headers = guruHeaders(guruToken);
  const needle = String(code || '').trim();
  if (!needle) return null;
  for (const used of [false, true]) {
    const rows = await listActiveCoupons(headers, used);
    const found = rows.find((c) => c.coupon_code === needle || c.code === needle);
    if (found) {
      const detail = await fetch(`${GURU_BASE}/coupons/${found.id}`, { headers });
      const body = await detail.json().catch(() => ({}));
      return body.data || body;
    }
  }
  return null;
}

export async function addEmailToCoupon(coupon, email, guruToken) {
  const headers = guruHeaders(guruToken);
  const emailLower = String(email || '').trim().toLowerCase();
  const existing = Array.isArray(coupon.emails) ? coupon.emails : [];
  if (existing.includes(emailLower)) {
    return { ok: true, coupon, added: false };
  }
  const putBody = {
    coupon_code: coupon.coupon_code,
    incidence_type: coupon.incidence_type,
    incidence_field: coupon.incidence_field,
    incidence_value: coupon.incidence_value,
    date_ini: coupon.date_ini,
    date_end: coupon.date_end,
    usage_total: coupon.usage_total || 0,
    usage_contact: coupon.usage_contact || 0,
    maximum_subscription_cycles: coupon.maximum_subscription_cycles || 1,
    is_active: 1,
    validate_by: 'email',
    emails: [...existing, emailLower],
    ...(Array.isArray(coupon.product_ids) && coupon.product_ids.length
      ? { product_ids: coupon.product_ids }
      : {})
  };
  const r = await fetch(`${GURU_BASE}/coupons/${coupon.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(putBody)
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, coupon: body.data || body, added: r.ok, status: r.status, body };
}

export async function createValueCoupon({ code, value, email, guruToken }) {
  const headers = guruHeaders(guruToken);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    coupon_code: code,
    incidence_type: 'value',
    incidence_field: 'total',
    incidence_value: value,
    date_ini: now,
    date_end: 1924905600,
    usage_total: 0,
    usage_contact: 0,
    maximum_subscription_cycles: 1,
    validate_by: 'email',
    emails: [String(email).trim().toLowerCase()],
    is_active: 1,
    product_ids: [LEONA_GURU_PRODUCT_ID]
  };
  let r = await fetch(`${GURU_BASE}/coupons`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  let body = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 201) {
    delete payload.product_ids;
    r = await fetch(`${GURU_BASE}/coupons`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    body = await r.json().catch(() => ({}));
  }
  return { ok: r.ok || r.status === 201, status: r.status, coupon: body.data || body, body };
}

export async function ensureProrataCoupon({ email, offerValue, payAmount, guruToken }) {
  const plan = prorataDiscount(offerValue, payAmount);
  if (!plan) return null;
  const emailLower = String(email || '').trim().toLowerCase();
  if (!emailLower) return null;

  let coupon = await findCouponByCode(plan.code, guruToken);
  if (!coupon?.id) {
    const created = await createValueCoupon({
      code: plan.code,
      value: plan.discount,
      email: emailLower,
      guruToken
    });
    if (!created.ok || !created.coupon?.id) {
      throw new Error(created.body?.message || created.body?.error || 'Guru não criou o cupom de pró-rata');
    }
    coupon = created.coupon;
  } else {
    const added = await addEmailToCoupon(coupon, emailLower, guruToken);
    if (!added.ok) {
      throw new Error(added.body?.message || added.body?.error || 'Guru não liberou o cupom neste e-mail');
    }
    coupon = added.coupon?.id ? added.coupon : coupon;
  }

  return {
    code: coupon.coupon_code || plan.code,
    discount: plan.discount,
    pay: plan.pay,
    offer: plan.offer
  };
}
