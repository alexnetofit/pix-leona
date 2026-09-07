/**
 * Troca de cartão Pagar.me na /assinatura.
 * Nunca loga PAN/CVV — só last4/brand/status.
 */
import {
  PAGARME_DIGITAL_ADDRESS,
  createPagarmeCustomerCard,
  findPagarmeCustomerByEmail,
  friendlyPagarmeError,
  listPagarmeCustomerCards,
  listPagarmeSubscriptionsByCustomer,
  pagarmeConfigured,
  pagarmeOrderLooksPaid,
  pagarmeRequest,
  pagarmeSubscriptionActive,
  updatePagarmeSubscriptionCard
} from './pagarme.js';

const LEONA_ITEM_RE = /leona|plano starter/i;

export function parsePagarmeCardInput(body = {}) {
  const raw = body.card && typeof body.card === 'object' ? body.card : {};
  const number = String(raw.number || '').replace(/\D/g, '');
  const holder = String(raw.holder_name || body.name || '').trim();
  const expiry = String(raw.exp || raw.expiry || '').replace(/\D/g, '');
  let expMonth = Number(raw.exp_month);
  let expYear = Number(raw.exp_year);
  if ((!expMonth || !expYear) && expiry.length >= 4) {
    expMonth = Number(expiry.slice(0, 2));
    expYear = Number(expiry.slice(2));
  }
  if (expYear && expYear < 100) expYear += 2000;
  const cvv = String(raw.cvv || '').replace(/\D/g, '');
  if (number.length < 13 || !holder || !expMonth || !expYear || cvv.length < 3) return null;
  return { number, holder_name: holder, exp_month: expMonth, exp_year: expYear, cvv };
}

export function summarizePagarmeCard(card = {}) {
  const src = card || {};
  const last4 = src.last_four_digits || src.last4 || null;
  const brand = src.brand || null;
  const expMonth = src.exp_month != null ? Number(src.exp_month) : null;
  const expYear = src.exp_year != null ? Number(src.exp_year) : null;
  return {
    last4: last4 ? String(last4) : null,
    brand: brand ? String(brand) : null,
    exp_month: Number.isFinite(expMonth) ? expMonth : null,
    exp_year: Number.isFinite(expYear) ? expYear : null
  };
}

export function pagarmeOrderLooksLikeLeona(order = {}) {
  if (/^leona-/i.test(String(order.code || ''))) return true;
  const items = Array.isArray(order.items) ? order.items : [];
  const text = items.map((item) => `${item?.description || ''} ${item?.code || ''}`).join(' ');
  return LEONA_ITEM_RE.test(text);
}

export function pagarmeSubLooksLikeLeona(sub = {}) {
  if (/^leona-/i.test(String(sub.code || ''))) return true;
  const items = Array.isArray(sub.items) ? sub.items : [];
  const text = [
    sub.plan?.name,
    ...items.map((item) => `${item?.description || ''} ${item?.name || ''}`)
  ].join(' ');
  return LEONA_ITEM_RE.test(text);
}

export function guruHasActiveValidSub(guru = {}, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const subs = Array.isArray(guru?.subscriptions) ? guru.subscriptions : [];
  return subs.some((sub) => {
    if (String(sub?.status || sub?.last_status || '').toLowerCase() !== 'active') return false;
    const cycleEnd = String(sub.cycle_end || '').slice(0, 10);
    return Boolean(cycleEnd && cycleEnd >= today);
  });
}

export function canShowPagarmeCardButton({
  leonaActive = false,
  guruActiveValid = false,
  otherGatewayActive = false,
  pagarme = null
} = {}) {
  return Boolean(
    leonaActive
    && !guruActiveValid
    && !otherGatewayActive
    && pagarme?.can_change_card
  );
}


function pickDisplayCard(subscription, cards) {
  if (subscription?.card) return subscription.card;
  const list = Array.isArray(cards) ? cards : [];
  return list.find((card) => String(card.status || '').toLowerCase() === 'active') || list[0] || null;
}

function lastLeonaPaymentMethod(orders = [], sub = null) {
  const fromSub = String(sub?.payment_method || '').toLowerCase();
  if (fromSub) return fromSub;
  const paid = (orders || []).filter((order) => (
    pagarmeOrderLooksLikeLeona(order) && pagarmeOrderLooksPaid(order)
  ));
  const newest = paid.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
  if (!newest) return null;
  const charge = Array.isArray(newest.charges) ? newest.charges[0] : null;
  const method = charge?.payment_method || newest.payment_method;
  return method ? String(method).toLowerCase() : null;
}

function emptyPagarmeCardContext() {
  return {
    found: false,
    can_change_card: false,
    has_subscription: false,
    is_pagarme_billing: false,
    subscription_id: null,
    payment_method: null,
    last4: null,
    brand: null
  };
}

function orderWasCard(order = {}) {
  const charges = Array.isArray(order.charges) ? order.charges : [];
  return charges.some((charge) => {
    const method = String(charge?.payment_method || '').toLowerCase();
    return method === 'credit_card' || method === 'debit_card';
  }) || String(order.payment_method || '').toLowerCase() === 'credit_card';
}

