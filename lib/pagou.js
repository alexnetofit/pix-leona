const PAGOU_BASE = 'https://api.pagou.ai';

export function pagouConfigured() {
  return Boolean((process.env.PAGOU_SECRET_KEY || '').trim());
}

function pagouHeaders() {
  const key = (process.env.PAGOU_SECRET_KEY || '').trim();
  return {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

export async function pagouRequest(method, path, body) {
  const r = await fetch(`${PAGOU_BASE}${path}`, {
    method,
    headers: pagouHeaders(),
    body: body != null ? JSON.stringify(body) : undefined
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: json };
}

export async function createPagouCheckoutLink(payload) {
  return pagouRequest('POST', '/v2/checkout-links', payload);
}

export async function createPagouTransaction(payload) {
  return pagouRequest('POST', '/v2/transactions', payload);
}

export async function createPagouCustomer(payload) {
  return pagouRequest('POST', '/v2/customers', payload);
}

export async function listPagouCustomers(query = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    qs.set(key, String(value));
  }
  return pagouRequest('GET', `/v2/customers?${qs}`);
}

export async function createPagouSubscription(payload) {
  return pagouRequest('POST', '/v2/subscriptions', payload);
}

function payloadData(body = {}) {
  return body.data || body;
}

export async function getPagouCustomer(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pagouRequest('GET', `/v2/customers/${encodeURIComponent(id)}`);
}

export function customerDocumentOf(data = {}) {
  const doc = data.document && typeof data.document === 'object' ? data.document : {};
  const number = String(doc.number || doc.document_number || data.document_number || data.number || '')
    .replace(/\D/g, '');
  if (number.length !== 11 && number.length !== 14) return null;
  const type = String(doc.type || doc.document_type || data.document_type || '')
    .trim()
    .toUpperCase();
  const inferred = type || (number.length === 14 ? 'CNPJ' : 'CPF');
  if (inferred !== 'CPF' && inferred !== 'CNPJ') return null;
  return { type: inferred, number };
}

export function toPagouDocument(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return customerDocumentOf({ document: raw, ...raw });
  const number = String(raw).replace(/\D/g, '');
  return customerDocumentOf({ document_number: number });
}

export async function findPagouCustomerByEmail(email) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;
  const matches = [];
  for (let page = 1; page <= 20; page++) {
    const listed = await listPagouCustomers({ email: needle, limit: 50, page });
    const rows = Array.isArray(listed.body?.data) ? listed.body.data : [];
    matches.push(...rows.filter((row) => String(row.email || '').trim().toLowerCase() === needle));
    if (!rows.length || rows.length < 50) break;
  }
  return matches[0] || null;
}

async function findPagouCustomerWithDocument(email) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;
  const matches = [];
  for (let page = 1; page <= 5; page++) {
    const listed = await listPagouCustomers({ email: needle, limit: 50, page });
    const rows = Array.isArray(listed.body?.data) ? listed.body.data : [];
    matches.push(...rows.filter((row) => String(row.email || '').trim().toLowerCase() === needle));
    if (!rows.length || rows.length < 50) break;
  }
  for (const row of matches.slice(0, 8)) {
    const fresh = await loadCustomer(row.id);
    if (customerDocumentOf(fresh)) return fresh;
  }
  return null;
}

export async function updatePagouCustomer(id, payload) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pagouRequest('PATCH', `/v2/customers/${encodeURIComponent(id)}`, payload);
}

function addressWrite(address) {
  if (!address || typeof address !== 'object') return null;
  const number = String(address.number || address.street_number || '').trim();
  const zip = String(address.zipCode || address.zip_code || '').replace(/\D/g, '');
  return {
    street: address.street,
    number,
    neighborhood: address.neighborhood,
    city: address.city,
    state: address.state,
    zipCode: zip,
    country: address.country || 'BR'
  };
}

export function customerWritePayload(payload = {}) {
  const document = toPagouDocument(payload.document);
  const address = addressWrite(payload.address);
  return {
    name: payload.name,
    email: payload.email,
    ...(document ? { document } : {}),
    ...(payload.phone ? { phone: payload.phone } : {}),
    ...(payload.externalRef ? { externalRef: payload.externalRef } : {}),
    ...(address ? { address } : {}),
    ...(payload.ip ? { ip_address: payload.ip } : {})
  };
}

