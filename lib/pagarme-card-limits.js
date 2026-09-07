/**
 * Teto de cartão da /assinatura: 8 tentativas e 5 cartões distintos por conta/dia (BRT).
 */
import {
  cancelPagarmePaymentLink,
  findPagarmeCustomerByEmail,
  listPagarmeCharges
} from './pagarme.js';

export const PAGARME_CARD_MAX_ATTEMPTS_PER_DAY = 8;
export const PAGARME_CARD_MAX_DISTINCT_PER_DAY = 5;

export function startOfDaySaoPaulo(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  return new Date(`${day}T00:00:00-03:00`);
}

export function pagarmeCardFingerprint(charge = {}) {
  const last = charge.last_transaction && typeof charge.last_transaction === 'object'
    ? charge.last_transaction
    : {};
  const card = last.card && typeof last.card === 'object' ? last.card : (charge.card || {});
  const first = String(card.first_six_digits || card.first_four_digits || '').replace(/\D/g, '');
  const last4 = String(card.last_four_digits || '').replace(/\D/g, '');
  const brand = String(card.brand || last.card_brand || '').trim().toLowerCase();
  if (!first && !last4) return null;
  return `${brand}|${first}|${last4}`;
}

export function isPagarmeCardCharge(charge = {}) {
  return String(charge.payment_method || '').toLowerCase().includes('card');
}

export function summarizePagarmeCardUsage(charges = [], {
  now = new Date(),
  maxAttempts = PAGARME_CARD_MAX_ATTEMPTS_PER_DAY,
  maxDistinct = PAGARME_CARD_MAX_DISTINCT_PER_DAY
} = {}) {
  const since = startOfDaySaoPaulo(now).getTime();
  const cards = new Set();
  let attempts = 0;
  for (const charge of charges) {
    if (!isPagarmeCardCharge(charge)) continue;
    const created = Date.parse(charge.created_at || charge.updated_at || '');
    if (Number.isFinite(created) && created < since) continue;
    attempts += 1;
    const fp = pagarmeCardFingerprint(charge);
    if (fp) cards.add(fp);
  }
  const distinctCards = cards.size;
  const allowed = attempts < maxAttempts && distinctCards <= maxDistinct;
  return { attempts, distinctCards, allowed, maxAttempts, maxDistinct };
}

export function pagarmeCardLimitMessage(usage = {}) {
  return `Limite de tentativas no cartão atingido hoje (${usage.attempts || 0} tentativas, ${usage.distinctCards || 0} cartões). Pague no PIX ou tente de novo amanhã.`;
}

export async function loadPagarmeCardUsageForEmail(email, { now = new Date() } = {}) {
  const customer = await findPagarmeCustomerByEmail(email);
  if (!customer?.id) {
    return summarizePagarmeCardUsage([], { now });
  }
  const since = startOfDaySaoPaulo(now).toISOString();
  const rows = [];
  for (let page = 1; page <= 4; page++) {
    const listed = await listPagarmeCharges({
      page,
      size: 30,
      customerId: customer.id,
      createdSince: since
    });
    if (!listed.ok) break;
    const data = Array.isArray(listed.body?.data) ? listed.body.data : [];
    rows.push(...data);
    if (data.length < 30) break;
  }
  return summarizePagarmeCardUsage(rows, { now });
}

export async function assertPagarmeCardAllowed(email, { now = new Date() } = {}) {
  const usage = await loadPagarmeCardUsageForEmail(email, { now });
  if (usage.allowed) return { ok: true, usage };
  return {
    ok: false,
    status: 429,
    error: pagarmeCardLimitMessage(usage),
    usage
  };
}

export async function cancelAssinaturaCardLinkIfLimited({ email, paymentLinkId, now = new Date() } = {}) {
  if (!paymentLinkId || !email) return { canceled: false };
  const usage = await loadPagarmeCardUsageForEmail(email, { now });
  if (usage.allowed) return { canceled: false, usage };
  const canceled = await cancelPagarmePaymentLink(paymentLinkId);
  return { canceled: Boolean(canceled.ok), usage, status: canceled.status };
}
