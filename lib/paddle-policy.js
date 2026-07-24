const DAY_MS = 24 * 60 * 60 * 1000;

export const REFUND_WINDOW_MS = 7 * DAY_MS;

function time(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || value.trim() === '') return NaN;
  return Date.parse(value);
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function successfulCaptureTime(transaction) {
  const payments = Array.isArray(transaction?.payments) ? transaction.payments : [];
  const captures = payments
    .filter(payment => ['completed', 'captured'].includes(String(payment?.status || '').toLowerCase()))
    .map(payment => time(payment?.captured_at))
    .filter(Number.isFinite);

  return captures.length > 0 ? Math.min(...captures) : NaN;
}

/**
 * A janela começa na captura bem-sucedida. Campos da transaction são usados
 * apenas para payloads antigos que não possuem payments[].captured_at.
 */
export function refundEligibility(transaction, now = new Date()) {
  if (String(transaction?.status || '').toLowerCase() !== 'completed') {
    return { eligible: false, reason: 'transaction_not_completed', paidAt: null, deadline: null };
  }

  let paidAtMs = successfulCaptureTime(transaction);
  let source = 'payments.captured_at';

  if (!Number.isFinite(paidAtMs)) {
    for (const field of ['completed_at', 'billed_at', 'created_at']) {
      const candidate = time(transaction?.[field]);
      if (Number.isFinite(candidate)) {
        paidAtMs = candidate;
        source = field;
        break;
      }
    }
  }

  const nowMs = time(now);
  if (!Number.isFinite(paidAtMs) || !Number.isFinite(nowMs)) {
    return { eligible: false, reason: 'invalid_date', paidAt: iso(paidAtMs), deadline: null };
  }

  const deadlineMs = paidAtMs + REFUND_WINDOW_MS;
  const base = { paidAt: iso(paidAtMs), deadline: iso(deadlineMs), source };
  if (paidAtMs > nowMs) return { eligible: false, reason: 'payment_in_future', ...base };
  if (nowMs > deadlineMs) return { eligible: false, reason: 'refund_window_expired', ...base };
  return { eligible: true, reason: 'within_refund_window', ...base };
}

function money(value) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function transactionTotal(transaction) {
  const candidates = [
    transaction?.details?.totals?.grand_total,
    transaction?.totals?.grand_total,
    transaction?.grand_total,
    transaction?.total
  ];
  for (const candidate of candidates) {
    const amount = money(candidate);
    if (amount !== null) return amount;
  }
  return null;
}

/**
 * Reembolso parcial nunca corta o período já adquirido. O entitlement só é
 * revogado quando um reembolso integral foi efetivamente aprovado.
 */
export function refundDecision({ transaction, requestedAmount, approved = false, now = new Date() }) {
  const eligibility = refundEligibility(transaction, now);
  const total = transactionTotal(transaction);
  const amount = money(requestedAmount);

  if (total === null || total <= 0 || amount === null || amount <= 0 || amount > total) {
    return {
      approved: false,
      kind: null,
      revokeEntitlement: false,
      reason: 'invalid_refund_amount',
      eligibility
    };
  }

  const kind = amount === total ? 'full' : 'partial';
  const canApprove = eligibility.eligible;
  const isApproved = Boolean(approved && canApprove);
  return {
    approved: isApproved,
    kind,
    revokeEntitlement: isApproved && kind === 'full',
    reason: canApprove ? (isApproved ? 'approved' : 'pending_approval') : eligibility.reason,
    eligibility
  };
}

export function unitPriceForQuantity(quantity) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) return null;
  if (qty === 1) return 12700;
  if (qty <= 3) return 9900;
  return 7900;
}

export function totalPriceForQuantity(quantity) {
  const unitPrice = unitPriceForQuantity(quantity);
  return unitPrice === null ? null : unitPrice * Number(quantity);
}

function isOneTimeItem(item) {
  const type = String(item?.price?.type ?? item?.type ?? '').toLowerCase().replace(/[- ]/g, '_');
  if (['one_time', 'onetime', 'non_recurring'].includes(type)) return true;
  if (item?.recurring === false) return true;
  return item?.price && Object.prototype.hasOwnProperty.call(item.price, 'billing_cycle')
    && item.price.billing_cycle == null;
}

export function sumRecurringQuantity(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    if (isOneTimeItem(item)) return sum;
    const quantity = Number(item?.quantity);
    return Number.isFinite(quantity) && quantity > 0 ? sum + quantity : sum;
  }, 0);
}

