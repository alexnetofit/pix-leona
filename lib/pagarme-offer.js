/**
 * Links públicos da oferta Samuel Corvo: 1 a 5 conexões, 40% no primeiro mês,
 * válidos até 12/12/2026 (fim do dia em Brasília). O pagamento ativa a conta
 * e grava o afiliado. Esta compra não gera comissão.
 */
import { activateLeonaAndCancelLegacy } from './activate-after-payment.js';
import { dueDatePlusDays, leonaAmountCents } from './leona-pricing.js';
import { lookupLeonaAccountsByEmail, updateLeonaBillingProfile } from './leona.js';
import {
  getPagarmeOrder,
  getPagarmePaymentLink,
  listPagarmeOrdersByCode,
  pagarmeWebhookLooksPaid
} from './pagarme.js';

export const CORVO_OFFER = {
  id: 'corvo40',
  affiliateCode: '48B29E6C',
  affiliateName: 'Samuel Corvo',
  discountPercent: 40,
  expiresAt: '2026-12-13T02:59:59.000Z',
  quantities: [1, 2, 3, 4, 5]
};

const OFFER_CODE = /^offer-corvo40-([1-5])-([A-Za-z0-9]+)$/i;

export function offerAmountCents(qty) {
  const full = leonaAmountCents(qty);
  return Math.round(full * (100 - CORVO_OFFER.discountPercent) / 100);
}

export function offerItemCode(qty, affiliateCode = CORVO_OFFER.affiliateCode) {
  const n = Number(qty);
  return `offer-corvo40-${n}-${String(affiliateCode || '').trim().toUpperCase()}`;
}

export function parseOfferItemCode(code) {
  const match = String(code || '').trim().match(OFFER_CODE);
  if (!match) return null;
  return {
    qty: Number(match[1]),
    affiliateCode: match[2].toUpperCase(),
    offerId: CORVO_OFFER.id
  };
}

export function offerExpiresInMinutes(now = new Date()) {
  const end = new Date(CORVO_OFFER.expiresAt).getTime();
  const mins = Math.floor((end - now.getTime()) / 60000);
  return Math.max(1, mins);
}

export function buildCorvoOfferPaymentLinkPayload({ qty, now = new Date() } = {}) {
  const n = Number(qty);
  const parsed = parseOfferItemCode(offerItemCode(n));
  if (!parsed) throw new Error(`qty inválida: ${qty}`);
  const amount = offerAmountCents(n);
  const name = `Leona Flow — ${n} conex${n === 1 ? 'ão' : 'ões'}`.slice(0, 64);
  const code = offerItemCode(n, parsed.affiliateCode);
  return {
    type: 'order',
    name,
    order_code: code,
    max_paid_sessions: 500,
    expires_in: offerExpiresInMinutes(now),
    payment_settings: {
      accepted_payment_methods: ['credit_card', 'pix'],
      pix_settings: { expires_in: 3600 },
      credit_card_settings: {
        operation_type: 'auth_and_capture',
        installments: [{ number: 1, total: amount }]
      }
    },
    cart_settings: {
      items: [{
        name,
        amount,
        default_quantity: 1,
        code,
        description: 'Primeiro mês com 40% de desconto'
      }]
    },
    metadata: {
      leona_offer: CORVO_OFFER.id,
      qty: String(n),
      affiliate_code: parsed.affiliateCode,
      skip_commission: 'true'
    }
  };
}

function pushCodes(codes, items) {
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.code) codes.push(item.code);
    if (item?.description) codes.push(item.description);
  }
}

export function findOfferInParts({ link, order, payload } = {}) {
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
  for (const code of codes) {
    const parsed = parseOfferItemCode(code);
    if (parsed) return parsed;
  }
  return null;
}

export function offerActivationPatch(profile, { qty, affiliateCode, dueDate } = {}) {
  const currentQty = Number(profile?.starter_instances) || 0;
  const nextQty = Math.max(currentQty, Number(qty) || 1);
  const currentDue = String(profile?.current_period_end || profile?.due_date || '').slice(0, 10);
  const due = currentDue && currentDue > dueDate ? currentDue : dueDate;
  const patch = {
    starter_instances: nextQty,
    status: 'active',
    due_date: due
  };
  const currentRef = String(profile?.rewardful_referral || '').trim();
  let referral = 'kept_other';
  if (!currentRef) {
    patch.affiliate_code = affiliateCode;
    referral = 'set';
  } else if (currentRef.toUpperCase() === String(affiliateCode || '').toUpperCase()) {
    referral = 'already';
  }
  return { patch, referral, commission: 'skipped' };
}

