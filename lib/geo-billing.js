/**
 * País do visitante e se o checkout deve ir pra Paddle (sem CPF).
 */

import { isOneShotKind } from './dlocal-go.js';
import { calcLeonaProrata, leonaAmountReais, reaisToCents } from './leona-pricing.js';

export function countryFromHeaders(headers = {}) {
  const raw =
    headers['x-vercel-ip-country'] ||
    headers['cf-ipcountry'] ||
    headers['x-country-code'] ||
    '';
  const country = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || country === 'XX' || country === 'T1') return null;
  return country;
}

export function countryFromAcceptLanguage(value) {
  const first = String(value || '').split(',')[0] || '';
  const region = first.match(/-([A-Za-z]{2})\b/);
  return region ? region[1].toUpperCase() : null;
}

export function resolveRequestCountry(req) {
  const headers = req?.headers || {};
  return countryFromHeaders(headers) || countryFromAcceptLanguage(headers['accept-language']);
}

export function suggestInternational(country) {
  return Boolean(country) && String(country).toUpperCase() !== 'BR';
}

export function paddleInternationalReady(env = process.env) {
  return Boolean(env.PADDLE_API_KEY);
}

export function findStarterPriceId(products, envPriceId) {
  if (envPriceId) return envPriceId;
  const starter = (products || []).find((p) => /starter|leona flow/i.test(p.name || ''));
  const recurring = (starter?.prices || []).find((pr) =>
    pr?.status === 'active' && pr?.billing_cycle && String(pr.billing_cycle.interval || '').toLowerCase() === 'month'
  );
  return recurring?.id || starter?.prices?.[0]?.id || null;
}

export function findStarterProductId(products, envPriceId) {
  const list = products || [];
  const starter = list.find((p) => /starter|leona flow/i.test(p.name || ''));
  if (starter?.id) return starter.id;
  if (envPriceId) {
    for (const product of list) {
      if ((product.prices || []).some((pr) => pr.id === envPriceId)) return product.id;
    }
  }
  return null;
}

/**
 * Exterior na /assinatura: upgrade no ciclo aberto cobra só o pró-rata
 * (transação avulsa). Assinatura nova continua recorrente no valor cheio.
 */
export function resolvePaddleInternationalCharge({
  qty,
  kind,
  amount,
  profile,
  now = new Date()
} = {}) {
  const qtyN = Math.max(1, Number(qty) || 0);
  if (!qtyN) return { ok: false, error: 'qty obrigatória' };

  const currentQty = Number(profile?.starter_instances || 0);
  const currentEnd = profile?.current_period_end || null;
  const cycleOpen = Boolean(currentEnd && new Date(currentEnd) > now);
  const qtyChanged = currentQty > 0 && qtyN !== currentQty;
  const isUpgrade = cycleOpen && currentQty > 0 && qtyN > currentQty;
  const oneShot = isOneShotKind(kind) || isUpgrade;

  if (!oneShot) {
    return {
      ok: true,
      oneShot: false,
      qty: qtyN,
      amountCents: null,
      keepCycle: false,
      dueDate: null
    };
  }

  if (cycleOpen && qtyChanged) {
    const calc = calcLeonaProrata(
      leonaAmountReais(currentQty),
      leonaAmountReais(qtyN),
      currentEnd,
      now
    );
    const amountCents = Math.round(calc.proRata * 100);
    if (amountCents <= 0) {
      return { ok: false, error: 'ajuste sem valor a cobrar' };
    }
    return {
      ok: true,
      oneShot: true,
      qty: qtyN,
      amountCents,
      keepCycle: true,
      dueDate: String(currentEnd).slice(0, 10),
      prorata: calc
    };
  }

  const customCents = reaisToCents(amount);
  if (customCents > 0) {
    return {
      ok: true,
      oneShot: true,
      qty: qtyN,
      amountCents: customCents,
      keepCycle: false,
      dueDate: null
    };
  }

  return { ok: false, error: 'amount obrigatório no ajuste proporcional' };
}

function buildOneShotPrice({ quantity, amountCents, productId }) {
  const label = `Ajuste Leona — ${quantity} conex${quantity === 1 ? 'ão' : 'ões'}`;
  const price = {
    name: label,
    description: `Ajuste proporcional — ${quantity} conexões`,
    unit_price: {
      amount: String(amountCents),
      currency_code: 'BRL'
    },
    quantity: { minimum: 1, maximum: 1 },
    tax_mode: 'account_setting'
  };
  if (productId) {
    price.product_id = productId;
  } else {
    price.product = {
      name: 'Ajuste Leona',
      tax_category: 'standard'
    };
  }
  return price;
}

export function buildPaddleInternationalTransaction({
  accountId,
  qty,
  customerId,
  priceId,
  productId,
  checkoutUrl,
  kind,
  amountCents
}) {
  const quantity = Math.max(1, Number(qty) || 1);
  const oneShot = isOneShotKind(kind) && Number(amountCents) > 0;
  const customData = {
    leona_account_id: String(accountId),
    qty: String(quantity),
    source: 'assinatura-international'
  };
  if (oneShot) {
    const cents = Math.round(Number(amountCents));
    customData.kind = 'one_shot';
    customData.amount_cents = String(cents);
    const body = {
      items: [{ quantity: 1, price: buildOneShotPrice({ quantity, amountCents: cents, productId }) }],
      customer_id: customerId,
      collection_mode: 'automatic',
      currency_code: 'BRL',
      custom_data: customData
    };
    if (checkoutUrl) body.checkout = { url: checkoutUrl };
    return body;
  }

  const unitList = 12700;
  const unitPaid = quantity <= 1 ? 12700 : quantity <= 3 ? 9900 : 7900;
  const body = {
    items: [{ price_id: priceId, quantity }],
    customer_id: customerId,
    collection_mode: 'automatic',
    currency_code: 'BRL',
    custom_data: customData
  };
  if (checkoutUrl) body.checkout = { url: checkoutUrl };
  if (unitPaid < unitList) {
    body.discount = {
      description: `Plano Leona ${quantity} conexões`,
      type: 'flat_per_seat',
      amount: String(unitList - unitPaid),
      recur: true,
      maximum_recurring_intervals: null
    };
  }
  return body;
}
