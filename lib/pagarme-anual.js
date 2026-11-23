/**
 * Links públicos anuais: 1 a 10 conexões, cobrados como 10 meses e com
 * 365 dias de acesso. O pagamento acha a conta pelo e-mail do checkout.
 */
import { activateLeonaAndCancelLegacy } from './activate-after-payment.js';
import { leonaAmountCents } from './leona-pricing.js';
import { leonaProfileQuantity, lookupLeonaAccountsByEmail } from './leona.js';
import { pagarmeSubLooksLikeLeona } from './pagarme-card.js';
import { pickPaidOfferOrder } from './pagarme-offer.js';
import {
  cancelPagarmeSubscription,
  findPagarmeCustomerByEmail,
  getPagarmeOrder,
  getPagarmePaymentLink,
  listPagarmeOrdersByCode,
  listPagarmeSubscriptionsByCustomer,
  pagarmeSubscriptionActive,
  pagarmeWebhookLooksPaid
} from './pagarme.js';

const ANNUAL_CODE = /^leona-anual-10m-(10|[1-9])$/i;
const ACCESS_DAYS = 365;

export function annualAmountCents(qty) {
  return leonaAmountCents(qty) * 10;
}

export function parseAnnualCode(code) {
  const match = String(code || '').trim().match(ANNUAL_CODE);
  if (!match) return null;
  const qty = Number(match[1]);
  return { qty, code: `leona-anual-10m-${qty}` };
}

export function annualDueDateFrom(paidAt, now = new Date()) {
  const parsed = paidAt ? new Date(paidAt) : now;
  const start = Number.isFinite(parsed.getTime()) ? parsed : now;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(start.getTime() + ACCESS_DAYS * 86400000));
}

/**
 * Não reduz conexões nem encurta um vencimento que já passa do ano pago.
 */
export function annualAccessPatch(profile, { qty, dueDate } = {}) {
  const currentQty = leonaProfileQuantity(profile);
  const currentDue = String(profile?.current_period_end || profile?.due_date || '').slice(0, 10);
  const nextDue = String(dueDate || '').slice(0, 10);
  return {
    qty: Math.max(currentQty, Number(qty) || 1),
    dueDate: currentDue && nextDue && currentDue > nextDue ? currentDue : nextDue
  };
}

/**
 * Renovação mensal não pode apagar um ano já pago. Fora isso, vale o ciclo.
 */
export function renewalKeepsPrepaid(profile, { qty, dueDate } = {}) {
  const paidQty = Math.max(1, Number(qty) || 1);
  const nextDue = String(dueDate || '').slice(0, 10);
  const currentDue = String(profile?.current_period_end || profile?.due_date || '').slice(0, 10);
  if (currentDue && nextDue && currentDue > nextDue) {
    return {
      qty: Math.max(leonaProfileQuantity(profile), paidQty),
      dueDate: currentDue,
      prepaid: true
    };
  }
  return { qty: paidQty, dueDate: nextDue, prepaid: false };
}

export function pickAnnualAccount(profiles) {
  const rows = (Array.isArray(profiles) ? profiles : []).filter(Boolean);
  if (rows.length === 0) return { error: 'no_account' };
  if (rows.length === 1) return { profile: rows[0] };
  const active = rows.filter((profile) => String(profile.subscription_status || '') === 'active');
  if (active.length === 1) return { profile: active[0] };
  return { error: 'ambiguous' };
}

function pushCodes(codes, items) {
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.code) codes.push(item.code);
    if (item?.description) codes.push(item.description);
  }
}

export function findAnnualInParts({ link, order, payload } = {}) {
  const codes = [];
  pushCodes(codes, link?.cart_settings?.items);
  if (link?.order_code) codes.push(link.order_code);
  pushCodes(codes, order?.items);
  if (order?.code) codes.push(order.code);
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  pushCodes(codes, data.items);
  pushCodes(codes, data.order?.items);
  if (data.code) codes.push(data.code);
  if (data.order?.code) codes.push(data.order.code);
  if (link?.metadata?.order_code) codes.push(link.metadata.order_code);
  for (const code of codes) {
    const parsed = parseAnnualCode(code);
    if (parsed) return parsed;
  }
  return null;
}

function orderIsPaid(order) {
  if (String(order?.status || '').toLowerCase() === 'paid') return true;
  const charges = Array.isArray(order?.charges) ? order.charges : [];
  return charges.some((charge) => String(charge?.status || '').toLowerCase() === 'paid');
}

function orderEmail(order) {
  return String(order?.customer?.email || '').trim().toLowerCase();
}

function orderPaidCents(order) {
  const charge = Array.isArray(order?.charges)
    ? order.charges.find((row) => String(row?.status || '').toLowerCase() === 'paid')
    : null;
  const raw = charge?.paid_amount ?? order?.amount ?? 0;
  return Math.round(Number(raw) || 0);
}

function orderPaidAt(order) {
  const charge = Array.isArray(order?.charges)
    ? order.charges.find((row) => String(row?.status || '').toLowerCase() === 'paid')
    : null;
  return charge?.paid_at || order?.paid_at || order?.updated_at || null;
}

function payloadCode(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  return String(data.code || data.order?.code || payload?.code || '').trim();
}

function payloadEmail(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  return String(
    data.customer?.email
    || data.order?.customer?.email
    || payload?.customer?.email
    || ''
  ).trim().toLowerCase();
}

