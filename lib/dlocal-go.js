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

export function dlocalGoReturnUrl(req) {
  return `${dlocalGoPublicBase(req)}/api/dlocal-go-return`;
}

export function dlocalGoAppUrl() {
  return (process.env.LEONA_APP_URL || 'https://app.leonaflow.com').replace(/\/+$/, '');
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

export function qtyFromDlocalPlanName(name) {
  const m = String(name || '').match(/leona-starter-(\d+)/i);
  return m ? Number(m[1]) : null;
}

export async function listDlocalPayments({ email, startDate, endDate, page = 0, size = 20 } = {}) {
  const qs = new URLSearchParams({
    page: String(page || 0),
    size: String(Math.min(20, Number(size) || 20))
  });
  if (email) qs.set('client_email', String(email).trim());
  if (startDate) qs.set('start_date', startDate);
  if (endDate) qs.set('end_date', endDate);
  return dlocalGoRequest('GET', `/v1/payments?${qs}`);
}

export async function listAllDlocalPayments({ email, startDate, endDate, maxPages = 80 } = {}) {
  const rows = [];
  let pages = 0;
  for (let page = 0; page < maxPages; page++) {
    const found = await listDlocalPayments({ email, startDate, endDate, page, size: 20 });
    pages++;
    const batch = Array.isArray(found.body?.data) ? found.body.data : [];
    rows.push(...batch);
    const totalPages = Number(found.body?.totalPages ?? found.body?.total_pages ?? 0);
    if (!found.ok || batch.length === 0) break;
    if (totalPages > 0 && page + 1 >= totalPages) break;
    if (batch.length < 20 && totalPages <= 0) break;
  }
  return { rows, pages };
}

export async function listDlocalSubscriptions(planId, { page = 1, size = 50 } = {}) {
  if (!planId) return { ok: false, status: 400, body: {} };
  const qs = new URLSearchParams({
    page: String(page || 1),
    page_size: String(size || 50)
  });
  return dlocalGoRequest(
    'GET',
    `/v1/subscription/plan/${encodeURIComponent(planId)}/subscription/all?${qs}`
  );
}

export async function listAllDlocalSubscriptions(planId, { maxPages = 40 } = {}) {
  const rows = [];
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const found = await listDlocalSubscriptions(planId, { page, size: 50 });
    pages++;
    const batch = Array.isArray(found.body?.data) ? found.body.data : [];
    rows.push(...batch);
    const totalPages = Number(found.body?.total_pages ?? found.body?.totalPages ?? 0);
    if (!found.ok || batch.length === 0) break;
    if (totalPages > 0 && page >= totalPages) break;
    if (batch.length < 50 && totalPages <= 0) break;
  }
  return { rows, pages };
}

