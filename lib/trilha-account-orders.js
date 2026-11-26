import { getPontohubLinkRequest } from './pontohub.js';
import { findTrilhaBump, findTrilhaPrize } from './trilha-order.js';
import { formatBrl } from './trilha-prizes.js';

const PAID_STATUSES = new Set(['paid', 'fulfilled', 'fulfill_error']);
const HIDDEN_ORDER_STATUSES = new Set(['expired', 'canceled', 'cancelled']);
export const FACTORY_CART_STATUSES = new Set([
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'AWAITING_PRODUCTION',
  'IN_PRODUCTION'
]);
export const FACTORY_SHIPPED_STATUSES = new Set(['SENT', 'COMPLETED']);

/** Pedido novo com o mesmo código de um envio feito mais de 7 dias antes. */
export const INHERITED_TRACKING_MS = 7 * 24 * 60 * 60 * 1000;

export function requestCreatedMs(requestNumber) {
  const match = /^REQ-(\d{13})-/.exec(String(requestNumber || ''));
  return match ? Number(match[1]) : 0;
}

export function resolveFactoryState({ shipments = [], trackingCodes = [] } = {}) {
  const statuses = (shipments || []).map((row) => String(row.status || '').toUpperCase());
  const shipped = (trackingCodes || []).some(Boolean)
    || statuses.some((status) => FACTORY_SHIPPED_STATUSES.has(status));
  const inCart = statuses.some((status) => FACTORY_CART_STATUSES.has(status));
  if (shipped && inCart) return 'partial';
  if (shipped) return 'shipped';
  if (inCart) return 'in_cart';
  return 'unknown';
}

function factoryStatusLabel(factoryState, status, paid) {
  if (factoryState === 'partial') return 'Parte enviada';
  if (factoryState === 'tracking_stale') return 'Rastreio repetido do pedido anterior';
  if (factoryState === 'in_cart' && paid) return 'Ainda no carrinho da fábrica';
  if (factoryState === 'shipped') return 'Enviado';
  return statusLabel(status);
}

export function checkoutCountsAsPurchased(row = {}) {
  return PAID_STATUSES.has(String(row.status || '').toLowerCase());
}

export function extraUnitsPurchasedFromCheckouts(rows = []) {
  let extras = 0;
  for (const row of rows) {
    if (!checkoutCountsAsPurchased(row)) continue;
    const cart = row.pontohub?.cart?.prizes;
    if (cart && typeof cart === 'object' && Object.keys(cart).length) {
      for (const spec of Object.values(cart)) {
        extras += Math.max(0, Number(spec?.extra ?? spec?.extraQty) || 0);
      }
    } else {
      extras += Math.max(0, Number(row.extra_qty) || 0);
    }
  }
  return extras;
}

export function purchasedPrizeIdsFromCheckouts(rows = []) {
  const ids = new Set();
  for (const row of rows) {
    if (!checkoutCountsAsPurchased(row)) continue;
    if (row.prize_id) ids.add(String(row.prize_id));
    const cart = row.pontohub?.cart?.prizes;
    if (cart && typeof cart === 'object') {
      for (const id of Object.keys(cart)) ids.add(String(id));
    }
  }
  return [...ids];
}

function orderItemLines(row) {
  const items = [];
  const cart = row.pontohub?.cart?.prizes;
  if (cart && typeof cart === 'object' && Object.keys(cart).length) {
    for (const [id, spec] of Object.entries(cart)) {
      const prize = findTrilhaPrize(id);
      const extra = Math.max(0, Number(spec?.extra ?? spec?.extraQty) || 0);
      items.push({
        id,
        title: prize?.title || id,
        qty: 1 + extra
      });
    }
  } else if (row.prize_id) {
    const prize = findTrilhaPrize(row.prize_id);
    items.push({
      id: row.prize_id,
      title: prize?.title || row.prize_id,
      qty: 1 + Math.max(0, Number(row.extra_qty) || 0)
    });
  }
  for (const [bumpId, qty] of Object.entries(row.bumps || {})) {
    const n = Number(qty) || 0;
    if (n <= 0) continue;
    const bump = findTrilhaBump(bumpId);
    items.push({ id: bumpId, title: bump?.title || bumpId, qty: n });
  }
  return items;
}

