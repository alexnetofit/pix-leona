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

export async function createPagarmeOrder(payload) {
  return pagarmeRequest('POST', '/orders', payload);
}

export async function listPagarmeOrders({
  page = 1,
  size = 30,
  status,
  createdSince,
  createdUntil
} = {}) {
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('size', String(Math.min(30, Math.max(1, Number(size) || 30))));
  if (status) qs.set('status', status);
  if (createdSince) qs.set('created_since', createdSince);
  if (createdUntil) qs.set('created_until', createdUntil);
  return pagarmeRequest('GET', `/orders?${qs}`);
}

export async function listAllPagarmeOrders({
  status,
  createdSince,
  createdUntil,
  maxPages = 50
} = {}) {
  const rows = [];
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const listed = await listPagarmeOrders({
      page,
      size: 30,
      status,
      createdSince,
      createdUntil
    });
    if (!listed.ok) {
      const error = new Error(`Pagar.me retornou ${listed.status} ao listar pedidos`);
      error.status = 502;
      error.detail = JSON.stringify(listed.body || {}).slice(0, 500);
      throw error;
    }
    pages++;
    const data = Array.isArray(listed.body?.data) ? listed.body.data : [];
    rows.push(...data);
    const total = Number(listed.body?.paging?.total);
    if (data.length < 30 || (Number.isFinite(total) && rows.length >= total)) break;
  }
  return { rows, pages };
}

export async function listPagarmeSubscriptions({
  page = 1,
  size = 30,
  status
} = {}) {
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('size', String(Math.min(30, Math.max(1, Number(size) || 30))));
  if (status) qs.set('status', status);
  return pagarmeRequest('GET', `/subscriptions?${qs}`);
}

export async function listAllPagarmeSubscriptions({ status, maxPages = 20 } = {}) {
  const rows = [];
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const listed = await listPagarmeSubscriptions({ page, size: 30, status });
    if (!listed.ok) {
      const error = new Error(`Pagar.me retornou ${listed.status} ao listar assinaturas`);
      error.status = 502;
      error.detail = JSON.stringify(listed.body || {}).slice(0, 500);
      throw error;
    }
    pages++;
    const data = Array.isArray(listed.body?.data) ? listed.body.data : [];
    rows.push(...data);
    const total = Number(listed.body?.paging?.total);
    if (data.length < 30 || (Number.isFinite(total) && rows.length >= total)) break;
  }
  return { rows, pages };
}

export function pagarmePublicKey() {
  return (process.env.PAGARME_PUBLIC_KEY || '').trim();
}

export async function findPagarmeCustomerByEmail(email) {
  const emailClean = String(email || '').trim().toLowerCase();
  if (!emailClean || !pagarmeConfigured()) return null;
  const listed = await pagarmeRequest('GET', `/customers?email=${encodeURIComponent(emailClean)}`);
  if (!listed.ok) return null;
  const rows = Array.isArray(listed.body?.data) ? listed.body.data : [];
  return rows.find((row) => String(row.email || '').toLowerCase() === emailClean) || rows[0] || null;
}

export async function listPagarmeCharges({
  page = 1,
  size = 30,
  customerId,
  createdSince
} = {}) {
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('size', String(Math.min(30, Math.max(1, Number(size) || 30))));
  if (customerId) qs.set('customer_id', String(customerId));
  if (createdSince) qs.set('created_since', createdSince);
  return pagarmeRequest('GET', `/charges?${qs}`);
}

export async function cancelPagarmePaymentLink(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  const deleted = await pagarmeRequest('DELETE', `/paymentlinks/${encodeURIComponent(id)}`);
  if (deleted.ok) return deleted;
  return pagarmeRequest('PATCH', `/paymentlinks/${encodeURIComponent(id)}`, { status: 'canceled' });
}

export async function listPagarmeCustomerCards(customerId) {
  if (!customerId) return [];
  const listed = await pagarmeRequest('GET', `/customers/${encodeURIComponent(customerId)}/cards`);
  if (!listed.ok) return [];
  if (Array.isArray(listed.body?.data)) return listed.body.data;
  return Array.isArray(listed.body) ? listed.body : [];
}

export async function createPagarmeCustomerCard(customerId, payload) {
  if (!customerId) return { ok: false, status: 400, body: { message: 'customer_id obrigatório' } };
  return pagarmeRequest('POST', `/customers/${encodeURIComponent(customerId)}/cards`, payload);
}

