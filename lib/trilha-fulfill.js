import {
  approvePontohubLinkRequest,
  buildPontohubPlayer,
  createPontohubLinkRequest,
  getPontohubLinkRequest,
  lookupCep,
  pontohubConfigured,
  updatePontohubLinkAddress
} from './pontohub.js';
import { FACTORY_CART_STATUSES, resolveFactoryState, uniqueTrackingCodes } from './trilha-account-orders.js';
import {
  extractPagarmeOrderId,
  extractPagarmePayer,
  getPagarmeOrder,
  getPagarmePaymentLink,
  pagarmePayerHasAddress
} from './pagarme.js';
import { sbConfigured, sbInsert, sbSelect, sbUpdate, sbUpdateWhere } from './supabase.js';
import { buildPontohubFulfillmentLines } from './trilha-pontohub.js';

export function mergeTrilhaPayer(checkout = {}, payer = {}) {
  const shipping = {
    ...(checkout.pontohub?.shipping || {}),
    ...(payer.shipping || {})
  };
  return {
    ...checkout,
    name: payer.name || checkout.name,
    email: payer.email || checkout.email,
    document: payer.document || checkout.document,
    phone: payer.phone || checkout.phone,
    cep: payer.cep || checkout.cep,
    address: payer.address || checkout.address,
    pontohub: {
      ...(checkout.pontohub || {}),
      shipping
    }
  };
}

export function paymentLinkLooksPaid(link = {}) {
  const paidSessions = Number(link.total_paid_sessions || link.paid_sessions || 0);
  const status = String(link.status || '').toLowerCase();
  return paidSessions > 0 || ['paid', 'completed'].includes(status);
}

export function paymentLinkLooksAbandoned(link = {}) {
  if (paymentLinkLooksPaid(link)) return false;
  const status = String(link.status || '').toLowerCase();
  return ['expired', 'canceled', 'cancelled', 'inactive', 'finished'].includes(status);
}

export async function expireAbandonedTrilhaCheckouts(accountId, { exceptId } = {}) {
  if (!sbConfigured() || !accountId) return [];
  const filters = {
    eq: { account_id: String(accountId), status: 'pending' }
  };
  if (exceptId) filters.neq = { id: exceptId };
  const rows = await sbUpdateWhere('trilha_checkouts', filters, { status: 'expired' }, { single: false });
  return Array.isArray(rows) ? rows : (rows ? [rows] : []);
}

export async function saveTrilhaCheckout(row) {
  if (!sbConfigured()) return null;
  return sbInsert('trilha_checkouts', row);
}

export async function findTrilhaCheckoutByPaymentLink(paymentLinkId) {
  if (!sbConfigured() || !paymentLinkId) return null;
  const rows = await sbSelect('trilha_checkouts', {
    eq: { payment_link_id: String(paymentLinkId) },
    limit: 1
  });
  return rows[0] || null;
}

export async function listTrilhaAccountCheckouts(accountId) {
  if (!sbConfigured() || !accountId) return [];
  return sbSelect('trilha_checkouts', {
    eq: { account_id: String(accountId) },
    order: 'created_at.desc',
    limit: 50
  });
}

export function normalizeTrilhaAddress(input = {}) {
  const via = input.viaCep || {};
  const cep = String(input.cep || '').replace(/\D/g, '');
  const street = String(input.street || via.logradouro || '').trim();
  const number = String(input.number || '').trim();
  const complement = String(input.complement || '').trim();
  const neighborhood = String(input.neighborhood || via.bairro || '').trim();
  const city = String(input.city || via.localidade || '').trim();
  const state = String(input.state || via.uf || '').trim().toUpperCase().slice(0, 2);
  if (cep.length !== 8) return { ok: false, error: 'CEP inválido' };
  if (!street || !number || !neighborhood || !city || state.length !== 2) {
    return { ok: false, error: 'Preencha rua, número, bairro, cidade e UF' };
  }
  return {
    ok: true,
    address: { cep, street, number, complement, neighborhood, city, state }
  };
}

