import { TRILHA_ORDER_BUMPS, TRILHA_PRIZES } from './trilha-prizes.js';

export { TRILHA_ORDER_BUMPS };

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

export function buildTrilhaOrder({ prizeId, extraQty = 0, bumps = {} } = {}) {
  const prize = findTrilhaPrize(prizeId);
  if (!prize) return { ok: false, error: 'Prêmio inválido' };

  const extras = clampQty(extraQty);
  const items = [{
    code: `trilha-${prize.id}`,
    name: prize.prizeFree ? `Frete — ${prize.title}` : prize.title,
    description: prize.prizeFree ? prize.shippingLabel : prize.title,
    amount: prize.priceCents,
    quantity: 1
  }];

  if (extras > 0) {
    if (!prize.extraUnitCents) return { ok: false, error: 'Esse prêmio não aceita unidades extras' };
    items.push({
      code: `trilha-${prize.id}-extra`,
      name: `${prize.title} (unidade extra)`,
      description: `${extras} unidade(s) extra(s)`,
      amount: prize.extraUnitCents,
      quantity: extras
    });
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

  const totalCents = items.reduce((sum, item) => sum + item.amount * item.quantity, 0);
  if (totalCents <= 0) return { ok: false, error: 'Pedido sem valor' };

  return { ok: true, prize, items, extras, bumps: bumpQtys, totalCents };
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

export function paymentLinkItems(items) {
  return items.map((item) => ({
    name: item.name.slice(0, 64),
    description: String(item.description || item.name).slice(0, 256),
    amount: item.amount,
    default_quantity: item.quantity,
    code: item.code
  }));
}
