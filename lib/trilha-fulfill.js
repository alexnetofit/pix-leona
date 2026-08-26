import {
  approvePontohubLinkRequest,
  buildPontohubPlayer,
  createPontohubLinkRequest,
  lookupCep,
  pontohubConfigured
} from './pontohub.js';
import {
  extractPagarmeOrderId,
  extractPagarmePayer,
  getPagarmeOrder,
  getPagarmePaymentLink,
  pagarmePayerHasAddress
} from './pagarme.js';
import { sbConfigured, sbInsert, sbSelect, sbUpdate } from './supabase.js';
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
  return paidSessions > 0 || ['paid', 'completed', 'inactive'].includes(status);
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
        pontohub: { source, error: 'endereço ausente no checkout Pagar.me' }
      });
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

  const lines = buildPontohubFulfillmentLines({
    prizeId: checkout.prize_id,
    extraQty: checkout.extra_qty,
    bumps: checkout.bumps || {}
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
      pontohub: { source, shipping, results }
    });
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
    if (!link.ok || !paymentLinkLooksPaid(link.body)) {
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
