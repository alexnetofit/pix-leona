/**
 * POST /api/trilha-pay — gera checkout Pagar.me (PIX + cartão) pra resgate da trilha.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { createPagarmePaymentLink, pagarmeConfigured } from '../lib/pagarme.js';
import { resolveTrilhaAccess } from '../lib/trilha-access.js';
import { resolveTrilhaRedeemEligibility } from '../lib/trilha-eligibility.js';
import { buildTrilhaCartOrder, buildTrilhaPagarmePaymentLinkPayload, findTrilhaPrize } from '../lib/trilha-order.js';
import { getLeonaLifetimeRevenue } from '../lib/leona.js';
import {
  pickBrlLifetimeRevenue,
  resolveTrilhaRevenue
} from '../lib/trilha-prizes.js';
import { purchasedPrizeIdsFromCheckouts } from '../lib/trilha-account-orders.js';
import { expireAbandonedTrilhaCheckouts, listTrilhaAccountCheckouts, saveTrilhaCheckout } from '../lib/trilha-fulfill.js';

function trilhaPaidReturnUrl(accountId, email) {
  const base = (process.env.TRILHA_PUBLIC_URL || 'https://client.leonaflow.com/trilha').replace(/\/+$/, '');
  const qs = new URLSearchParams({
    id: String(accountId),
    email: String(email || ''),
    paid: '1'
  });
  return `${base}?${qs}`;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  if (!pagarmeConfigured()) {
    return res.status(500).json({ error: 'PAGARME_KEY não configurada' });
  }

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });

  const body = req.body || {};
  const accountId = String(body.account_id || body.id || '').trim();
  const email = String(body.email || '').trim();
  const prizeIds = Array.isArray(body.prize_ids) && body.prize_ids.length
    ? body.prize_ids.map((id) => String(id || '').trim()).filter(Boolean)
    : (body.prize_id ? [String(body.prize_id).trim()] : []);
  const extras = body.extras && typeof body.extras === 'object' && !Array.isArray(body.extras)
    ? body.extras
    : (body.prize_id ? { [String(body.prize_id)]: body.extra_qty } : {});

  const access = await resolveTrilhaAccess({ accountId, email, leonaToken });
  if (!access.ok) return res.status(access.status).json(access.body);

  const resolvedAccountId = String(access.profile.account_id ?? accountId);
  const profileEmail = access.profileEmail || email;

  const [redeemEligibility, lifetime] = await Promise.all([
    resolveTrilhaRedeemEligibility({
      accountId: resolvedAccountId,
      email: profileEmail,
      guruToken: process.env.GURU_TOKEN || null
    }),
    access.demo ? Promise.resolve(null) : getLeonaLifetimeRevenue(resolvedAccountId, leonaToken)
  ]);

  const apiRevenue = pickBrlLifetimeRevenue(lifetime);
  const profileRevenue = access.profile.total_revenue
    ?? access.profile.lifetime_revenue
    ?? access.profile.revenue
    ?? null;
  const { value: revenueValue } = resolveTrilhaRevenue(
    resolvedAccountId,
    apiRevenue ?? profileRevenue,
    profileEmail
  );

  let acquiredIds = [];
  try {
    acquiredIds = purchasedPrizeIdsFromCheckouts(await listTrilhaAccountCheckouts(resolvedAccountId));
  } catch (error) {
    console.error('trilha-pay acquired:', error);
  }

  const requestedAnticipate = new Set(
    (Array.isArray(body.anticipated_ids) ? body.anticipated_ids : []).map((id) => String(id || '').trim()).filter(Boolean)
  );
  const acquired = new Set(acquiredIds);
  const anticipatedIds = [];
  for (const prizeId of prizeIds) {
    const prize = findTrilhaPrize(prizeId);
    if (!prize) continue;
    if (!acquired.has(prize.id) && redeemEligibility?.eligible === false) {
      if (!requestedAnticipate.has(prize.id)) {
        return res.status(403).json({ error: 'Resgate ainda não liberado (3 meses pagos)' });
      }
      anticipatedIds.push(prize.id);
    }
  }

  const order = buildTrilhaCartOrder({
    prizeIds,
    extras,
    bumps: body.bumps || {},
    acquiredIds,
    anticipatedIds
  });
  if (!order.ok) return res.status(400).json({ error: order.error });
  for (const prize of order.prizes) {
    if (revenueValue < prize.milestone) {
      return res.status(403).json({ error: `Meta de ${prize.label} ainda não foi atingida` });
    }
  }

  const name = String(access.profile.user?.name || '').trim();
  const checkoutEmail = String(profileEmail || '').trim().toLowerCase();
  if (!checkoutEmail || !checkoutEmail.includes('@')) {
    return res.status(400).json({ error: 'E-mail da conta Leona inválido' });
  }

  const payload = buildTrilhaPagarmePaymentLinkPayload({
    accountId: resolvedAccountId,
    order,
    customerName: name,
    successUrl: trilhaPaidReturnUrl(resolvedAccountId, checkoutEmail)
  });
  const customer = payload.customer_settings.customer;

  const created = await createPagarmePaymentLink(payload);
  if (!created.ok || !created.body?.url) {
    console.error('trilha-pay: pagarme', created.status, created.body);
    logAssinaturaEvent(req, {
      action: 'trilha_pay_failed',
      provider: 'pagarme',
      email: checkoutEmail,
      account_id: resolvedAccountId,
      details: { prize_ids: order.prizeIds, status: created.status, error: created.body }
    });
    return res.status(502).json({
      error: created.body?.message || created.body?.error || 'Falha ao criar checkout na Pagar.me'
    });
  }

  try {
    await expireAbandonedTrilhaCheckouts(resolvedAccountId);
  } catch (error) {
    console.error('trilha-pay expire abandoned:', error);
  }

  try {
    await saveTrilhaCheckout({
      account_id: resolvedAccountId,
      email: checkoutEmail,
      prize_id: order.prize.id,
      extra_qty: order.extras,
      bumps: order.bumps,
      amount_cents: order.totalCents,
      name: customer.name,
      payment_link_id: created.body.id,
      checkout_url: created.body.url,
      status: 'pending',
      pontohub: {
        cart: {
          prizes: Object.fromEntries(order.prizeIds.map((id) => [id, {
            extra: order.extrasByPrize[id] || 0,
            anticipated: (order.anticipatedIds || []).includes(id)
          }]))
        }
      }
    });
  } catch (err) {
    console.error('trilha-pay: falha ao gravar checkout', err.message);
  }

  logAssinaturaEvent(req, {
    action: 'trilha_pay_created',
    provider: 'pagarme',
    email: checkoutEmail,
    account_id: resolvedAccountId,
    details: {
      prize_ids: order.prizeIds,
      total_cents: order.totalCents,
      extras: order.extrasByPrize,
      anticipated_ids: order.anticipatedIds,
      shipping_cents: order.shippingCents,
      bumps: order.bumps,
      payment_link_id: created.body.id
    }
  });

  return res.status(200).json({
    ok: true,
    url: created.body.url,
    payment_link_id: created.body.id,
    total_cents: order.totalCents
  });
}
