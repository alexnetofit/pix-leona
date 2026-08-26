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
  const legacy = raw.match(/^leona-(\d+)-(\d+)-(prorata|renewal|subscription)-/i);
  if (legacy) {
    return {
      accountId: legacy[1],
      qty: Number(legacy[2]),
      kind: String(legacy[3]).toLowerCase() === 'prorata' ? 'one_shot' : 'subscription'
    };
  }
  return null;
}

export function makeDlocalOrderId(accountId, qty, kind) {
  const tag = isOneShotKind(kind) ? 'prorata' : 'sub';
  return `leona:${accountId}:${qty}:${tag}:${Date.now()}`;
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

export async function createDlocalPayment(payload) {
  return dlocalGoRequest('POST', '/v1/payments', payload);
}

export async function getDlocalPayment(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return dlocalGoRequest('GET', `/v1/payments/${encodeURIComponent(id)}`);
}

export async function listDlocalPlans({ page = 0, size = 50 } = {}) {
  const qs = new URLSearchParams({ page: String(page), size: String(size) });
  return dlocalGoRequest('GET', `/v1/subscription/plan?${qs}`);
}

export async function createDlocalPlan(payload) {
  return dlocalGoRequest('POST', '/v1/subscription/plan', payload);
}

export function planNameForQty(qty) {
  return `${PLAN_PREFIX}${Math.max(1, Number(qty) || 1)}`;
}

export async function ensureDlocalPlan({ qty, amount, notificationUrl, successUrl, backUrl, errorUrl }) {
  const qtyN = Math.max(1, Number(qty) || 1);
  const name = planNameForQty(qtyN);
  const amountN = Number(amount);
  const listed = await listDlocalPlans({ page: 0, size: 100 });
  const rows = Array.isArray(listed.body?.data) ? listed.body.data : [];
  const existing = rows.find((row) => {
    const sameName = String(row.name || '') === name;
    const sameAmount = Number(row.amount) === amountN;
    return sameName && sameAmount && row.active !== false;
  });
  if (existing?.id) {
    return { ok: true, created: false, plan: existing };
  }

  const created = await createDlocalPlan({
    name,
    description: `Leona Flow — ${qtyN} conex${qtyN === 1 ? 'ao' : 'oes'} / mes`,
    country: 'BR',
    currency: 'BRL',
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
