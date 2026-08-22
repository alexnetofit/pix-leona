/**
 * País do visitante e se o checkout deve ir pra Paddle (sem CPF).
 */

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

export function buildPaddleInternationalTransaction({
  accountId,
  qty,
  customerId,
  priceId,
  checkoutUrl
}) {
  const quantity = Math.max(1, Number(qty) || 1);
  const unitList = 12700;
  const unitPaid = quantity <= 1 ? 12700 : quantity <= 3 ? 9900 : 7900;
  const body = {
    items: [{ price_id: priceId, quantity }],
    customer_id: customerId,
    collection_mode: 'automatic',
    currency_code: 'BRL',
    custom_data: {
      leona_account_id: String(accountId),
      qty: String(quantity),
      source: 'assinatura-international'
    }
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
