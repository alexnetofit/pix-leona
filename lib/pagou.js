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

export async function getPagouTransaction(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pagouRequest('GET', `/v2/transactions/${encodeURIComponent(id)}`);
}

export async function getPagouSubscription(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pagouRequest('GET', `/v2/subscriptions/${encodeURIComponent(id)}`);
}
