import { TRILHA_ORDER_BUMPS, TRILHA_PRIZES } from './trilha-prizes.js';

export { TRILHA_ORDER_BUMPS };

export const TRILHA_SHIPPING_CENTS = 2990;
const MAX_QTY = 20;

function clampQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_QTY, Math.floor(n));
}

export function findTrilhaPrize(prizeId) {
  return TRILHA_PRIZES.find((prize) => prize.id === String(prizeId || '')) || null;
}

export function findTrilhaBump(bumpId) {
  return TRILHA_ORDER_BUMPS.find((bump) => bump.id === String(bumpId || '')) || null;
}

export function buildTrilhaCartOrder({
  prizeIds = [],
  extras = {},
  bumps = {},
  acquiredIds = [],
  anticipatedIds = []
} = {}) {
  const ids = [...new Set((Array.isArray(prizeIds) ? prizeIds : [prizeIds]).map((id) => String(id || '').trim()).filter(Boolean))];
  const acquired = new Set((acquiredIds || []).map((id) => String(id)));
  const anticipated = new Set((anticipatedIds || []).map((id) => String(id)));
  const selected = ids.map(findTrilhaPrize);
  if (!selected.length || selected.some((prize) => !prize)) {
    return { ok: false, error: 'Prêmio inválido' };
  }

  const items = [];
  const extrasByPrize = {};
  const anticipatedByPrize = {};
  for (const prize of selected) {
    const already = acquired.has(prize.id);
    const anticipate = !already && anticipated.has(prize.id);
    let extra = clampQty(extras[prize.id]);
    if (already && extra <= 0) extra = 1;
    if (extra) extrasByPrize[prize.id] = extra;
    if (anticipate) anticipatedByPrize[prize.id] = true;
    if (!already) {
      if (anticipate) {
        if (!prize.extraUnitCents) return { ok: false, error: 'Esse prêmio não tem preço de custo para antecipar' };
        items.push({
          code: `trilha-${prize.id}`,
          name: prize.title,
          description: 'Antecipação — custo de produção',
          amount: prize.extraUnitCents,
          quantity: 1
        });
      } else if (prize.priceCents > 0) {
        items.push({
          code: `trilha-${prize.id}`,
          name: prize.title,
          description: prize.title,
          amount: prize.priceCents,
          quantity: 1
        });
      }
    }
    if (extra > 0) {
      if (!prize.extraUnitCents) return { ok: false, error: 'Esse prêmio não aceita unidades extras' };
      items.push({
        code: `trilha-${prize.id}-extra`,
        name: `${prize.title} (unidade extra)`,
        description: `${extra} unidade(s) extra(s)`,
        amount: prize.extraUnitCents,
        quantity: extra
      });
    }
  }

  const bumpQtys = {};
  for (const bump of TRILHA_ORDER_BUMPS) {
    const qty = clampQty(bumps[bump.id]);
    if (!qty) continue;
    bumpQtys[bump.id] = qty;
    items.push({
      code: `trilha-bump-${bump.id}`,
      name: bump.title,
      description: bump.subtitle,
      amount: bump.priceCents,
      quantity: qty
    });
  }

  const shippingCents = 0;
  const freeShipping = true;

  const totalCents = items.reduce((sum, item) => sum + item.amount * item.quantity, 0);
  if (totalCents <= 0) return { ok: false, error: 'Pedido sem valor' };

  return {
    ok: true,
    prize: selected[0],
    prizes: selected,
    prizeIds: selected.map((prize) => prize.id),
    extrasByPrize,
    extras: extrasByPrize[selected[0].id] || 0,
    anticipatedIds: selected.map((prize) => prize.id).filter((id) => anticipatedByPrize[id]),
    items,
    bumps: bumpQtys,
    shippingCents,
    freeShipping,
    totalCents
  };
}

