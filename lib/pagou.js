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