async function loadCustomer(id) {
  const found = await getPagouCustomer(id);
  const data = payloadData(found.body);
  if (!found.ok || !data?.id) return null;
  return data;
}

export async function upsertPagouCustomer(payload) {
  const body = customerWritePayload(payload);
  const existing = await findPagouCustomerWithDocument(payload.email);
  if (existing?.id) {
    return { ok: true, status: 200, data: existing, created: false };
  }

  const write = await createPagouCustomer(body);
  const data = payloadData(write.body);
  if (!write.ok || !data?.id) {
    return {
      ok: false,
      status: write.status || 502,
      body: write.body,
      data: null
    };
  }

  const fresh = (await loadCustomer(data.id)) || data;
  if (payload.document && !customerDocumentOf(fresh)) {
    return {
      ok: false,
      status: 422,
      body: { detail: 'Não foi possível gravar o CPF/CNPJ no cliente Pagou' },
      data: fresh
    };
  }
  return { ok: true, status: write.status, data: fresh, created: true };
}

export function firstSubscriptionTransaction(sub = {}) {
  const rows = Array.isArray(sub.transactions) ? sub.transactions : [];
  return rows[0] || null;
}

export function subscriptionPaid(sub = {}) {
  const status = String(sub.status || '').toLowerCase();
  if (status === 'active' || status === 'paid') return true;
  const tx = firstSubscriptionTransaction(sub);
  return String(tx?.status || '').toLowerCase() === 'paid';
}

export function pagouPublicKey() {
  return (process.env.PAGOU_PUBLIC_KEY || '').trim();
}

export function extractPix(data = {}) {
  const pix = data.pix || data.payment?.pix || {};
  const auth = data.authorization || {};
  const qr = pix.qr_code || pix.emv || pix.copy_paste || data.pix_code || data.qr_code || auth.qr_code || null;
  return {
    qr_code: qr,
    expiration_date: pix.expiration_date || pix.expires_at || auth.expires_at || data.expiration_date || null,
    receipt_url: pix.receipt_url || auth.payment_link_url || null
  };
}

export async function getPagouTransaction(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pagouRequest('GET', `/v2/transactions/${encodeURIComponent(id)}`);
}

export async function getPagouSubscription(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pagouRequest('GET', `/v2/subscriptions/${encodeURIComponent(id)}`);
}

export async function listPagouTransactions(query = {}) {
  const rows = [];
  let cursor = '';
  let pages = 0;
  while (pages < 40) {
    pages++;
    const qs = new URLSearchParams();
    qs.set('limit', String(query.limit || 50));
    for (const [key, value] of Object.entries(query)) {
      if (key === 'limit' || value == null || value === '') continue;
      qs.set(key, String(value));
    }
    if (cursor) qs.set('cursor', cursor);
    const result = await pagouRequest('GET', `/v2/transactions?${qs}`);
    const chunk = Array.isArray(result.body?.data) ? result.body.data : [];
    rows.push(...chunk);
    cursor = result.body?.next_cursor || '';
    if (!cursor || !chunk.length || !result.ok) break;
  }
  return { ok: true, rows, pages };
}

export async function listPagouSubscriptions(query = {}) {
  const qs = new URLSearchParams({ limit: '50', ...query });
  return pagouRequest('GET', `/v2/subscriptions?${qs}`);
}

export async function listAllPagouSubscriptions(query = {}) {
  const rows = [];
  let cursor = '';
  let pages = 0;
  while (pages < 40) {
    pages++;
    const qs = new URLSearchParams();
    qs.set('limit', String(query.limit || 50));
    for (const [key, value] of Object.entries(query)) {
      if (key === 'limit' || value == null || value === '') continue;
      qs.set(key, String(value));
    }
    if (cursor) qs.set('cursor', cursor);
    const result = await pagouRequest('GET', `/v2/subscriptions?${qs}`);
    const chunk = Array.isArray(result.body?.data) ? result.body.data : [];
    rows.push(...chunk);
    cursor = result.body?.next_cursor || '';
    if (!cursor || !chunk.length || !result.ok) break;
  }
  return { ok: true, rows, pages };
}
