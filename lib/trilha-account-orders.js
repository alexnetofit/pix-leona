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

export function resolveFactoryState({ shipments = [], trackingCodes = [] } = {}) {
  const statuses = (shipments || []).map((row) => String(row.status || '').toUpperCase());
  if ((trackingCodes || []).some(Boolean) || statuses.some((status) => FACTORY_SHIPPED_STATUSES.has(status))) {
    return 'shipped';
  }
  if (statuses.some((status) => FACTORY_CART_STATUSES.has(status))) return 'in_cart';
  return 'unknown';
}

export function checkoutCountsAsPurchased(row = {}) {
  return PAID_STATUSES.has(String(row.status || '').toLowerCase());
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
  return (Array.isArray(results) ? results : []).map((row) => {
    const live = liveById[row.request_id] || {};
    const tracking = live.trackingCode || live.tracking_code || row.tracking_code || null;
    return {
      product: row.productName || live.productData?.productName || 'Item',
      status: live.status || (row.approved ? 'APPROVED' : null),
      request_number: live.requestNumber || null,
      tracking_code: tracking || null
    };
  });
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

export function presentTrilhaOrders(rows = []) {
  return visibleTrilhaOrderRows(rows).map((row) => {
    const shipments = trackingFromResults(row.pontohub?.results || []);
    const trackingCodes = uniqueTrackingCodes(shipments);
    const factoryState = resolveFactoryState({ shipments, trackingCodes });
    const paid = checkoutCountsAsPurchased(row);
    return {
      id: row.id,
      created_at: row.created_at,
      paid_at: row.paid_at,
      status: row.status,
      status_label: factoryState === 'in_cart' && paid
        ? 'Ainda no carrinho da fábrica'
        : factoryState === 'shipped'
          ? 'Enviado'
          : statusLabel(row.status),
      amount_cents: Number(row.amount_cents) || 0,
      amount_formatted: formatBrl((Number(row.amount_cents) || 0) / 100),
      checkout_url: row.status === 'pending' ? row.checkout_url || null : null,
      items: orderItemLines(row),
      shipping: presentTrilhaShipping(row),
      shipments,
      tracking_codes: trackingCodes,
      factory_state: factoryState,
      address_editable: paid && factoryState === 'in_cart',
      request_ids: (row.pontohub?.results || []).map((item) => item.request_id).filter(Boolean)
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
  return orders.map((order) => {
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
    const trackingCodes = uniqueTrackingCodes(shipments);
    const factoryState = resolveFactoryState({ shipments, trackingCodes });
    const paid = !['pending', 'expired', 'canceled', 'cancelled'].includes(String(order.status || '').toLowerCase());
    return {
      ...order,
      shipments,
      tracking_codes: trackingCodes,
      factory_state: factoryState,
      address_editable: paid && factoryState === 'in_cart',
      status_label: factoryState === 'in_cart' && paid
        ? 'Ainda no carrinho da fábrica'
        : factoryState === 'shipped'
          ? 'Enviado'
          : order.status_label
    };
  });
}
