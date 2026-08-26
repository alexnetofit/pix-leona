/**
 * POST /api/trilha-pay — gera checkout Pagar.me (PIX + cartão) pra resgate da trilha.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { createPagarmePaymentLink, pagarmeConfigured } from '../lib/pagarme.js';
import { resolveTrilhaAccess } from '../lib/trilha-access.js';
import { resolveTrilhaRedeemEligibility } from '../lib/trilha-eligibility.js';
import {
  buildTrilhaOrder,
  parseTrilhaDocument,
  parseTrilhaPhone,
  paymentLinkItems
} from '../lib/trilha-order.js';
import { getLeonaLifetimeRevenue } from '../lib/leona.js';
import {
  pickBrlLifetimeRevenue,
  resolveTrilhaRevenue
} from '../lib/trilha-prizes.js';
import { saveTrilhaCheckout } from '../lib/trilha-fulfill.js';

function publicBase(req) {
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim();
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  if (host) return `${proto}://${host}`.replace(/\/+$/, '');
  return (process.env.PADDLE_BILLING_BASE_URL || 'https://client.leonaflow.com')
    .replace(/\/+$/, '')
    .replace(/\/paddle$/i, '');
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
  const prizeId = String(body.prize_id || '').trim();
  const method = String(body.payment_method || 'pix').toLowerCase() === 'credit_card'
    ? 'credit_card'
    : 'pix';

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
    apiRevenue ?? profileRevenue
  );

  const order = buildTrilhaOrder({
    prizeId,
    extraQty: body.extra_qty,
    bumps: body.bumps || {}
  });
  if (!order.ok) return res.status(400).json({ error: order.error });
  if (revenueValue < order.prize.milestone) {
    return res.status(403).json({ error: 'Meta deste prêmio ainda não foi atingida' });
  }
  if (order.prize.prizeFree && redeemEligibility?.eligible === false) {
    return res.status(403).json({ error: 'Resgate ainda não liberado (3 meses pagos)' });
  }

  const name = String(body.name || access.profile.user?.name || '').trim();
  const checkoutEmail = String(body.checkout_email || profileEmail).trim().toLowerCase();
  const document = parseTrilhaDocument(body.document);
  const phone = parseTrilhaPhone(body.phone);
  const cep = String(body.cep || '').replace(/\D/g, '');
  const address = String(body.address || '').trim();

  if (!name) return res.status(400).json({ error: 'Informe o nome completo' });
  if (!checkoutEmail || !checkoutEmail.includes('@')) {
    return res.status(400).json({ error: 'Informe um e-mail válido' });
  }
  if (!document) return res.status(400).json({ error: 'Informe um CPF válido' });
  if (!phone) return res.status(400).json({ error: 'Informe um WhatsApp válido' });
  if (cep.length !== 8) return res.status(400).json({ error: 'Informe um CEP válido' });
  if (address.length < 8) return res.status(400).json({ error: 'Informe o endereço completo' });

  const returnUrl = `${publicBase(req)}/trilha?id=${encodeURIComponent(resolvedAccountId)}&email=${encodeURIComponent(profileEmail)}&paid=1`;
  const payload = {
    type: 'order',
    name: `Trilha ${order.prize.id} #${resolvedAccountId}`.slice(0, 64),
    max_paid_sessions: 1,
    expires_in: 180,
    payment_settings: {
      accepted_payment_methods: ['pix', 'credit_card'],
      pix_settings: { expires_in: 3600 },
      credit_card_settings: {
        operation_type: 'auth_and_capture',
        installments_setup: {
          interest_type: 'simple',
          amount: order.totalCents,
          max_installments: 1,
          interest_rate: 0
        }
      }
    },
    customer_settings: {
      customer: {
        name,
        email: checkoutEmail,
        document: document.document,
        type: document.type,
        phones: { mobile_phone: phone }
      }
    },
    cart_settings: {
      items: paymentLinkItems(order.items.map((item, index) => (
        index === 0
          ? { ...item, description: `${item.description} · Envio ${cep} ${address}`.slice(0, 256) }
          : item
      )))
    }
  };

  const created = await createPagarmePaymentLink(payload);
  if (!created.ok || !created.body?.url) {
    console.error('trilha-pay: pagarme', created.status, created.body);
    logAssinaturaEvent(req, {
      action: 'trilha_pay_failed',
      provider: 'pagarme',
      email: checkoutEmail,
      account_id: resolvedAccountId,
      details: { prize_id: prizeId, status: created.status, error: created.body }
    });
    return res.status(502).json({
      error: created.body?.message || created.body?.error || 'Falha ao criar checkout na Pagar.me'
    });
  }

  try {
    await saveTrilhaCheckout({
      account_id: resolvedAccountId,
      email: checkoutEmail,
      prize_id: order.prize.id,
      extra_qty: order.extras,
      bumps: order.bumps,
      amount_cents: order.totalCents,
      name,
      document: document.document,
      phone: `${phone.area_code}${phone.number}`,
      cep,
      address,
      payment_link_id: created.body.id,
      checkout_url: created.body.url,
      status: 'pending'
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
      prize_id: order.prize.id,
      total_cents: order.totalCents,
      extras: order.extras,
      bumps: order.bumps,
      payment_link_id: created.body.id,
      cep,
      address: address.slice(0, 240),
      method
    }
  });

  return res.status(200).json({
    ok: true,
    url: created.body.url,
    payment_link_id: created.body.id,
    total_cents: order.totalCents
  });
}