export async function listPagarmeSubscriptionsByCustomer(customerId, { status, size = 20 } = {}) {
  if (!customerId) return [];
  const qs = new URLSearchParams();
  qs.set('customer_id', String(customerId));
  qs.set('size', String(Math.min(30, Math.max(1, Number(size) || 20))));
  if (status) qs.set('status', status);
  const listed = await pagarmeRequest('GET', `/subscriptions?${qs}`);
  if (!listed.ok) return [];
  return Array.isArray(listed.body?.data) ? listed.body.data : [];
}

export async function getPagarmeSubscription(subscriptionId) {
  if (!subscriptionId) return { ok: false, status: 400, body: { message: 'subscription_id obrigatório' } };
  return pagarmeRequest('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export async function createPagarmePlan(payload) {
  return pagarmeRequest('POST', '/plans', payload);
}

export async function listPagarmePlans({ page = 1, size = 30, status } = {}) {
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('size', String(Math.min(30, Math.max(1, Number(size) || 30))));
  if (status) qs.set('status', status);
  return pagarmeRequest('GET', `/plans?${qs}`);
}

export async function listAllPagarmePlans({ status = 'active', maxPages = 20 } = {}) {
  const rows = [];
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const listed = await listPagarmePlans({ page, size: 30, status });
    if (!listed.ok) {
      const error = new Error(`Pagar.me retornou ${listed.status} ao listar planos`);
      error.status = 502;
      error.detail = JSON.stringify(listed.body || {}).slice(0, 500);
      throw error;
    }
    pages++;
    const data = Array.isArray(listed.body?.data) ? listed.body.data : [];
    rows.push(...data);
    const total = Number(listed.body?.paging?.total);
    if (data.length < 30 || (Number.isFinite(total) && rows.length >= total)) break;
  }
  return { rows, pages };
}

export async function createPagarmeSubscription(payload) {
  return pagarmeRequest('POST', '/subscriptions', payload);
}

