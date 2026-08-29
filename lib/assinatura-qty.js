/**
 * Qty inicial do seletor na /assinatura quando o ciclo venceu.
 * Não começa em 1 se a gente ainda souber o plano anterior.
 */
import { extractInstances } from './guru-webhook-payload.js';

export function qtyFromPlanName(name) {
  const n = extractInstances(name);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function subTime(sub) {
  return Number(sub?.status_at || sub?.started_at || 0) || 0;
}

function invoiceWhen(inv) {
  return String(inv?.period_end || inv?.charge_at || '');
}

/**
 * 1. Slot Leona, se existir
 * 2. Última assinatura Guru que já foi cobrada
 * 3. Último pagamento aprovado
 * 4. 1
 */
export function resolveExpiredCheckoutQty({
  leonaQty,
  subscriptions = [],
  invoices = []
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

  // Upgrade Guru cobra só o pró-rata (ex. 10→12 = R$ 36,87), mas o
  // offer_name é o plano alvo ("12 conexões"), não o delta. Lemos o nome.
  const paid = [...invoices]
    .filter((inv) => String(inv.status || '').toLowerCase() === 'paid')
    .sort((a, b) => invoiceWhen(b).localeCompare(invoiceWhen(a)));
  for (const inv of paid) {
    const qty = qtyFromPlanName(inv.offer_name);
    if (qty) return qty;
  }

  return 1;
}
