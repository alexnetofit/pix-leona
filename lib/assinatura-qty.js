/**
 * Qty inicial do seletor na /assinatura quando o ciclo venceu.
 * Não começa em 1 se a gente ainda souber o plano anterior.
 *
 * Upgrade (Guru / Pagar.me / Paddle) cobra só o pró-rata, mas a qty
 * gravada no pagamento é o plano alvo — nunca o delta (+2) nem o
 * item.quantity=1 da linha avulsa.
 */
import { extractInstances } from './guru-webhook-payload.js';

export function qtyFromPlanName(name) {
  const n = extractInstances(name);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function qtyFromLeonaCode(code) {
  const raw = String(code || '').trim();
  const dashed = raw.match(/^leona-(.+)-(\d+)-(prorata|sub)$/i);
  if (dashed) {
    const n = Number(dashed[2]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export function paymentWhen(row) {
  return String(
    row?.paid_at
    || row?.period_end
    || row?.charge_at
    || row?.billed_at
    || row?.created_at
    || ''
  );
}

export function qtyFromPayment(pay = {}) {
  const explicit = Number(pay.qty ?? pay.custom_data?.qty);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const fromCode = qtyFromLeonaCode(pay.code);
  if (fromCode) return fromCode;

  const itemQty = Number(pay.item_quantity ?? pay.items?.[0]?.quantity);
  if (Number.isFinite(itemQty) && itemQty > 1) return itemQty;

  return qtyFromPlanName(
    pay.offer_name
    || pay.product_name
    || pay.description
    || pay.price_name
    || pay.items?.[0]?.description
    || pay.items?.[0]?.price_name
  );
}

function subTime(sub) {
  return Number(sub?.status_at || sub?.started_at || 0) || 0;
}

function isPaid(row) {
  return String(row?.status || '').toLowerCase() === 'paid';
}

/**
 * 1. Slot Leona, se existir
 * 2. Última assinatura Guru que já foi cobrada
 * 3. Último pagamento aprovado (Guru, Pagar.me, Paddle)
 * 4. 1
 */
export function resolveExpiredCheckoutQty({
  leonaQty,
  subscriptions = [],
  invoices = [],
  payments = []
} = {}) {
  const fromLeona = Number(leonaQty);
  if (Number.isFinite(fromLeona) && fromLeona > 0) return fromLeona;

  const ranked = [...subscriptions].sort((a, b) => {
    const diff = subTime(b) - subTime(a);
    if (diff) return diff;
    return String(b.cycle_end || '').localeCompare(String(a.cycle_end || ''));
  });
  const charged = ranked.filter((s) => Number(s.charged_times) > 0);
  for (const sub of charged.length ? charged : ranked) {
    const qty = qtyFromPlanName(sub.offer_name);
    if (qty) return qty;
  }

  const paid = [...invoices, ...payments]
    .filter(isPaid)
    .sort((a, b) => paymentWhen(b).localeCompare(paymentWhen(a)));
  for (const row of paid) {
    const qty = qtyFromPayment(row);
    if (qty) return qty;
  }

  return 1;
}