export async function updateTrilhaCheckoutAddress(checkout, address) {
  const ids = [...new Set((checkout?.pontohub?.results || []).map((row) => row.request_id).filter(Boolean))];
  if (!ids.length) return { ok: false, error: 'Pedido sem itens na fábrica' };

  const live = [];
  for (const id of ids) {
    const found = await getPontohubLinkRequest(id);
    const body = found.body?.id ? found.body : found.body?.data || {};
    live.push({
      status: body.status,
      tracking_code: body.trackingCode || body.tracking_code || null
    });
  }
  const factoryState = resolveFactoryState({
    shipments: live,
    trackingCodes: uniqueTrackingCodes(live)
  });
  if (factoryState !== 'in_cart') {
    return { ok: false, error: 'Esse pedido já saiu do carrinho da fábrica e o endereço não pode mais mudar' };
  }

  const results = [];
  for (const id of ids) {
    const updated = await updatePontohubLinkAddress(id, address);
    results.push({
      request_id: id,
      ok: updated.ok,
      status: updated.status,
      error: updated.ok ? null : updated.body
    });
    if (!updated.ok) {
      const blocked = FACTORY_CART_STATUSES.has(String(updated.body?.status || '').toUpperCase()) === false
        && updated.status === 409;
      return {
        ok: false,
        error: updated.status === 404
          ? 'A fábrica ainda não libera troca de endereço por aqui. Fala com o suporte enquanto o pedido estiver no carrinho.'
          : (updated.body?.message || updated.body?.error || 'A fábrica recusou a troca de endereço'),
        blocked,
        results
      };
    }
  }

  if (sbConfigured()) {
    await sbUpdate('trilha_checkouts', { id: checkout.id }, {
      cep: address.cep,
      address: `${address.street}, ${address.number}`,
      pontohub: {
        ...(checkout.pontohub || {}),
        shipping: address
      }
    });
  }

  return { ok: true, results, shipping: address };
}

async function resolveCheckoutFromPagarme(checkout, payload) {
  let payer = extractPagarmePayer(payload);
  if (!pagarmePayerHasAddress(payer)) {
    const orderId = extractPagarmeOrderId(payload);
    if (orderId) {
      const order = await getPagarmeOrder(orderId);
      if (order.ok) payer = extractPagarmePayer(order.body);
    }
  }
  if (!pagarmePayerHasAddress(payer) && checkout.payment_link_id) {
    const link = await getPagarmePaymentLink(checkout.payment_link_id);
    const orders = Array.isArray(link.body?.orders) ? link.body.orders : [];
    const paid = orders.find((row) => String(row.status || '').toLowerCase() === 'paid') || orders[0];
    if (paid?.id) {
      const order = await getPagarmeOrder(paid.id);
      if (order.ok) payer = extractPagarmePayer(order.body);
    } else if (link.ok) {
      payer = extractPagarmePayer(link.body);
    }
  }
  return mergeTrilhaPayer(checkout, payer);
}