export function buildPagarmeCardContext({
  customer = null,
  cards = [],
  subscriptions = [],
  orders = [],
  guru = null,
  otherGatewayActive = false
} = {}) {
  if (!customer?.id) {
    return emptyPagarmeCardContext();
  }

  const leonaSubs = (subscriptions || []).filter(pagarmeSubLooksLikeLeona);
  const activeSub = leonaSubs.find(pagarmeSubscriptionActive)
    || (subscriptions || []).find((sub) => pagarmeSubscriptionActive(sub) && pagarmeSubLooksLikeLeona(sub));
  const anyActiveSub = (subscriptions || []).find(pagarmeSubscriptionActive);
  const leonaOrders = (orders || []).filter((order) => (
    pagarmeOrderLooksLikeLeona(order) && pagarmeOrderLooksPaid(order)
  ));
  const hasLeonaCardCharge = leonaOrders.some(orderWasCard)
    || String(anyActiveSub?.payment_method || '').toLowerCase() === 'credit_card'
    || (cards || []).length > 0;
  const hasLeonaBilling = Boolean(activeSub || anyActiveSub || leonaOrders.length);
  const canChange = Boolean(
    hasLeonaBilling
    && hasLeonaCardCharge
    && !guruHasActiveValidSub(guru)
    && !otherGatewayActive
  );
  const display = summarizePagarmeCard(pickDisplayCard(activeSub || anyActiveSub, cards));
  const chosenSub = activeSub || anyActiveSub || null;

  return {
    found: true,
    can_change_card: canChange,
    has_subscription: Boolean(chosenSub),
    is_pagarme_billing: hasLeonaBilling,
    subscription_id: chosenSub?.id || null,
    payment_method: lastLeonaPaymentMethod(leonaOrders, chosenSub),
    last4: display.last4,
    brand: display.brand
  };
}

export function buildCreateCardPayload({ cardToken, card } = {}) {
  if (cardToken) return { token: String(cardToken) };
  if (!card?.number) return null;
  return {
    number: String(card.number).replace(/\D/g, ''),
    holder_name: String(card.holder_name || 'Cliente Leona').slice(0, 64),
    exp_month: Number(card.exp_month),
    exp_year: Number(card.exp_year),
    cvv: String(card.cvv || '').replace(/\D/g, ''),
    billing_address: PAGARME_DIGITAL_ADDRESS
  };
}

export function sanitizePagarmeCardLog(details = {}) {
  const out = { ...details };
  for (const key of ['number', 'cvv', 'card', 'pan', 'security_code']) delete out[key];
  return out;
}

async function listRecentCustomerOrders(customerId) {
  if (!customerId) return [];
  const listed = await pagarmeRequest('GET', `/orders?customer_id=${encodeURIComponent(customerId)}&size=15`);
  if (!listed.ok) return [];
  return Array.isArray(listed.body?.data) ? listed.body.data : [];
}

export async function loadPagarmeCardContext({ email, guru = null, otherGatewayActive = false } = {}) {
  if (!pagarmeConfigured()) {
    return emptyPagarmeCardContext();
  }
  const customer = await findPagarmeCustomerByEmail(email);
  if (!customer?.id) {
    return emptyPagarmeCardContext();
  }
  const [cards, subscriptions, orders] = await Promise.all([
    listPagarmeCustomerCards(customer.id),
    listPagarmeSubscriptionsByCustomer(customer.id),
    listRecentCustomerOrders(customer.id)
  ]);
  return buildPagarmeCardContext({
    customer,
    cards,
    subscriptions,
    orders,
    guru,
    otherGatewayActive
  });
}

export async function updatePagarmeStoredCard({ email, cardToken, card } = {}) {
  if (!pagarmeConfigured()) {
    return { ok: false, error: 'Pagar.me não configurada', status: 500 };
  }
  const customer = await findPagarmeCustomerByEmail(email);
  if (!customer?.id) {
    return { ok: false, error: 'Não encontramos um cliente Pagar.me nesta conta', status: 404 };
  }

  const payload = buildCreateCardPayload({ cardToken, card });
  if (!payload) {
    return { ok: false, error: 'Preencha os dados do cartão', status: 400 };
  }

  const created = await createPagarmeCustomerCard(customer.id, payload);
  if (!created.ok || !created.body?.id) {
    return {
      ok: false,
      error: friendlyPagarmeError(created.body?.message || created.body?.error) || 'Não foi possível salvar o cartão na Pagar.me',
      status: created.status && created.status < 500 ? created.status : 502
    };
  }

  const newCard = created.body;
  const subscriptions = await listPagarmeSubscriptionsByCustomer(customer.id);
  const targets = (subscriptions || []).filter(pagarmeSubscriptionActive);
  let updatedSubs = 0;
  let lastSubError = null;
  for (const sub of targets) {
    const patched = await updatePagarmeSubscriptionCard(sub.id, { card_id: newCard.id });
    if (patched.ok) updatedSubs += 1;
    else lastSubError = patched.body?.message || patched.body?.error || null;
  }
  if (targets.length > 0 && updatedSubs === 0) {
    return {
      ok: false,
      error: friendlyPagarmeError(lastSubError) || 'Cartão salvo, mas a assinatura Pagar.me não atualizou',
      status: 502
    };
  }

  const summary = summarizePagarmeCard(newCard);
  return {
    ok: true,
    last4: summary.last4,
    brand: summary.brand,
    has_subscription: targets.length > 0,
    updated_subscriptions: updatedSubs
  };
}
