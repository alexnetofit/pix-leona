/**
 * Comissão de afiliado do checkout novo (Pagarme e Paddle).
 *
 * O código é `leona-{conta}-{qty}-{sub|pro-rata}-{yyyyMMdd}-{unix}`.
 * A /assinatura antiga (`leona-{conta}-{qty}-sub` ou `prorata`, sem data)
 * já avisa o painel em pagarme-assinatura.js — aqui não entra de novo.
 *
 * O painel acha o afiliado pelo e-mail do dono da conta Leona
 * (rewardful_referral). O e-mail do cartão na Paddle pode ser outro.
 * Valor em centavos de BRL: venda em outra moeda usa o payout USD × PTAX.
 */
import { getLeonaBillingProfile } from './leona.js';
import { getPagarmeOrder } from './pagarme.js';
import { getCustomer, getTransaction } from './paddle-client.js';
import { notifyAffiliatesPagou } from './notify-affiliates.js';
import { paddleSaleBrlCents, usdToBrlPtax } from './revenue-source.js';

const NEW_LEONA_ORDER_CODE = /^leona-(\d+)-(\d+)-(sub|pro-rata)-\d{8}-\d+$/i;

export function parseNewLeonaOrderCode(code) {
  const raw = String(code || '').trim();
  const match = raw.match(NEW_LEONA_ORDER_CODE);
  if (!match) return null;
  return {
    code: raw,
    accountId: match[1],
    qty: Number(match[2]),
    kind: match[3].toLowerCase()
  };
}

export function newCheckoutTxId(gateway, externalId) {
  const id = String(externalId || '').trim();
  if (!id) return '';
  if (gateway === 'paddle') return /^paddle:/i.test(id) ? id : `paddle:${id}`;
  return /^pagarme:/i.test(id) ? id : `pagarme:${id}`;
}

export function newCheckoutContact(profile, fallback = {}) {
  return {
    email: String(profile?.user?.email || fallback.email || '').trim().toLowerCase(),
    name: profile?.user?.name || fallback.name || null
  };
}

export function pagarmeNewCheckoutAffiliateStatus(payload = {}) {
  const type = String(payload.type || payload.event || '').toLowerCase();
  const status = String(payload.data?.status || payload.status || '').toLowerCase();
  if (type.includes('chargedback') || type.includes('chargeback') || status === 'chargedback' || status === 'chargeback') {
    return 'chargeback';
  }
  if (type.includes('refund') || status === 'refunded' || type === 'order.canceled' || type === 'charge.canceled') {
    return 'refunded';
  }
  if (['order.paid', 'charge.paid', 'checkout.closed', 'invoice.paid'].includes(type)) return 'approved';
  if (status === 'paid' || status === 'closed') return 'approved';
  return null;
}

export function pagarmeOrderCandidate(payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const nested = data.order && typeof data.order === 'object' ? data.order : null;
  if (data.code || /^or_/i.test(String(data.id || ''))) {
    return { id: String(data.id || ''), code: String(data.code || '').trim(), order: data };
  }
  if (nested) {
    return {
      id: String(nested.id || ''),
      code: String(nested.code || '').trim(),
      order: {
        ...nested,
        customer: nested.customer || data.customer,
        paid_amount: nested.paid_amount || data.paid_amount,
        amount: nested.amount || data.amount,
        charges: nested.charges || (data.paid_amount || data.amount ? [data] : undefined)
      }
    };
  }
  return { id: '', code: '', order: data };
}

