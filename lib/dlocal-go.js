const DLOCAL_GO_BASE = 'https://api.dlocalgo.com';
const PLAN_PREFIX = 'leona-starter-';

export function dlocalGoConfigured() {
  return Boolean(
    (process.env.DLOCAL_GO_API_KEY || '').trim() &&
    (process.env.DLOCAL_GO_SECRET_KEY || '').trim()
  );
}

export function dlocalGoPublicBase(req) {
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim();
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  if (host) return `${proto}://${host}`.replace(/\/+$/, '');
  return (process.env.PADDLE_BILLING_BASE_URL || 'https://client.leonaflow.com')
    .replace(/\/+$/, '')
    .replace(/\/paddle$/i, '');
}

export function dlocalGoWebhookUrl(req) {
  return `${dlocalGoPublicBase(req)}/api/webhook-dlocal-go`;
}

function authHeader() {
  const key = (process.env.DLOCAL_GO_API_KEY || '').trim();
  const secret = (process.env.DLOCAL_GO_SECRET_KEY || '').trim();
  return `Bearer ${key}:${secret}`;
}

export async function dlocalGoRequest(method, path, body) {
  const r = await fetch(`${DLOCAL_GO_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body != null ? JSON.stringify(body) : undefined
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: json };
}

export function isOneShotKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return kind === 'one_shot' || kind === 'oneshot' || kind === 'avulso' || kind === 'upgrade' || kind === 'prorata';
}

export function parseDlocalOrderId(value) {
  const raw = String(value || '').trim();
  const leona = raw.match(/^leona:([^:]+):(\d+)(?::([^:]+))?(?::.*)?$/i);
  if (leona) {
    return {
      accountId: leona[1],
      qty: Number(leona[2]),
      kind: leona[3] ? String(leona[3]).toLowerCase() : null
    };
  }
  const dashed = raw.match(/^leona-(.+)-(\d+)-(prorata|sub|renewal|subscription)-(\d+)$/i);
  if (dashed) {
    const tag = String(dashed[3]).toLowerCase();
    return {
      accountId: dashed[1],
      qty: Number(dashed[2]),
      kind: tag === 'prorata' ? 'one_shot' : (tag === 'sub' ? 'sub' : 'subscription')
    };
  }
  return null;
}

export function sanitizeDlocalOrderPart(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '') || 'x';
}

export function makeDlocalOrderId(accountId, qty, kind) {
  const tag = isOneShotKind(kind) ? 'prorata' : 'sub';
  const id = sanitizeDlocalOrderPart(accountId);
  const qtyN = Math.max(1, Number(qty) || 1);
  return `leona-${id}-${qtyN}-${tag}-${Date.now()}`;
}

export function extractDlocalPaymentId(payload = {}, query = {}) {
  const candidates = [
    payload.payment_id,
    payload.paymentId,
    payload.id,
    payload.data?.payment_id,
    payload.data?.id,
    query.payment_id,
    query.id
  ];
  for (const value of candidates) {
    const id = String(value || '').trim();
    if (/^DP-/i.test(id)) return id;
  }
  return null;
}

export function dlocalPaymentPaid(payment = {}) {
  return String(payment.status || '').toUpperCase() === 'PAID';
}

export function dlocalPaymentFailed(payment = {}) {
  return ['REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REFUNDED'].includes(
    String(payment.status || '').toUpperCase()
  );
}

export function dlocalCheckoutPaymentFields() {
  return {
    payment_type: 'CREDIT_CARD,BANK_TRANSFER',
    max_installments: 1
  };
}

export async function createDlocalPayment(payload) {
  return dlocalGoRequest('POST', '/v1/payments', { ...dlocalCheckoutPaymentFields(), ...payload });
}

export async function getDlocalPayment(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return dlocalGoRequest('GET', `/v1/payments/${encodeURIComponent(id)}`);
}

export async function listDlocalPlans({ page = 1, size = 100 } = {}) {
  const qs = new URLSearchParams({ page: String(page || 1), page_size: String(size || 100) });
  return dlocalGoRequest('GET', `/v1/subscription/plan/all?${qs}`);
}

export async function createDlocalPlan(payload) {
  return dlocalGoRequest('POST', '/v1/subscription/plan', payload);
}

export async function updateDlocalPlan(planId, payload) {
  if (!planId) return { ok: false, status: 400, body: {} };
  return dlocalGoRequest('PATCH', `/v1/subscription/plan/${encodeURIComponent(planId)}`, payload);
}

export function planDescriptionForQty(qty) {
  const qtyN = Math.max(1, Number(qty) || 1);
  return `Leona Flow — ${qtyN} conex${qtyN === 1 ? 'ao' : 'oes'} / mes`;
}

export function isIntlRegion(value) {
  const region = String(value || '').trim().toLowerCase();
  return region === 'international' || region === 'intl' || region === 'exterior';
}

export function planNameForQty(qty, currency = 'BRL') {
  const suffix = String(currency || 'BRL').toUpperCase() === 'USD' ? '-usd' : '';
  return `${PLAN_PREFIX}${Math.max(1, Number(qty) || 1)}${suffix}`;
}

export function brlToUsd(amountBrl, usdToBrlRate) {
  const brl = Number(amountBrl);
  const rate = Number(usdToBrlRate);
  if (!Number.isFinite(brl) || brl <= 0 || !Number.isFinite(rate) || rate <= 0) return null;
  return Number((brl / rate).toFixed(2));
}

export function parseUsdToBrlRate(body) {
  const rows = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : [body]);
  for (const row of rows) {
    const from = String(row?.from || row?.from_currency || row?.origin || '').toUpperCase();
    const to = String(row?.to || row?.to_currency || row?.destination || '').toUpperCase();
    const rate = Number(row?.rate || row?.value);
    if (from === 'USD' && to === 'BRL' && Number.isFinite(rate) && rate > 0) return rate;
  }
  const direct = Number(body?.rate || body?.USD_BRL);
  return Number.isFinite(direct) && direct > 0 ? direct : null;
}

export async function getDlocalUsdToBrlRate() {
  const found = await dlocalGoRequest('GET', '/v1/currency-exchanges');
  const rate = parseUsdToBrlRate(found.body);
  if (!found.ok || !rate) {
    return { ok: false, rate: null, status: found.status, body: found.body };
  }
  return { ok: true, rate, status: found.status, body: found.body };
}

export async function ensureDlocalPlan({
  qty,
  amount,
  currency = 'BRL',
  country,
  notificationUrl,
  successUrl,
  backUrl,
  errorUrl
}) {
  const qtyN = Math.max(1, Number(qty) || 1);
  const currencyCode = String(currency || 'BRL').toUpperCase();
  const name = planNameForQty(qtyN, currencyCode);
  const amountN = Number(amount);
  const listed = await listDlocalPlans({ page: 1, size: 100 });
  if (!listed.ok) {
    return { ok: false, created: false, plan: null, status: listed.status, body: listed.body };
  }
  const rows = Array.isArray(listed.body?.data) ? listed.body.data : [];
  const sameCurrency = rows.filter((row) => String(row.currency || '').toUpperCase() === currencyCode);
  const namedActive = sameCurrency.filter((row) => String(row.name || '') === name && row.active !== false);
  const patchFields = {
    name,
    description: planDescriptionForQty(qtyN),
    amount: amountN,
    notification_url: notificationUrl,
    success_url: successUrl,
    back_url: backUrl,
    error_url: errorUrl
  };

  const keep = namedActive.find((row) => Number(row.amount) === amountN)
    || namedActive.slice().sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (keep?.id) {
    if (Number(keep.amount) !== amountN) {
      const updated = await updateDlocalPlan(keep.id, patchFields);
      if (updated.ok && updated.body?.id) {
        return { ok: true, created: false, plan: updated.body };
      }
    }
    return { ok: true, created: false, plan: keep };
  }

  const created = await createDlocalPlan({
    name,
    description: planDescriptionForQty(qtyN),
    ...(country ? { country } : {}),
    currency: currencyCode,
    amount: amountN,
    frequency_type: 'MONTHLY',
    frequency_value: 1,
    notification_url: notificationUrl,
    success_url: successUrl,
    back_url: backUrl,
    error_url: errorUrl
  });
  const plan = created.body || {};
  if (!created.ok || !plan.id) {
    return { ok: false, created: false, plan: null, status: created.status, body: created.body };
  }
  return { ok: true, created: true, plan };
}

export function subscribeUrlWithPayer(subscribeUrl, { email, accountId, qty } = {}) {
  if (!subscribeUrl) return null;
  const url = new URL(subscribeUrl);
  if (email) url.searchParams.set('email', email);
  if (accountId && qty) url.searchParams.set('external_id', `leona:${accountId}:${qty}`);
  return url.toString();
}