function payloadChargeId(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const candidates = [data.id, data.charge?.id, payload?.id];
  return candidates.map((value) => String(value || '').trim()).find((value) => /^ch_/i.test(value)) || '';
}

export function pagarmeSubsToCancel(subs) {
  return (Array.isArray(subs) ? subs : []).filter((sub) =>
    pagarmeSubscriptionActive(sub) && pagarmeSubLooksLikeLeona(sub)
  );
}

async function stopMonthlyPagarme(email) {
  const customer = await findPagarmeCustomerByEmail(email);
  if (!customer?.id) return { skipped: true, reason: 'no_customer' };
  const subs = await listPagarmeSubscriptionsByCustomer(customer.id, { size: 30 });
  const targets = pagarmeSubsToCancel(subs);
  const results = [];
  for (const sub of targets) {
    const canceled = await cancelPagarmeSubscription(sub.id);
    if (!canceled.ok && (canceled.status == null || canceled.status >= 500)) {
      return { retry: true, error: 'pagarme_cancel_failed', results };
    }
    results.push({ id: sub.id, ok: Boolean(canceled.ok), status: canceled.status || null });
  }
  return { cancelled: results };
}

export async function fulfillAnnualWebhook({
  paymentLinkId = null,
  orderId = null,
  payload = {}
} = {}, deps = {}) {
  const hinted = findAnnualInParts({ payload });
  const code = payloadCode(payload);
  if (!hinted && !paymentLinkId && !orderId) return { handled: false };
  if (!hinted && code && !parseAnnualCode(code) && !paymentLinkId) return { handled: false };

  const getLink = deps.getPaymentLink || getPagarmePaymentLink;
  const getOrder = deps.getOrder || getPagarmeOrder;
  const listByCode = deps.listOrdersByCode || listPagarmeOrdersByCode;
  const lookup = deps.lookupAccounts || ((email) => lookupLeonaAccountsByEmail(email, process.env.LEONA_BILLING_TOKEN));
  const activate = deps.activate || activateLeonaAndCancelLegacy;
  const stopMonthly = deps.stopMonthly || stopMonthlyPagarme;
  const now = deps.now || new Date();

  let link = null;
  if (paymentLinkId) {
    const fetched = await getLink(paymentLinkId);
    if (!fetched?.ok) {
      if (!hinted) return { handled: false };
      if (fetched?.status >= 500 || fetched?.status == null) {
        return { handled: true, retry: true, error: 'link_fetch_failed' };
      }
    }
    link = fetched?.ok ? fetched.body : null;
  }

  let order = null;
  if (orderId) {
    const fetched = await getOrder(orderId);
    if (!fetched?.ok) {
      if (!hinted && !findAnnualInParts({ link })) return { handled: false };
      if (fetched?.status >= 500 || fetched?.status == null) {
        return { handled: true, retry: true, error: 'order_fetch_failed' };
      }
    }
    order = fetched?.ok ? fetched.body : null;
  }

  const annual = findAnnualInParts({ link, order, payload });
  if (!annual) return { handled: false };

  if (!order && pagarmeWebhookLooksPaid(payload)) {
    const listed = await listByCode(annual.code);
    if (!listed?.ok) return { handled: true, retry: true, error: 'order_fetch_failed' };
    const picked = pickPaidOfferOrder(listed.body?.data, {
      chargeId: payloadChargeId(payload),
      email: payloadEmail(payload)
    });
    if (picked.error) return { handled: true, processed: false, error: picked.error, qty: annual.qty };
    order = picked.order;
  }

  if (!orderIsPaid(order)) {
    if (pagarmeWebhookLooksPaid(payload)) {
      return { handled: true, retry: true, error: 'order_not_paid_yet' };
    }
    return { handled: true, processed: false, ignored: true, qty: annual.qty };
  }

  const expected = annualAmountCents(annual.qty);
  if (orderPaidCents(order) !== expected) {
    return { handled: true, processed: false, error: 'amount_mismatch', qty: annual.qty, amount_cents: orderPaidCents(order) };
  }

  const email = orderEmail(order);
  if (!email) return { handled: true, processed: false, error: 'no_email', qty: annual.qty };

  const found = await lookup(email);
  if (!found?.ok) return { handled: true, retry: true, error: found?.error || 'leona_lookup_failed' };
  const picked = pickAnnualAccount(found.profiles);
  if (!picked.profile) {
    return { handled: true, processed: false, error: picked.error, email, qty: annual.qty };
  }

  const dueDate = annualDueDateFrom(orderPaidAt(order), now);
  const access = annualAccessPatch(picked.profile, { qty: annual.qty, dueDate });
  const accountId = String(picked.profile.account_id);
  const activated = await activate({
    accountId,
    qty: access.qty,
    dueDate: access.dueDate,
    email,
    profile: picked.profile,
    reason: 'Leona anual — 10 meses, 1 ano de acesso'
  });
  if (!activated?.ok) {
    return { handled: true, retry: true, error: activated?.error || 'leona_update_failed', account_id: accountId };
  }

  const stopped = await stopMonthly(email);
  if (stopped?.retry) {
    return { handled: true, retry: true, error: stopped.error || 'pagarme_cancel_failed', account_id: accountId };
  }

  return {
    handled: true,
    processed: true,
    account_id: accountId,
    email,
    qty: access.qty,
    due_date: access.dueDate,
    amount_cents: expected,
    paid_qty: annual.qty,
    pagarme_subscriptions: stopped?.cancelled || [],
    access_days: ACCESS_DAYS
  };
}