export function pagarmeNewCheckoutAmountCents(order = {}) {
  const charge = Array.isArray(order.charges) ? order.charges[0] : null;
  const raw = charge?.paid_amount ?? charge?.amount ?? order.paid_amount ?? order.amount ?? 0;
  const amount = Math.round(Number(raw));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function paddleFullyReversed(transaction, adjustment = null) {
  const adjusted = transaction?.details?.adjusted_totals;
  if (adjusted && adjusted.grand_total != null && adjusted.grand_total !== '' && Number(adjusted.grand_total) <= 0) {
    return true;
  }
  const original = Number(transaction?.details?.totals?.grand_total);
  const refunded = Number(adjustment?.totals?.total ?? adjustment?.totals?.grand_total);
  return original > 0 && Number.isFinite(refunded) && refunded >= original;
}

export function newCheckoutPaddleGrossCents(transaction, usdToBrlRate = null) {
  return paddleSaleBrlCents(transaction, usdToBrlRate)?.gross || 0;
}

function saleDayBrt(iso) {
  const date = new Date(iso || Date.now());
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

async function paddleGrossBrlCents(transaction) {
  const currency = String(
    transaction?.details?.totals?.currency_code || transaction?.currency_code || 'BRL'
  ).toUpperCase();
  let rate = null;
  if (currency !== 'BRL') {
    const day = saleDayBrt(transaction?.billed_at || transaction?.created_at);
    rate = day ? await usdToBrlPtax(day) : null;
    if (!(Number(rate) > 0)) return { amountCents: 0, reason: 'fx_unavailable' };
  }
  const amountCents = newCheckoutPaddleGrossCents(transaction, rate);
  return { amountCents, reason: amountCents > 0 ? null : 'no_amount' };
}

function affiliateRetryable(result) {
  return Boolean(result && result.ok === false && !result.skipped && (result.http == null || result.http >= 500));
}

export async function notifyNewCheckoutSale({
  gateway,
  externalId,
  email,
  name,
  amountCents,
  paidAt,
  status = 'approved',
  skipReason = null,
  notify = notifyAffiliatesPagou
}) {
  const txId = newCheckoutTxId(gateway, externalId);
  if (!txId) return { handled: true, skipped: true, reason: 'missing_tx' };
  if (!email) return { handled: true, skipped: true, reason: 'missing_email' };
  if (status === 'approved' && !(Number(amountCents) > 0)) {
    const reason = skipReason || 'no_amount';
    return { handled: true, skipped: true, reason, retry: reason === 'fx_unavailable' };
  }
  const sent = await notify({
    txId,
    email,
    name,
    amountCents,
    paidAt,
    status
  });
  return { handled: true, ...sent, retry: affiliateRetryable(sent) };
}

async function profileFor(accountId, getProfile) {
  const load = getProfile || ((id) => getLeonaBillingProfile(id, process.env.LEONA_BILLING_TOKEN));
  return load(accountId);
}

export async function notifyPagarmeNewCheckoutFromWebhook({
  payload = {},
  orderId = null,
  getOrder = getPagarmeOrder,
  getProfile,
  notify
} = {}) {
  const status = pagarmeNewCheckoutAffiliateStatus(payload);
  if (!status) return { handled: false };

  let candidate = pagarmeOrderCandidate(payload);
  let parsed = parseNewLeonaOrderCode(candidate.code);
  if (!parsed && candidate.code) return { handled: false };

  if (!parsed) {
    const id = orderId || candidate.id;
    if (!/^or_/i.test(String(id || ''))) return { handled: false };
    const fetched = await getOrder(id);
    if (!fetched?.ok) return { handled: false, ok: false, error: 'order_fetch_failed', retry: true };
    const order = fetched.body || {};
    candidate = { id: String(order.id || id), code: String(order.code || '').trim(), order };
    parsed = parseNewLeonaOrderCode(candidate.code);
    if (!parsed) return { handled: false };
  }

  const profile = await profileFor(parsed.accountId, getProfile);
  const contact = newCheckoutContact(profile, {
    email: candidate.order?.customer?.email,
    name: candidate.order?.customer?.name
  });
  const paidAt = candidate.order?.charges?.[0]?.paid_at
    || candidate.order?.updated_at
    || candidate.order?.paid_at
    || null;

  return notifyNewCheckoutSale({
    gateway: 'pagarme',
    externalId: candidate.id || orderId,
    email: contact.email,
    name: contact.name,
    amountCents: pagarmeNewCheckoutAmountCents(candidate.order),
    paidAt,
    status,
    notify
  });
}

function paddleAdjustmentStatus(action) {
  if (action === 'refund') return 'refunded';
  if (action === 'chargeback' || action === 'chargeback_warning') return 'chargeback';
  return null;
}

export async function notifyPaddleNewCheckoutEvent(event, deps = {}) {
  const eventType = String(event?.event_type || event?.type || '');
  const data = event?.data || {};
  const loadTransaction = deps.getTransaction || getTransaction;
  const loadCustomer = deps.getCustomer || getCustomer;
  const notify = deps.notify;
  const getProfile = deps.getProfile
    || ((id) => getLeonaBillingProfile(id, deps.leonaToken || process.env.LEONA_BILLING_TOKEN));

  if (eventType === 'transaction.completed') {
    let transaction = data;
    let parsed = parseNewLeonaOrderCode(transaction?.custom_data?.leona_order_code);
    if (!parsed) return { handled: false };
    if (!transaction?.details?.totals) {
      try {
        transaction = await loadTransaction(data.id);
      } catch (err) {
        return { handled: true, ok: false, error: err.message, retry: true };
      }
      parsed = parseNewLeonaOrderCode(transaction?.custom_data?.leona_order_code);
      if (!parsed) return { handled: false };
    }
    return notifyPaddleTransaction(transaction, 'approved', { getProfile, loadCustomer, notify });
  }

  if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') {
    const action = String(data.action || '').toLowerCase();
    const reversal = paddleAdjustmentStatus(action);
    if (!reversal) return { handled: false };
    let transaction;
    try {
      transaction = await loadTransaction(data.transaction_id, true);
    } catch (err) {
      return { handled: false, ok: false, error: err.message, retry: true };
    }
    const parsed = parseNewLeonaOrderCode(transaction?.custom_data?.leona_order_code);
    if (!parsed) return { handled: false };
    if (String(data.status || '').toLowerCase() !== 'approved') {
      return { handled: true, skipped: true, reason: 'adjustment_pending' };
    }
    if (reversal === 'refunded' && !paddleFullyReversed(transaction, data)) {
      return { handled: true, skipped: true, reason: 'partial_refund' };
    }
    return notifyPaddleTransaction(transaction, reversal, { getProfile, loadCustomer, notify });
  }

  return { handled: false };
}

async function notifyPaddleTransaction(transaction, status, { getProfile, loadCustomer, notify }) {
  const parsed = parseNewLeonaOrderCode(transaction?.custom_data?.leona_order_code);
  if (!parsed) return { handled: false };
  const profile = await profileFor(parsed.accountId, getProfile);
  let contact = newCheckoutContact(profile, {});
  if (!contact.email && transaction?.customer_id) {
    try {
      const customer = await loadCustomer(transaction.customer_id);
      contact = newCheckoutContact(null, { email: customer?.email, name: customer?.name });
    } catch (err) {
      console.error('affiliates-new-checkout: customer paddle', err.message);
    }
  }
  const priced = status === 'approved' ? await paddleGrossBrlCents(transaction) : { amountCents: 0, reason: null };
  return notifyNewCheckoutSale({
    gateway: 'paddle',
    externalId: transaction.id,
    email: contact.email,
    name: contact.name,
    amountCents: priced.amountCents,
    paidAt: transaction.billed_at || transaction.created_at || null,
    status,
    skipReason: priced.reason,
    notify
  });
}