export async function fulfillTrilhaCheckout(checkout, { source = 'webhook', payload } = {}) {
  if (!checkout?.id) return { ok: false, error: 'checkout ausente' };
  if (checkout.status === 'fulfilled') {
    return { ok: true, duplicate: true, checkout_id: checkout.id };
  }
  if (!pontohubConfigured()) {
    return { ok: false, error: 'PONTO_HUB_API_KEY ausente' };
  }

  const resolved = await resolveCheckoutFromPagarme(checkout, payload);
  if (!pagarmePayerHasAddress(resolved) && !resolved.cep) {
    if (sbConfigured()) {
      await sbUpdate('trilha_checkouts', { id: checkout.id }, {
        status: 'fulfill_error',
        paid_at: checkout.paid_at || new Date().toISOString(),
        pontohub: { source, error: 'endereço ausente no checkout Pagar.me', cart: checkout.pontohub?.cart || null }
      });
      try {
        await expireAbandonedTrilhaCheckouts(checkout.account_id, { exceptId: checkout.id });
      } catch (error) {
        console.error('trilha expire abandoned:', error);
      }
    }
    return { ok: false, error: 'endereço ausente no checkout Pagar.me', checkout_id: checkout.id };
  }

  const viaCep = await lookupCep(resolved.cep);
  const shipping = resolved.pontohub?.shipping || {};
  const playerData = buildPontohubPlayer({
    name: resolved.name,
    email: resolved.email,
    document: resolved.document,
    phone: resolved.phone,
    cep: resolved.cep,
    address: resolved.address,
    ...shipping
  }, viaCep);

  const cartPrizes = checkout.pontohub?.cart?.prizes || null;
  const lines = buildPontohubFulfillmentLines({
    prizeId: checkout.prize_id,
    extraQty: checkout.extra_qty,
    bumps: checkout.bumps || {},
    prizes: cartPrizes
  });
  if (!lines.length) return { ok: false, error: 'sem itens Ponto Hub' };

  const results = [];
  for (const item of lines) {
    const orderId = `${checkout.payment_link_id}:${item.code}:${item.index}`;
    const payload = {
      orderId,
      productId: item.productId,
      productName: item.productName,
      playerData
    };

    const created = await createPontohubLinkRequest(payload);
    const requestId = created.body?.id || created.body?.data?.id || null;
    let approved = null;
    if (created.ok && requestId) {
      approved = await approvePontohubLinkRequest(requestId, {});
    }
    results.push({
      orderId,
      productName: item.productName,
      ok: created.ok,
      status: created.status,
      request_id: requestId,
      approved: Boolean(approved?.ok),
      error: created.ok ? null : created.body
    });
  }

  const allOk = results.every((row) => row.ok);
  if (sbConfigured()) {
    await sbUpdate('trilha_checkouts', { id: checkout.id }, {
      status: allOk ? 'fulfilled' : 'fulfill_error',
      paid_at: checkout.paid_at || new Date().toISOString(),
      name: resolved.name,
      email: resolved.email,
      document: resolved.document,
      phone: resolved.phone,
      cep: resolved.cep,
      address: resolved.address,
      pontohub: { source, shipping, results, cart: resolved.pontohub?.cart || checkout.pontohub?.cart || null }
    });
    try {
      await expireAbandonedTrilhaCheckouts(checkout.account_id, { exceptId: checkout.id });
    } catch (error) {
      console.error('trilha expire abandoned:', error);
    }
  }

  return { ok: allOk, checkout_id: checkout.id, results };
}

export async function fulfillPaidPaymentLink(paymentLinkId, { source = 'webhook', payload } = {}) {
  const checkout = await findTrilhaCheckoutByPaymentLink(paymentLinkId);
  if (!checkout) return { ok: false, error: 'checkout não encontrado', payment_link_id: paymentLinkId };
  return fulfillTrilhaCheckout(checkout, { source, payload });
}

export async function reconcilePendingTrilhaCheckouts({ max = 20, payload } = {}) {
  if (!sbConfigured()) return { ok: false, error: 'supabase ausente' };
  const pending = await sbSelect('trilha_checkouts', {
    eq: { status: 'pending' },
    order: 'created_at.desc',
    limit: max
  });
  const payer = extractPagarmePayer(payload);
  const results = [];
  for (const row of pending) {
    const link = await getPagarmePaymentLink(row.payment_link_id);
    if (!link.ok) {
      results.push({ payment_link_id: row.payment_link_id, paid: false });
      continue;
    }
    if (paymentLinkLooksAbandoned(link.body)) {
      await sbUpdate('trilha_checkouts', { id: row.id }, { status: 'expired' });
      results.push({ payment_link_id: row.payment_link_id, paid: false, expired: true });
      continue;
    }
    if (!paymentLinkLooksPaid(link.body)) {
      results.push({ payment_link_id: row.payment_link_id, paid: false });
      continue;
    }
    const sameBuyer = payer.email && row.email && payer.email === row.email;
    results.push({
      payment_link_id: row.payment_link_id,
      paid: true,
      ...(await fulfillTrilhaCheckout(row, {
        source: 'reconcile',
        payload: sameBuyer ? payload : undefined
      }))
    });
  }
  return { ok: true, scanned: pending.length, results };
}
