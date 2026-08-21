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
  const doc = data.document || {};
  const type = String(doc.type || doc.document_type || '').trim().toUpperCase();
  const number = String(doc.number || doc.document_number || '').replace(/\D/g, '');
  if (!type || (number.length !== 11 && number.length !== 14)) return null;
  return { type, number };
}

export async function findPagouCustomerByEmail(email) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;
  for (let page = 1; page <= 20; page++) {
    const listed = await listPagouCustomers({ email: needle, limit: 50, page });
    const rows = Array.isArray(listed.body?.data) ? listed.body.data : [];
    const found = rows.find((row) => String(row.email || '').trim().toLowerCase() === needle);
    if (found) return found;
    if (!rows.length || rows.length < 50) break;
  }
  return null;
}

export async function updatePagouCustomer(id, payload) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pagouRequest('PATCH', `/v2/customers/${encodeURIComponent(id)}`, payload);
}

function customerWritePayload(payload = {}) {
  return {
    name: payload.name,
    email: payload.email,
    ...(payload.document ? { document: payload.document } : {}),
    ...(payload.phone ? { phone: payload.phone } : {}),
    ...(payload.externalRef ? { externalRef: payload.externalRef } : {}),
    ...(payload.address ? { address: payload.address } : {}),
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
  const existing = await findPagouCustomerByEmail(payload.email);
  let id = existing?.id || null;
  let created = false;
  let write = existing?.id
    ? await updatePagouCustomer(existing.id, body)
    : await createPagouCustomer(body);

  let data = payloadData(write.body);
  if (write.ok && data?.id) {
    id = data.id;
    created = !existing?.id;
  } else if (!id) {
    return {
      ok: false,
      status: write.status || 502,
      body: write.body,
      data: null
    };
  }

  const fresh = (await loadCustomer(id)) || data;
  if (!customerDocumentOf(fresh) && payload.document) {
    const patched = await updatePagouCustomer(id, body);
    const patchedData = payloadData(patched.body);
    const again = (await loadCustomer(id)) || (patched.ok && patchedData?.id ? patchedData : fresh);
    if (!customerDocumentOf(again)) {
      return {
        ok: false,
        status: 422,
        body: { detail: 'Não foi possível gravar o CPF/CNPJ no cliente Pagou' },
        data: again
      };
    }
    return { ok: true, status: 200, data: again, created: false, patched: true };
  }

  return { ok: true, status: write.ok ? write.status : 200, data: fresh, created, patched: Boolean(existing?.id) };
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
  const qr = pix.qr_code || pix.emv || pix.copy_paste || data.pix_code || data.qr_code || null;
  return {
    qr_code: qr,
    expiration_date: pix.expiration_date || pix.expires_at || data.expiration_date || null,
    receipt_url: pix.receipt_url || null
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
