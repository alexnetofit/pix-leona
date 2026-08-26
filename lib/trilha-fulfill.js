import {
  approvePontohubLinkRequest,
  buildPontohubPlayer,
  createPontohubLinkRequest,
  lookupCep,
  pontohubConfigured
} from './pontohub.js';
import { getPagarmePaymentLink } from './pagarme.js';
import { sbConfigured, sbInsert, sbSelect, sbUpdate } from './supabase.js';
import { buildPontohubFulfillmentLines } from './trilha-pontohub.js';

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

export async function fulfillTrilhaCheckout(checkout, { source = 'webhook' } = {}) {
  if (!checkout?.id) return { ok: false, error: 'checkout ausente' };
  if (checkout.status === 'fulfilled') {
    return { ok: true, duplicate: true, checkout_id: checkout.id };
  }
  if (!pontohubConfigured()) {
    return { ok: false, error: 'PONTO_HUB_API_KEY ausente' };
  }

  const viaCep = await lookupCep(checkout.cep);
  const playerData = buildPontohubPlayer({
    name: checkout.name,
    email: checkout.email,
    document: checkout.document,
    phone: checkout.phone,
    cep: checkout.cep,
    address: checkout.address
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
    if (item.linkId) payload.linkId = item.linkId;

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
      pontohub: { source, results }
    });
  }

  return { ok: allOk, checkout_id: checkout.id, results };
}

export async function fulfillPaidPaymentLink(paymentLinkId, { source = 'webhook' } = {}) {
  const checkout = await findTrilhaCheckoutByPaymentLink(paymentLinkId);
  if (!checkout) return { ok: false, error: 'checkout não encontrado', payment_link_id: paymentLinkId };
  return fulfillTrilhaCheckout(checkout, { source });
}

export async function reconcilePendingTrilhaCheckouts({ max = 20 } = {}) {
  if (!sbConfigured()) return { ok: false, error: 'supabase ausente' };
  const pending = await sbSelect('trilha_checkouts', {
    eq: { status: 'pending' },
    order: 'created_at.desc',
    limit: max
  });
  const results = [];
  for (const row of pending) {
    const link = await getPagarmePaymentLink(row.payment_link_id);
    if (!link.ok || !paymentLinkLooksPaid(link.body)) {
      results.push({ payment_link_id: row.payment_link_id, paid: false });
      continue;
    }
    results.push({
      payment_link_id: row.payment_link_id,
      paid: true,
      ...(await fulfillTrilhaCheckout(row, { source: 'reconcile' }))
    });
  }
  return { ok: true, scanned: pending.length, results };
}