function statusLabel(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'fulfilled') return 'Pedido na fábrica';
  if (key === 'paid') return 'Pago';
  if (key === 'fulfill_error') return 'Pago · envio pendente';
  if (key === 'pending') return 'Aguardando pagamento';
  return status || 'Pedido';
}

function trackingFromResults(results = [], liveById = {}) {
  const seen = new Set();
  const shipments = [];
  for (const row of Array.isArray(results) ? results : []) {
    const id = row?.request_id || '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const live = liveById[id] || {};
    const tracking = live.trackingCode || live.tracking_code || row.tracking_code || null;
    shipments.push({
      product: row.productName || live.productData?.productName || 'Item',
      status: live.status || (row.approved ? 'APPROVED' : null),
      request_number: live.requestNumber || row.request_number || null,
      tracking_code: tracking || null
    });
  }
  return shipments;
}

export function uniqueTrackingCodes(shipments = []) {
  const codes = [];
  for (const ship of shipments) {
    const code = String(ship?.tracking_code || '').trim();
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function formatCep(cep) {
  const digits = String(cep || '').replace(/\D/g, '');
  if (digits.length !== 8) return String(cep || '').trim();
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

export function presentTrilhaShipping(row = {}) {
  const ship = row.pontohub?.shipping && typeof row.pontohub.shipping === 'object'
    ? row.pontohub.shipping
    : {};
  const name = String(row.name || ship.name || '').trim();
  const street = String(ship.street || row.address || '').trim();
  const number = String(ship.number || '').trim();
  const complement = String(ship.complement || '').trim();
  const neighborhood = String(ship.neighborhood || '').trim();
  const city = String(ship.city || '').trim();
  const state = String(ship.state || '').trim();
  const cep = formatCep(ship.cep || row.cep);
  const streetLine = [street, number].filter(Boolean).join(', ');
  const cityLine = [neighborhood, [city, state].filter(Boolean).join('/')].filter(Boolean).join(', ');
  const lines = [
    name,
    complement ? `${streetLine}${streetLine ? ' — ' : ''}${complement}` : streetLine,
    cityLine,
    cep ? `CEP ${cep}` : ''
  ].filter(Boolean);
  if (!lines.length) return null;
  return {
    name,
    street,
    number,
    complement,
    neighborhood,
    city,
    state,
    cep,
    formatted: lines.join('\n')
  };
}

function rowTime(row, field) {
  const ms = new Date(row?.[field] || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function visibleTrilhaOrderRows(rows = []) {
  const list = rows || [];
  const latestPaidAt = list
    .filter((row) => checkoutCountsAsPurchased(row))
    .map((row) => rowTime(row, 'paid_at') || rowTime(row, 'created_at'))
    .sort((a, b) => b - a)[0] || 0;

  const latestPending = list
    .filter((row) => String(row.status || '').toLowerCase() === 'pending')
    .filter((row) => !latestPaidAt || rowTime(row, 'created_at') > latestPaidAt)
    .sort((a, b) => rowTime(b, 'created_at') - rowTime(a, 'created_at'))[0] || null;

  return list.filter((row) => {
    const status = String(row.status || '').toLowerCase();
    if (HIDDEN_ORDER_STATUSES.has(status)) return false;
    if (status === 'pending') return Boolean(latestPending && row.id === latestPending.id);
    return checkoutCountsAsPurchased(row);
  });
}

function presentFactoryOrder(row, shipments) {
  const trackingCodes = uniqueTrackingCodes(shipments);
  const factoryState = resolveFactoryState({ shipments, trackingCodes });
  const paid = checkoutCountsAsPurchased(row);
  return {
    id: row.id,
    created_at: row.created_at,
    paid_at: row.paid_at,
    status: row.status,
    status_label: factoryStatusLabel(factoryState, row.status, paid),
    amount_cents: Number(row.amount_cents) || 0,
    amount_formatted: formatBrl((Number(row.amount_cents) || 0) / 100),
    checkout_url: row.status === 'pending' ? row.checkout_url || null : null,
    items: orderItemLines(row),
    shipping: presentTrilhaShipping(row),
    shipments,
    tracking_codes: trackingCodes,
    factory_state: factoryState,
    address_editable: paid && factoryState === 'in_cart',
    request_ids: [...new Set((row.pontohub?.results || []).map((item) => item.request_id).filter(Boolean))]
  };
}

export function presentTrilhaOrders(rows = []) {
  return visibleTrilhaOrderRows(rows).map((row) => (
    presentFactoryOrder(row, trackingFromResults(row.pontohub?.results || []))
  ));
}

/**
 * A fábrica às vezes grava, num pedido novo, o código de rastreio do primeiro
 * envio. O objeto dos Correios não se reaproveita: se o pedido da fábrica foi
 * aberto mais de 7 dias depois do primeiro que usou aquele código, o código
 * não é deste envio.
 */
export function dropInheritedTracking(orders = []) {
  const firstByCode = new Map();
  for (const order of orders) {
    for (const ship of order.shipments || []) {
      const code = String(ship.tracking_code || '').trim();
      const at = requestCreatedMs(ship.request_number);
      if (!code || !at) continue;
      const prev = firstByCode.get(code);
      if (!prev || at < prev) firstByCode.set(code, at);
    }
  }
  return orders.map((order) => {
    let dropped = 0;
    const shipments = (order.shipments || []).map((ship) => {
      const code = String(ship.tracking_code || '').trim();
      const at = requestCreatedMs(ship.request_number);
      const first = code ? firstByCode.get(code) : 0;
      if (code && at && first && at - first > INHERITED_TRACKING_MS) {
        dropped += 1;
        return { ...ship, tracking_code: null, inherited_tracking: code };
      }
      return ship;
    });
    const trackingCodes = uniqueTrackingCodes(shipments);
    const factoryState = resolveFactoryState({ shipments, trackingCodes });
    const stale = dropped > 0 && !trackingCodes.length && factoryState === 'unknown';
    const state = stale ? 'tracking_stale' : factoryState;
    const paid = !['pending', 'expired', 'canceled', 'cancelled'].includes(String(order.status || '').toLowerCase());
    return {
      ...order,
      shipments,
      tracking_codes: trackingCodes,
      factory_state: state,
      address_editable: paid && state === 'in_cart',
      status_label: factoryStatusLabel(state, order.status, paid)
    };
  });
}

export async function attachPontohubTracking(orders = []) {
  const ids = [...new Set(orders.flatMap((order) => order.request_ids || []))];
  if (!ids.length) return orders;
  const liveById = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const found = await getPontohubLinkRequest(id);
      const body = found.body?.id ? found.body : found.body?.data;
      if (found.ok && body?.id) liveById[id] = body;
    } catch {
      /* Hub fora não derruba a aba de pedidos */
    }
  }));
  const refreshed = orders.map((order) => {
    const shipments = (order.request_ids || []).map((id, index) => {
      const prev = order.shipments?.[index] || {};
      const live = liveById[id] || {};
      return {
        product: live.productData?.productName || prev.product || 'Item',
        status: live.status || prev.status || null,
        request_number: live.requestNumber || prev.request_number || null,
        tracking_code: live.trackingCode || live.tracking_code || prev.tracking_code || null
      };
    });
    return { ...order, shipments };
  });
  return dropInheritedTracking(refreshed);
}