function pickOfferAccount(profiles, affiliateCode) {
  const rows = Array.isArray(profiles) ? profiles.filter(Boolean) : [];
  if (rows.length === 0) return { error: 'no_account' };
  if (rows.length === 1) return { profile: rows[0] };
  const own = rows.filter((profile) =>
    String(profile.rewardful_referral || '').toUpperCase() === String(affiliateCode || '').toUpperCase()
  );
  if (own.length === 1) return { profile: own[0] };
  const active = rows.filter((profile) => String(profile.subscription_status || '') === 'active');
  if (active.length === 1) return { profile: active[0] };
  return { error: 'ambiguous' };
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
  const charge = Array.isArray(order?.charges) ? order.charges.find((row) => String(row?.status || '').toLowerCase() === 'paid') : null;
  const raw = charge?.paid_amount ?? order?.amount ?? 0;
  return Math.round(Number(raw) || 0);
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

/**
 * O link da oferta usa um order_code só. Vários clientes pagos aparecem na
 * mesma busca. O webhook traz a cobrança ou o e-mail de quem acabou de pagar.
 */
export function pickPaidOfferOrder(rows, { chargeId = '', email = '' } = {}) {
  const paid = (Array.isArray(rows) ? rows : []).filter(orderIsPaid);
  if (chargeId) {
    const byCharge = paid.filter((order) =>
      (Array.isArray(order.charges) ? order.charges : []).some((charge) => charge?.id === chargeId)
    );
    if (byCharge.length === 1) return { order: byCharge[0] };
  }
  if (email) {
    const byEmail = paid.filter((order) => orderEmail(order) === email);
    if (byEmail.length === 1) return { order: byEmail[0] };
    if (byEmail.length > 1) return { error: 'ambiguous_order' };
  }
  if (paid.length === 1) return { order: paid[0] };
  if (paid.length > 1) return { error: 'ambiguous_order' };
  return { order: null };
}

export async function fulfillCorvoOfferWebhook({
  paymentLinkId = null,
  orderId = null,
  payload = {}
} = {}, deps = {}) {
  const hinted = findOfferInParts({ payload });
  const code = payloadCode(payload);
  if (!hinted && code && !parseOfferItemCode(code)) return { handled: false };
  if (!hinted && !paymentLinkId && !orderId) return { handled: false };

  const getLink = deps.getPaymentLink || getPagarmePaymentLink;
  const getOrder = deps.getOrder || getPagarmeOrder;
  const listByCode = deps.listOrdersByCode || listPagarmeOrdersByCode;
  const lookup = deps.lookupAccounts || ((email) => lookupLeonaAccountsByEmail(email, process.env.LEONA_BILLING_TOKEN));
  const update = deps.updateProfile || ((id, patch) => updateLeonaBillingProfile(id, patch, process.env.LEONA_BILLING_TOKEN));
  const activate = deps.activate || activateLeonaAndCancelLegacy;
  const dueDate = deps.dueDate || dueDatePlusDays(30);

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
      if (!hinted && !findOfferInParts({ link })) return { handled: false };
      if (fetched?.status >= 500 || fetched?.status == null) {
        return { handled: true, retry: true, error: 'order_fetch_failed' };
      }
    }
    order = fetched?.ok ? fetched.body : null;
  }

  const offer = findOfferInParts({ link, order, payload });
  if (!offer) return { handled: false };

  if (!order && link?.order_code && pagarmeWebhookLooksPaid(payload)) {
    const listed = await listByCode(link.order_code);
    if (!listed?.ok) return { handled: true, retry: true, error: 'order_fetch_failed' };
    const picked = pickPaidOfferOrder(listed.body?.data, {
      chargeId: payloadChargeId(payload),
      email: payloadEmail(payload)
    });
    if (picked.error) {
      return { handled: true, processed: false, error: picked.error, commission: 'skipped' };
    }
    order = picked.order;
  }

  if (!orderIsPaid(order)) {
    if (pagarmeWebhookLooksPaid(payload)) {
      return { handled: true, retry: true, error: 'order_not_paid_yet' };
    }
    return { handled: true, processed: false, ignored: true, offer: offer.offerId };
  }

  if (orderPaidCents(order) !== offerAmountCents(offer.qty)) {
    return { handled: true, processed: false, error: 'amount_mismatch', commission: 'skipped' };
  }

  const email = orderEmail(order);
  if (!email) return { handled: true, processed: false, error: 'no_email', commission: 'skipped' };

  const found = await lookup(email);
  if (!found?.ok) return { handled: true, retry: true, error: found?.error || 'leona_lookup_failed' };
  const picked = pickOfferAccount(found.profiles, offer.affiliateCode);
  if (!picked.profile) {
    return {
      handled: true,
      processed: false,
      error: picked.error,
      email,
      commission: 'skipped'
    };
  }

  const { patch, referral } = offerActivationPatch(picked.profile, {
    qty: offer.qty,
    affiliateCode: offer.affiliateCode,
    dueDate
  });
  const accountId = String(picked.profile.account_id);
  const activated = await activate({
    accountId,
    qty: patch.starter_instances,
    dueDate: patch.due_date,
    email,
    profile: picked.profile,
    reason: 'Oferta Samuel Corvo 40%'
  });
  if (!activated?.ok) {
    return { handled: true, retry: true, error: activated?.error || 'leona_update_failed', account_id: accountId };
  }

  let referralResult = referral;
  if (patch.affiliate_code) {
    const saved = await update(accountId, { affiliate_code: patch.affiliate_code });
    if (!saved?.ok) {
      return { handled: true, retry: true, error: 'referral_failed', account_id: accountId };
    }
    referralResult = 'set';
  }

  return {
    handled: true,
    processed: true,
    commission: 'skipped',
    offer: offer.offerId,
    account_id: accountId,
    email,
    qty: patch.starter_instances,
    due_date: patch.due_date,
    referral: referralResult,
    amount_cents: offerAmountCents(offer.qty)
  };
}
