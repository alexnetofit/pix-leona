/**
 * Cliente mínimo da Pagar.me Core v5.
 * Auth: HTTP Basic com a Secret Key como user (password vazio).
 */
const PAGARME_BASE = 'https://api.pagar.me/core/v5';

export function pagarmeApiKey() {
  return (process.env.PAGARME_KEY || process.env.PAGARME_API_KEY || '').trim();
}

export function pagarmeConfigured() {
  return Boolean(pagarmeApiKey());
}

function authHeader() {
  return `Basic ${Buffer.from(`${pagarmeApiKey()}:`).toString('base64')}`;
}

export async function pagarmeRequest(method, path, body) {
  const r = await fetch(`${PAGARME_BASE}${path}`, {
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

export async function createPagarmePaymentLink(payload) {
  return pagarmeRequest('POST', '/paymentlinks', payload);
}

export async function getPagarmeOrder(orderId) {
  if (!orderId) return { ok: false, status: 400, body: {} };
  return pagarmeRequest('GET', `/orders/${encodeURIComponent(orderId)}`);
}

export async function getPagarmePaymentLink(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pagarmeRequest('GET', `/paymentlinks/${encodeURIComponent(id)}`);
}

export function extractPagarmePaymentLinkId(payload = {}, query = {}) {
  const bag = payload && typeof payload === 'object' ? payload : {};
  const data = bag.data && typeof bag.data === 'object' ? bag.data : {};
  const candidates = [
    query.payment_link_id,
    query.id,
    bag.payment_link_id,
    bag.paymentLinkId,
    data.payment_link_id,
    data.payment_link?.id,
    data.checkout?.id,
    data.id,
    bag.id
  ];
  return candidates
    .map((value) => String(value || '').trim())
    .find((value) => /^pl_/i.test(value)) || null;
}

export function pagarmeWebhookLooksPaid(payload = {}) {
  const type = String(payload.type || payload.event || '').toLowerCase();
  if (['order.paid', 'charge.paid', 'checkout.closed'].includes(type)) return true;
  const status = String(payload.data?.status || payload.status || '').toLowerCase();
  return status === 'paid' || status === 'closed';
}