export async function updatePagarmeSubscription(subscriptionId, payload) {
  if (!subscriptionId) return { ok: false, status: 400, body: { message: 'subscription_id obrigatório' } };
  return pagarmeRequest('PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, payload);
}

export async function updatePagarmeSubscriptionItem(subscriptionId, itemId, payload) {
  if (!subscriptionId || !itemId) {
    return { ok: false, status: 400, body: { message: 'subscription_id e item_id obrigatórios' } };
  }
  return pagarmeRequest(
    'PUT',
    `/subscriptions/${encodeURIComponent(subscriptionId)}/items/${encodeURIComponent(itemId)}`,
    payload
  );
}

export async function updatePagarmeSubscriptionCard(subscriptionId, payload) {
  if (!subscriptionId) return { ok: false, status: 400, body: { message: 'subscription_id obrigatório' } };
  const card = await pagarmeRequest(
    'PATCH',
    `/subscriptions/${encodeURIComponent(subscriptionId)}/card`,
    payload
  );
  if (card.ok) return card;
  return pagarmeRequest(
    'PATCH',
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payment-method`,
    { payment_method: 'credit_card', ...payload }
  );
}

/** Endereço da AN Soluções — só vai na API do cartão (antifraude). O cliente da assinatura não preenche. */
export const PAGARME_DIGITAL_ADDRESS = {
  country: 'BR',
  state: 'SP',
  city: 'Jacarei',
  zip_code: '12308301',
  line_1: '61, Rua Antonio Lopes da Costa, Centro'
};

export function parsePagarmeDocument(raw) {
  const number = String(raw || '').replace(/\D/g, '');
  if (number.length === 11) return { type: 'individual', document: number, document_type: 'CPF' };
  if (number.length === 14) return { type: 'company', document: number, document_type: 'CNPJ' };
  return null;
}

export function friendlyPagarmeError(message) {
  const msg = String(message || '').trim();
  if (/document is (required|necessary)/i.test(msg)) return 'Informe o CPF ou CNPJ';
  return msg;
}

export function pagarmeDigitalCustomer({ name, email, document } = {}) {
  const parsed = parsePagarmeDocument(document);
  return {
    name: String(name || 'Cliente Leona').trim().slice(0, 64) || 'Cliente Leona',
    email: String(email || '').trim().toLowerCase(),
    type: parsed?.type || 'individual',
    ...(parsed ? { document: parsed.document, document_type: parsed.document_type } : {}),
    phones: {
      mobile_phone: { country_code: '55', area_code: '12', number: '999999999' }
    }
  };
}

export function pagarmeOrderLooksPaid(order = {}) {
  const status = String(order.status || '').toLowerCase();
  if (status === 'paid') return true;
  const charges = Array.isArray(order.charges) ? order.charges : [];
  return charges.some((charge) => ['paid', 'captured'].includes(String(charge.status || '').toLowerCase()));
}

export function extractPagarmePix(order = {}) {
  const charges = Array.isArray(order.charges) ? order.charges : [];
  const pix = charges.find((charge) => String(charge.payment_method || '').toLowerCase() === 'pix') || charges[0] || {};
  const tx = pix.last_transaction && typeof pix.last_transaction === 'object' ? pix.last_transaction : {};
  const nested = tx.pix && typeof tx.pix === 'object' ? tx.pix : {};
  const qr = tx.qr_code || tx.emv || nested.qr_code || pix.qr_code || null;
  return {
    qr_code: qr ? String(qr) : null,
    qr_code_url: tx.qr_code_url || nested.qr_code_url || pix.qr_code_url || null,
    expires_at: tx.expires_at || nested.expires_at || pix.expires_at || null
  };
}

export async function refreshPagarmePix(order = {}, { retries = 2, waitMs = 400 } = {}) {
  let pix = extractPagarmePix(order);
  if (pix.qr_code || !order?.id) return pix;
  for (let i = 0; i < retries; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const fresh = await getPagarmeOrder(order.id);
    if (!fresh.ok) continue;
    pix = extractPagarmePix(fresh.body);
    if (pix.qr_code) return pix;
  }
  return pix;
}

export function pagarmeDeclineMessage(order = {}) {
  const tx = order?.charges?.[0]?.last_transaction || {};
  const gatewayErrors = tx.gateway_response?.errors;
  const firstError = Array.isArray(gatewayErrors) ? gatewayErrors[0] : null;
  return firstError?.message
    || tx.acquirer_message
    || tx.gateway_message
    || (String(order.status || '').toLowerCase() === 'failed' ? 'Pagamento recusado' : null);
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
    data.order?.code,
    bag.order?.code,
    data.code,
    bag.code,
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

export function extractPagarmeSubscriptionId(payload = {}, query = {}) {
  const bag = payload && typeof payload === 'object' ? payload : {};
  const data = bag.data && typeof bag.data === 'object' ? bag.data : {};
  const charges = Array.isArray(data.charges) ? data.charges : [];
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const recurrences = Array.isArray(data.cart_settings?.recurrences)
    ? data.cart_settings.recurrences
    : [];
  const candidates = [
    query.subscription_id,
    bag.subscription_id,
    data.subscription_id,
    data.subscription?.id,
    data.invoice?.subscription_id,
    data.invoice?.subscription?.id,
    ...charges.map((charge) => charge?.subscription_id || charge?.subscription?.id),
    ...orders.map((order) => order?.subscription_id || order?.subscription?.id),
    ...recurrences.map((row) => row?.subscription_id || row?.subscription?.id),
    data.id,
    bag.id
  ];
  return candidates
    .map((value) => String(value || '').trim())
    .find((value) => /^sub_/i.test(value)) || null;
}

export function extractPagarmeCycleKey(payload = {}, subscription = null) {
  const bag = payload && typeof payload === 'object' ? payload : {};
  const data = bag.data && typeof bag.data === 'object' ? bag.data : bag;
  const candidates = [
    data.invoice?.id,
    bag.invoice?.id,
    data.charge?.id,
    data.current_cycle?.id,
    subscription?.current_cycle?.id,
    data.id,
    bag.id
  ];
  return candidates
    .map((value) => String(value || '').trim())
    .find((value) => /^(in_|ch_|cycle_)/i.test(value)) || null;
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
  if (['order.paid', 'charge.paid', 'checkout.closed', 'invoice.paid'].includes(type)) return true;
  const status = String(payload.data?.status || payload.status || '').toLowerCase();
  return status === 'paid' || status === 'closed';
}

export function pagarmeWebhookLooksFailed(payload = {}) {
  const type = String(payload.type || payload.event || '').toLowerCase();
  if (type.includes('failed') || type.includes('not_authorized') || type.includes('refused')) return true;
  const status = String(payload.data?.status || payload.status || '').toLowerCase();
  return ['failed', 'not_authorized', 'refused', 'canceled', 'cancelled'].includes(status);
}

export function pagarmeSubscriptionActive(sub) {
  return ['active', 'trialing', 'future'].includes(String(sub?.status || '').toLowerCase());
}
