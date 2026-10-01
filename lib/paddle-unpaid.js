import { paddleRequest } from './paddle-client.js';

/**
 * Na renovação a Paddle avança next_billed_at e dispara subscription.updated
 * ANTES de cobrar. Se o cartão recusa, a transaction recorrente fica billed /
 * past_due e a assinatura continua com o período novo. Só transaction.completed
 * prova pagamento — o resto não pode estender o vencimento na Leona.
 */
const UNPAID_STATUSES = new Set(['billed', 'past_due']);

export function toDueDate(iso) {
  if (!iso) return null;
  const s = String(iso);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function isUnpaidRenewal(txn) {
  return String(txn?.origin || '') === 'subscription_recurring'
    && UNPAID_STATUSES.has(String(txn?.status || '').toLowerCase())
    && Boolean(txn?.billing_period?.starts_at);
}

/** A mais antiga em aberto: o cliente pagou até o início dela. */
export function pickUnpaidRenewal(transactions = []) {
  return (transactions || [])
    .filter(isUnpaidRenewal)
    .sort((a, b) => String(a.billing_period.starts_at).localeCompare(String(b.billing_period.starts_at)))[0] || null;
}

export function unpaidRenewalDueDate(txn) {
  return isUnpaidRenewal(txn) ? toDueDate(txn.billing_period.starts_at) : null;
}

/**
 * Retorna a renovação em aberto da assinatura, ou null. Em erro de API
 * devolve { error } pra quem chama não estender às cegas.
 */
export async function findUnpaidRenewal(subscriptionId, { token, request = paddleRequest } = {}) {
  if (!subscriptionId) return null;
  try {
    const qs = new URLSearchParams({
      subscription_id: subscriptionId,
      status: 'billed,past_due',
      per_page: '30'
    });
    const result = await request(`/transactions?${qs}`, { token });
    const rows = Array.isArray(result?.data) ? result.data : [];
    return pickUnpaidRenewal(rows);
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

/** Puxa o vencimento pra trás; nunca devolve data posterior à atual. */
export function pullBackDueDate(currentPeriodEnd, target) {
  if (!target) return null;
  const current = toDueDate(currentPeriodEnd);
  if (current && current <= target) return null;
  return target;
}
