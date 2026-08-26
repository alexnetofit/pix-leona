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
  const charges = Array.isArray(data.charges) ? data.charges : [];
  const candidates = [
    query.payment_link_id,
    query.id,
    bag.payment_link_id,
    bag.paymentLinkId,
    data.payment_link_id,
    data.payment_link?.id,
    data.checkout?.id,
    data.metadata?.payment_link_id,
    ...charges.map((charge) => charge?.payment_link_id || charge?.metadata?.payment_link_id),
    data.id,
    bag.id
  ];
  return candidates
    .map((value) => String(value || '').trim())
    .find((value) => /^pl_/i.test(value)) || null;
}

export function extractPagarmeOrderId(payload = {}, query = {}) {
  const bag = payload && typeof payload === 'object' ? payload : {};
  const data = bag.data && typeof bag.data === 'object' ? bag.data : {};
  const candidates = [
    query.order_id,
    bag.order_id,
    data.order_id,
    data.order?.id,
    data.id,
    bag.id
  ];
  return candidates
    .map((value) => String(value || '').trim())
    .find((value) => /^or_/i.test(value)) || null;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
}

function parsePagarmeLine1(line1) {
  const parts = String(line1 || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    return { number: parts[0], street: parts[1], neighborhood: parts.slice(2).join(', ') };
  }
  if (parts.length === 2) {
    if (/^\d/.test(parts[1])) return { street: parts[0], number: parts[1], neighborhood: '' };
    return { number: parts[0], street: parts[1], neighborhood: '' };
  }
  return { street: String(line1 || '').trim(), number: '', neighborhood: '' };
}

function collectPagarmeAddresses(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    node.forEach((item) => collectPagarmeAddresses(item, acc));
    return acc;
  }
  const looksAddress = node.zip_code || node.zipcode || node.line_1 || node.street || node.city;
  if (looksAddress) acc.push(node);
  for (const key of ['address', 'shipping', 'billing', 'billing_address', 'customer', 'data']) {
    if (node[key]) collectPagarmeAddresses(node[key], acc);
  }
  if (Array.isArray(node.charges)) collectPagarmeAddresses(node.charges, acc);
  return acc;
}

function normalizePagarmeAddress(addr = {}) {
  const parsed = parsePagarmeLine1(addr.line_1 || addr.line1 || '');
  const street = String(addr.street || parsed.street || '').trim();
  const number = String(addr.number || addr.street_number || parsed.number || '').trim();
  const neighborhood = String(addr.neighborhood || addr.district || parsed.neighborhood || '').trim();
  const complement = String(addr.line_2 || addr.line2 || addr.complement || addr.complementary || '').trim();
  const city = String(addr.city || '').trim();
  const state = String(addr.state || '').trim().toUpperCase();
  const cep = String(addr.zip_code || addr.zipcode || addr.cep || '').replace(/\D/g, '');
  return { street, number, complement, neighborhood, city, state, cep };
}

export function extractPagarmePayer(payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const customer = firstObject(data.customer, payload.customer, data.charges?.[0]?.customer);
  const phones = firstObject(customer.phones);
  const mobile = firstObject(phones.mobile_phone, phones.home_phone);
  const phoneDigits = [mobile.country_code, mobile.area_code, mobile.number]
    .map((part) => String(part || '').replace(/\D/g, ''))
    .join('');
  const addresses = collectPagarmeAddresses(data)
    .map((addr) => normalizePagarmeAddress(addr))
    .sort((a, b) => Number(Boolean(b.cep)) - Number(Boolean(a.cep)));
  const shipping = addresses[0] || normalizePagarmeAddress({});
  const name = String(customer.name || data.shipping?.description || '').trim();
  const email = String(customer.email || '').trim().toLowerCase();
  const document = String(customer.document || '').replace(/\D/g, '');
  const addressLine = [
    shipping.street,
    shipping.number ? `nº ${shipping.number}` : '',
    shipping.complement,
    shipping.neighborhood,
    shipping.city && shipping.state ? `${shipping.city} — ${shipping.state}` : (shipping.city || shipping.state)
  ].filter(Boolean).join(', ');

  return {
    name,
    email,
    document,
    phone: phoneDigits.replace(/^55/, ''),
    cep: shipping.cep,
    address: addressLine,
    shipping
  };
}

export function pagarmePayerHasAddress(payer = {}) {
  const shipping = payer.shipping || payer.pontohub?.shipping || {};
  const cepOk = String(payer.cep || shipping.cep || '').replace(/\D/g, '').length === 8;
  return cepOk || Boolean(shipping.street && shipping.city && String(shipping.state || '').length === 2);
}

export function pagarmeWebhookLooksPaid(payload = {}) {
  const type = String(payload.type || payload.event || '').toLowerCase();
  if (['order.paid', 'charge.paid', 'checkout.closed'].includes(type)) return true;
  const status = String(payload.data?.status || payload.status || '').toLowerCase();
  return status === 'paid' || status === 'closed';
}