export function isDlocalLeonaPlanName(name) {
  return /^leona-starter-\d+/i.test(String(name || ''));
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

export function normalizeDlocalWebhookPayload(body) {
  if (body == null) return {};
  if (typeof body === 'string') {
    const raw = body.trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  return body;
}

export function extractDlocalNotificationRef(payload = {}, query = {}) {
  const bag = normalizeDlocalWebhookPayload(payload);
  const candidates = [
    bag.payment_id,
    bag.paymentId,
    bag.id,
    bag.data?.payment_id,
    bag.data?.id,
    bag.order_id,
    bag.orderId,
    bag.invoice_id,
    query.payment_id,
    query.paymentId,
    query.id,
    query.order_id,
    query.external_id
  ];
  let paymentId = null;
  let orderId = null;
  for (const value of candidates) {
    const id = String(value || '').trim();
    if (/^DP-/i.test(id)) paymentId = paymentId || id;
    else if (/^ST-/i.test(id)) orderId = orderId || id;
  }
  const subscriptionId = [
    bag.subscription_id,
    bag.subscriptionId,
    bag.subscription?.id,
    bag.data?.subscription_id,
    query.subscription_id
  ].map((value) => String(value || '').trim()).find((value) => /^\d+$/.test(value)) || null;
  const planId = [
    bag.plan_id,
    bag.planId,
    bag.subscription?.plan?.id,
    bag.plan?.id,
    query.plan_id
  ].map((value) => String(value || '').trim()).find((value) => /^\d+$/.test(value)) || null;
  const numericId = String(bag.id || query.id || '').trim();
  const resolvedSubscriptionId = subscriptionId
    || (!paymentId && !orderId && /^\d+$/.test(numericId) ? numericId : null);
  return { paymentId, orderId, subscriptionId: resolvedSubscriptionId, planId };
}

export function extractDlocalPaymentId(payload = {}, query = {}) {
  return extractDlocalNotificationRef(payload, query).paymentId;
}

export async function findDlocalPaymentByOrderId(orderId, { startDate, endDate, maxPages = 10 } = {}) {
  if (!orderId) return null;
  const listed = await listAllDlocalPayments({ startDate, endDate, maxPages });
  return listed.rows.find((row) => String(row.order_id || '') === String(orderId)) || null;
}

export function dlocalPaymentPaid(payment = {}) {
  return ['PAID', 'COMPLETED'].includes(String(payment.status || '').toUpperCase());
}

export function dlocalPaymentFailed(payment = {}) {
  return ['REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REFUNDED'].includes(
    String(payment.status || '').toUpperCase()
  );
}

export function dlocalCheckoutPaymentFields(method) {
  if (isPixMethod(method)) {
    return { payment_type: 'VOUCHER', max_installments: 1 };
  }
  if (isCardMethod(method)) {
    return { payment_type: 'CREDIT_CARD', max_installments: 1 };
  }
  return {
    payment_type: 'CREDIT_CARD,VOUCHER',
    max_installments: 1
  };
}

export async function createDlocalPayment(payload, method) {
  return dlocalGoRequest('POST', '/v1/payments', { ...dlocalCheckoutPaymentFields(method), ...payload });
}

export async function getDlocalPayment(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return dlocalGoRequest('GET', `/v1/payments/${encodeURIComponent(id)}`);
}

export async function listDlocalExecutions(planId, subscriptionId, { page = 1, size = 50 } = {}) {
  if (!planId || !subscriptionId) return { ok: false, status: 400, body: {} };
  const qs = new URLSearchParams({
    page: String(page || 1),
    page_size: String(size || 50)
  });
  return dlocalGoRequest(
    'GET',
    `/v1/subscription/plan/${encodeURIComponent(planId)}/subscription/${encodeURIComponent(subscriptionId)}/execution/all?${qs}`
  );
}

export function executionPaid(execution = {}) {
  return ['COMPLETED', 'PAID', 'CONFIRMED'].includes(String(execution.status || '').toUpperCase());
}

export async function findDlocalPaymentForSubscription({ subscriptionId, planId, email } = {}) {
  const subId = String(subscriptionId || '').trim();
  if (!subId) return null;

  let plans = [];
  if (planId) {
    plans = [{ id: planId }];
  } else {
    const listed = await listDlocalPlans({ page: 1, size: 100 });
    plans = (Array.isArray(listed.body?.data) ? listed.body.data : [])
      .filter((row) => isDlocalLeonaPlanName(row.name));
  }

  for (const plan of plans) {
    const found = await listDlocalExecutions(plan.id, subId, { page: 1, size: 50 });
    const rows = Array.isArray(found.body?.data) ? found.body.data : [];
    const paid = rows.filter(executionPaid).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const orderId = paid[0]?.order_id;
    if (!orderId) continue;
    if (/^DP-/i.test(orderId)) {
      const fetched = await getDlocalPayment(orderId);
      if (fetched.ok && fetched.body?.id) return fetched.body;
    }
    const byOrder = await findDlocalPaymentByOrderId(orderId, {
      startDate: brtDayOffset(-3),
      endDate: brtDayOffset(0)
    });
    if (byOrder) return byOrder;
  }

  if (email) {
    const listed = await listDlocalPayments({
      email,
      startDate: brtDayOffset(-3),
      endDate: brtDayOffset(0),
      size: 20
    });
    return (Array.isArray(listed.body?.data) ? listed.body.data : []).find((row) => dlocalPaymentPaid(row)) || null;
  }
  return null;
}

function brtDayOffset(offset = 0) {
  const ms = Date.now() + offset * 86400000;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms));
}

export async function findLatestPaidDlocalPayment({ email, accountId, qty } = {}) {
  if (!email) return null;
  const listed = await listDlocalPayments({
    email,
    startDate: brtDayOffset(-3),
    endDate: brtDayOffset(0),
    size: 20
  });
  const rows = (Array.isArray(listed.body?.data) ? listed.body.data : []).filter(dlocalPaymentPaid);
  const wantedQty = qty != null ? Number(qty) : null;
  const wantedAccount = accountId != null ? String(accountId) : '';
  return rows.find((row) => {
    const ref = parseDlocalOrderId(row.order_id) || parseDlocalOrderId(row.description);
    if (wantedAccount && ref?.accountId && String(ref.accountId) === wantedAccount) return true;
    const planQty = qtyFromDlocalPlanName(row.description);
    if (wantedQty && (Number(ref?.qty) === wantedQty || Number(planQty) === wantedQty)) return true;
    return !wantedQty;
  }) || rows[0] || null;
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

export function isPixMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  return method === 'pix' || method === 'voucher';
}

export function isCardMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  return method === 'card' || method === 'cartao' || method === 'cartão' || method === 'credit_card';
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
    const from = String(
      row?.from || row?.from_currency || row?.origin || row?.source_currency || ''
    ).toUpperCase();
    const to = String(
      row?.to || row?.to_currency || row?.destination || row?.target_currency || ''
    ).toUpperCase();
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
    const needsPatch = Number(keep.amount) !== amountN
      || (notificationUrl && String(keep.notification_url || '') !== String(notificationUrl))
      || (successUrl && String(keep.success_url || '') !== String(successUrl));
    if (needsPatch) {
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

export function sanitizeCheckoutPayerName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

export function checkoutUrlWithPayer(checkoutUrl, { email, name } = {}) {
  if (!checkoutUrl) return null;
  const url = new URL(checkoutUrl);
  if (email) url.searchParams.set('email', String(email).trim());
  const cleanName = sanitizeCheckoutPayerName(name);
  if (cleanName) url.searchParams.set('name', cleanName);
  return url.toString();
}

export function subscribeUrlWithPayer(subscribeUrl, { email, name, accountId, qty } = {}) {
  const url = checkoutUrlWithPayer(subscribeUrl, { email, name });
  if (!url) return null;
  if (accountId && qty) {
    const parsed = new URL(url);
    parsed.searchParams.set('external_id', `leona:${accountId}:${qty}`);
    return parsed.toString();
  }
  return url;
}
