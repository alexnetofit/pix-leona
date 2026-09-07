/**
 * Downgrade Pagar.me na /assinatura.
 * PIX / cartão avulso: só aviso. Cartão com sub_ ativa: edita o item.
 */
import { friendlyPagarmeError, getPagarmeSubscription, pagarmeSubscriptionActive, updatePagarmeSubscriptionItem } from './pagarme.js';
import { leonaAmountCents } from './leona-pricing.js';
import { pagarmeSubLooksLikeLeona } from './pagarme-card.js';

export function resolvePagarmeDowngrade({
  hasSubscription = false,
  currentQty = 0,
  newQty = 0
} = {}) {
  const from = Number(currentQty) || 0;
  const to = Number(newQty) || 0;
  if (!(to >= 1 && to < from)) {
    return { ok: false, error: 'Quantidade de downgrade inválida' };
  }
  return {
    ok: true,
    mode: hasSubscription ? 'subscription' : 'notice',
    from,
    to
  };
}

export function pickPagarmeSubscriptionItem(sub) {
  const items = Array.isArray(sub?.items) ? sub.items : [];
  return items.find((item) => String(item.status || '').toLowerCase() === 'active')
    || items[0]
    || null;
}

export function pickActivePagarmeLeonaSub(subscriptions = []) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  return list.find((sub) => pagarmeSubscriptionActive(sub) && pagarmeSubLooksLikeLeona(sub))
    || list.find(pagarmeSubscriptionActive)
    || null;
}

export function buildPagarmeDowngradeItemPayload(qty) {
  const n = Math.max(1, Number(qty) || 1);
  const label = `Leona Flow — ${n} conex${n === 1 ? 'ão' : 'ões'}`;
  return {
    name: label.slice(0, 64),
    description: label.slice(0, 256),
    quantity: 1,
    pricing_scheme: {
      scheme_type: 'unit',
      price: leonaAmountCents(n)
    }
  };
}

export async function applyPagarmeSubscriptionDowngrade({
  subscriptions = [],
  qty
} = {}) {
  const target = Math.max(0, Number(qty) || 0);
  if (target < 1) return { ok: false, status: 400, error: 'Quantidade de downgrade inválida' };

  let sub = pickActivePagarmeLeonaSub(subscriptions);
  if (!sub?.id) {
    return { ok: false, status: 409, code: 'NO_SUBSCRIPTION', error: 'Não há assinatura recorrente na Pagar.me para reduzir' };
  }

  if (!pickPagarmeSubscriptionItem(sub)) {
    const fetched = await getPagarmeSubscription(sub.id);
    if (fetched.ok && fetched.body) sub = fetched.body;
  }

  const item = pickPagarmeSubscriptionItem(sub);
  if (!item?.id) {
    return { ok: false, status: 409, code: 'NO_ITEM', error: 'A assinatura Pagar.me não tem item para alterar' };
  }

  const payload = buildPagarmeDowngradeItemPayload(qty);
  const patched = await updatePagarmeSubscriptionItem(sub.id, item.id, payload);
  if (!patched.ok) {
    return {
      ok: false,
      status: patched.status && patched.status < 500 ? patched.status : 502,
      error: friendlyPagarmeError(patched.body?.message || patched.body?.error)
        || 'A Pagar.me não aceitou o downgrade da assinatura'
    };
  }

  return {
    ok: true,
    subscription_id: sub.id,
    item_id: item.id,
    qty: Number(qty),
    amount_cents: payload.pricing_scheme.price
  };
}