export function buildTrilhaOrder({ prizeId, extraQty = 0, bumps = {} } = {}) {
  return buildTrilhaCartOrder({
    prizeIds: prizeId ? [prizeId] : [],
    extras: prizeId ? { [prizeId]: extraQty } : {},
    bumps
  });
}

export function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function parseTrilhaDocument(raw) {
  const number = onlyDigits(raw);
  if (number.length === 11) return { type: 'individual', document: number, document_type: 'CPF' };
  if (number.length === 14) return { type: 'company', document: number, document_type: 'CNPJ' };
  return null;
}

export function parseTrilhaPhone(raw) {
  let digits = onlyDigits(raw);
  if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(-11);
  if (digits.length < 10 || digits.length > 11) return null;
  return {
    country_code: '55',
    area_code: digits.slice(0, 2),
    number: digits.slice(2)
  };
}

function isPrizeLine(item) {
  const code = String(item.code || '');
  return code.startsWith('trilha-') && !code.includes('-extra') && !code.includes('-bump-');
}

export function paymentLinkItems(items) {
  const included = items.filter((item) => isPrizeLine(item) && item.amount === 0);
  const includedNames = included
    .map((item) => String(item.name || '').replace(/\s*\(incluso\)\s*$/i, '').trim())
    .filter(Boolean);
  const includedIds = included
    .map((item) => String(item.code || '').replace(/^trilha-/, ''))
    .filter(Boolean);
  const includedNote = includedNames.length ? `Inclusos: ${includedNames.join(', ')}` : '';
  const nameSuffix = includedIds.length ? ` + ${includedIds.join(' + ')}` : '';

  return items
    .filter((item) => item.amount > 0)
    .map((item) => {
      let name = String(item.name || '');
      let description = String(item.description || item.name);
      if (includedNote && isPrizeLine(item)) {
        name = `${name}${nameSuffix}`;
        description = `${description} · ${includedNote}`;
      }
      return {
        name: name.slice(0, 64),
        description: description.slice(0, 256),
        amount: item.amount,
        default_quantity: item.quantity,
        code: item.code
      };
    });
}

/** Só o nome. E-mail faz a Pagar.me reusar o customer e pré-preencher o endereço salvo. */
export function trilhaPagarmeCustomer(name) {
  return {
    name: String(name || 'Cliente Leona').trim().slice(0, 64) || 'Cliente Leona'
  };
}

export const TRILHA_CARD_MAX_INSTALLMENTS = 12;
/** 20% no 12x: mil vira 12x de 100, quinhentos vira 12x de 50. */
export const TRILHA_CARD_INSTALLMENT_TOTAL_RATE = 0.2;

export function trilhaCardInstallments(amountCents) {
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  const monthlyRate = TRILHA_CARD_INSTALLMENT_TOTAL_RATE / TRILHA_CARD_MAX_INSTALLMENTS;
  return Array.from({ length: TRILHA_CARD_MAX_INSTALLMENTS }, (_, index) => {
    const number = index + 1;
    const total = number === 1 ? amount : Math.round(amount * (1 + monthlyRate * number));
    return { number, total };
  });
}

export function buildTrilhaPagarmePaymentLinkPayload({
  accountId,
  order,
  customerName,
  successUrl
} = {}) {
  const customer = trilhaPagarmeCustomer(customerName);
  return {
    type: 'order',
    name: `Trilha ${order.prizeIds.join('+')} #${accountId}`.slice(0, 64),
    max_paid_sessions: 1,
    expires_in: 180,
    payment_settings: {
      accepted_payment_methods: ['pix', 'credit_card'],
      pix_settings: { expires_in: 3600 },
      credit_card_settings: {
        operation_type: 'auth_and_capture',
        installments: trilhaCardInstallments(order.totalCents)
      }
    },
    customer_settings: { customer },
    cart_settings: {
      shipping_cost: 0,
      items: paymentLinkItems(order.items)
    },
    flow_settings: {
      success_url: successUrl
    }
  };
}