/** Retorna o dia civil anterior no fuso BRT (UTC-03:00). */
export function brtYesterday(now = new Date()) {
  const nowMs = time(now);
  if (!Number.isFinite(nowMs)) return null;
  const brtDate = new Date(nowMs - 3 * 60 * 60 * 1000);
  brtDate.setUTCDate(brtDate.getUTCDate() - 1);
  return brtDate.toISOString().slice(0, 10);
}

export function classifyQuantityChange(current, target) {
  const from = Number(current);
  const to = Number(target);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) return 'invalid';
  if (to > from) return 'upgrade';
  if (to < from) return 'downgrade';
  return 'unchanged';
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildIntentFingerprint(accountOrInput, kind, current, target, cycle) {
  const input = accountOrInput && typeof accountOrInput === 'object'
    ? accountOrInput
    : { account: accountOrInput, kind, current, target, cycle };
  return stable({
    account: input.account ?? input.accountId ?? input.account_id ?? null,
    kind: input.kind ?? null,
    current: input.current ?? input.currentQuantity ?? input.current_quantity ?? null,
    target: input.target ?? input.targetQuantity ?? input.target_quantity ?? null,
    cycle: input.cycle ?? input.billingCycle ?? input.billing_cycle ?? null
  });
}

/**
 * Eventos com o mesmo occurred_at também são ignorados: reaplicar um empate
 * deixaria o resultado dependente da ordem de entrega.
 */
export function shouldApplyEvent(eventOrOccurredAt, lastEventOrOccurredAt = null) {
  const occurredAt = eventOrOccurredAt && typeof eventOrOccurredAt === 'object'
    ? eventOrOccurredAt.occurred_at
    : eventOrOccurredAt;
  const lastOccurredAt = lastEventOrOccurredAt && typeof lastEventOrOccurredAt === 'object'
    ? lastEventOrOccurredAt.occurred_at
    : lastEventOrOccurredAt;
  const incomingMs = time(occurredAt);
  if (!Number.isFinite(incomingMs)) return false;
  if (lastOccurredAt == null || lastOccurredAt === '') return true;
  const previousMs = time(lastOccurredAt);
  return Number.isFinite(previousMs) && incomingMs > previousMs;
}

const SETTLED_PIX_STATUSES = new Set(['paid', 'completed']);
const EXPIRED_PIX_STATUSES = new Set(['expired', 'cancelled', 'canceled']);

/**
 * Um PIX liquidado não expira. Nos demais casos prevalece o status explícito;
 * depois, expires_at e por fim o cutoff operacional.
 */
export function pixExpirationDecision(pix, now = new Date(), cutoff = null) {
  const status = String(pix?.status || '').toLowerCase();
  if (SETTLED_PIX_STATUSES.has(status)) return { expired: false, reason: 'settled' };
  if (EXPIRED_PIX_STATUSES.has(status)) return { expired: true, reason: 'status' };

  const nowMs = time(now);
  if (!Number.isFinite(nowMs)) return { expired: false, reason: 'invalid_now' };
  const expiresMs = time(pix?.expires_at ?? pix?.expiresAt);
  if (Number.isFinite(expiresMs) && nowMs >= expiresMs) return { expired: true, reason: 'expires_at' };
  const cutoffMs = time(cutoff ?? pix?.cutoff_at ?? pix?.cutoffAt);
  if (Number.isFinite(cutoffMs) && nowMs >= cutoffMs) return { expired: true, reason: 'cutoff' };
  return { expired: false, reason: 'pending' };
}

export function isPixExpired(pix, now = new Date(), cutoff = null) {
  return pixExpirationDecision(pix, now, cutoff).expired;
}

/**
 * Downgrade é financeiro imediatamente, mas preserva assentos adquiridos até
 * effective_at. Upgrade e mudança neutra passam a valer imediatamente.
 */
export function projectEntitlement({
  currentQuantity,
  targetQuantity,
  effectiveAt = null,
  now = new Date()
}) {
  const change = classifyQuantityChange(currentQuantity, targetQuantity);
  if (change === 'invalid') return null;

  const current = Number(currentQuantity);
  const target = Number(targetQuantity);
  const nowMs = time(now);
  const effectiveMs = time(effectiveAt);
  const beforeEffectiveAt = change === 'downgrade'
    && Number.isFinite(nowMs)
    && Number.isFinite(effectiveMs)
    && nowMs < effectiveMs;

  return {
    change,
    financialQuantity: target,
    entitledQuantity: beforeEffectiveAt ? current : target,
    effectiveAt: Number.isFinite(effectiveMs) ? iso(effectiveMs) : null
  };
}
