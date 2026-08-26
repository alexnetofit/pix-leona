/**
 * POST /api/dlocal-go-pay — cria checkout dLocal Go (pró-rata ou renovação).
 * GET  /api/dlocal-go-pay?id=DP-xxx — status do pagamento.
 */
import { applyCors } from '../lib/auth.js';
import { assertAccountAccess } from '../lib/leona.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { leonaAmountCents, reaisToCents } from '../lib/leona-pricing.js';
import { sbConfigured, sbInsert, sbSelect, sbUpdate } from '../lib/supabase.js';
import {
  brlToUsd,
  createDlocalPayment,
  dlocalGoConfigured,
  dlocalGoPublicBase,
  dlocalGoWebhookUrl,
  dlocalPaymentPaid,
  ensureDlocalPlan,
  getDlocalPayment,
  getDlocalUsdToBrlRate,
  isIntlRegion,
  isOneShotKind,
  makeDlocalOrderId,
  subscribeUrlWithPayer
} from '../lib/dlocal-go.js';

function requestOrigin(req) {
  return dlocalGoPublicBase(req);
}

async function rememberIntent(row) {
  if (!sbConfigured()) return null;
  try {
    return await sbInsert('dlocal_checkout_intents', row);
  } catch (err) {
    console.error('dlocal-go-pay: falha ao gravar intent', err.message);
    return null;
  }
}

async function rememberSubscription({ accountId, email, qty, planId, details }) {
  if (!sbConfigured()) return;
  try {
    const existing = await sbSelect('dlocal_subscriptions', {
      eq: { account_id: String(accountId), qty: Number(qty) },
      limit: 1
    });
    const patch = {
      email: email || null,
      plan_id: planId ? String(planId) : null,
      status: 'pending',
      updated_at: new Date().toISOString(),
      details: details || {}
    };
    if (existing[0]?.id) {
      await sbUpdate('dlocal_subscriptions', { id: existing[0].id }, patch);
      return;
    }
    await sbInsert('dlocal_subscriptions', {
      account_id: String(accountId),
      qty: Number(qty),
      ...patch
    });
  } catch (err) {
    console.error('dlocal-go-pay: falha ao gravar subscription', err.message);
  }
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });
  if (!dlocalGoConfigured()) return res.status(500).json({ error: 'DLOCAL_GO_* não configurado' });

  if (req.method === 'GET') {
    const { id, account_id, email } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    const access = await assertAccountAccess({
      accountId: account_id,
      queryEmail: email,
      leonaToken,
      route: '/api/dlocal-go-pay'
    });
    if (!access.ok) return res.status(access.status).json(access.body);
    const found = await getDlocalPayment(id);
    const data = found.body || {};
    if (!found.ok || !data.id) {
      return res.status(found.status || 404).json({ error: 'Pagamento não encontrado' });
    }
    return res.status(200).json({
      id: data.id,
      status: data.status || null,
      paid: dlocalPaymentPaid(data),
      amount: data.amount,
      currency: data.currency,
      order_id: data.order_id || null,
      redirect_url: data.redirect_url || null
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { account_id, email, qty, amount, offer_name, kind, region } = req.body || {};
  const accountId = account_id != null ? String(account_id).trim() : '';
  const qtyN = Math.max(1, Number(qty) || 0);
  const oneShot = isOneShotKind(kind);
  const intl = isIntlRegion(region);
  if (!accountId) return res.status(400).json({ error: 'account_id obrigatório' });
  if (!qtyN) return res.status(400).json({ error: 'qty obrigatória' });

  const access = await assertAccountAccess({
    accountId,
    queryEmail: email,
    leonaToken,
    route: '/api/dlocal-go-pay'
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const customCents = reaisToCents(amount);
  if (oneShot && !customCents) {
    return res.status(400).json({ error: 'amount obrigatório no ajuste proporcional' });
  }
  const amountCents = customCents || leonaAmountCents(qtyN);
  const amountReais = Number((amountCents / 100).toFixed(2));
  const title = makeDlocalOrderId(accountId, qtyN, oneShot ? 'prorata' : 'sub');
  const productName = offer_name || `Leona Flow — ${qtyN} conex${qtyN === 1 ? 'ão' : 'ões'}`;
  const buyerEmail = access.profileEmail || email;
  const origin = requestOrigin(req);
  const notificationUrl = dlocalGoWebhookUrl(req);
  const returnQs = new URLSearchParams({
    account_id: accountId,
    ...(buyerEmail ? { email: buyerEmail } : {})
  });
  const successUrl = `${origin}/assinatura?${returnQs}&dlocal=ok`;
  const backUrl = `${origin}/assinatura?${returnQs}`;

  if (oneShot) {
    const created = await createDlocalPayment({
      currency: 'BRL',
      amount: amountReais,
      ...(intl ? {} : { country: 'BR' }),
      order_id: title,
      description: productName.slice(0, 100),
      notification_url: notificationUrl,
      success_url: successUrl,
      back_url: backUrl,
      expiration_type: 'DAYS',
      expiration_value: 2,
      payer: {
        email: buyerEmail || undefined,
        user_reference: `leona:${accountId}`
      }
    });
    const data = created.body || {};
    console.log('dlocal-go-pay: one_shot', created.status, data.id, title, amountReais, intl ? 'intl' : 'br');
    if (!created.ok || !data.id || !data.redirect_url) {
      logAssinaturaEvent(req, {
        action: 'dlocal_pay_error',
        provider: 'dlocal',
        email: buyerEmail,
        account_id: accountId,
        details: { qty: qtyN, kind: 'one_shot', region: intl ? 'international' : 'br', status: created.status, error: created.body, title }
      });
      return res.status(created.status || 502).json({
        error: created.body?.message || created.body?.error || 'dLocal Go não gerou o checkout'
      });
    }

    await rememberIntent({
      account_id: accountId,
      email: buyerEmail || null,
      qty: qtyN,
      amount_cents: amountCents,
      title,
      checkout_url: data.redirect_url,
      status: 'pending',
      dlocal_payment_id: data.id,
      details: { kind: 'one_shot', region: intl ? 'international' : 'br', offer_name: productName, order_id: title }
    });
    logAssinaturaEvent(req, {
      action: 'dlocal_pay_created',
      provider: 'dlocal',
      email: buyerEmail,
      account_id: accountId,
      details: {
        qty: qtyN,
        amount_cents: amountCents,
        kind: 'one_shot',
        region: intl ? 'international' : 'br',
        payment_id: data.id,
        order_id: title
      }
    });

    return res.status(200).json({
      success: true,
      id: data.id,
      status: data.status || 'PENDING',
      kind: 'one_shot',
      checkout_url: data.redirect_url,
      qty: qtyN,
      amount_cents: amountCents,
      offer_name: productName
    });
  }

  let planAmount = amountReais;
  let planCurrency = 'BRL';
  let planCountry = 'BR';
  if (intl) {
    const fx = await getDlocalUsdToBrlRate();
    const usd = brlToUsd(amountReais, fx.rate);
    console.log('dlocal-go-pay: fx', fx.ok, fx.rate, amountReais, usd);
    if (!fx.ok || !usd) {
      logAssinaturaEvent(req, {
        action: 'dlocal_pay_error',
        provider: 'dlocal',
        email: buyerEmail,
        account_id: accountId,
        details: { qty: qtyN, kind: 'subscription', region: 'international', step: 'fx', error: fx.body }
      });
      return res.status(fx.status || 502).json({
        error: 'Não deu para converter o valor para USD agora. Tente de novo.'
      });
    }
    planAmount = usd;
    planCurrency = 'USD';
    planCountry = undefined;
  }

  const plan = await ensureDlocalPlan({
    qty: qtyN,
    amount: planAmount,
    currency: planCurrency,
    country: planCountry,
    notificationUrl,
    successUrl,
    backUrl,
    errorUrl: backUrl
  });
  console.log('dlocal-go-pay: plan', qtyN, planCurrency, planAmount, plan.ok, plan.created, plan.plan?.id);
  if (!plan.ok || !plan.plan?.subscribe_url) {
    logAssinaturaEvent(req, {
      action: 'dlocal_pay_error',
      provider: 'dlocal',
      email: buyerEmail,
      account_id: accountId,
      details: { qty: qtyN, kind: 'subscription', region: intl ? 'international' : 'br', error: plan.body, step: 'plan' }
    });
    return res.status(plan.status || 502).json({
      error: plan.body?.message || plan.body?.error || 'dLocal Go não gerou o plano de assinatura'
    });
  }

  const checkoutUrl = subscribeUrlWithPayer(plan.plan.subscribe_url, {
    email: buyerEmail,
    accountId,
    qty: qtyN
  });

  await rememberIntent({
    account_id: accountId,
    email: buyerEmail || null,
    qty: qtyN,
    amount_cents: amountCents,
    title,
    checkout_url: checkoutUrl,
    status: 'pending',
    dlocal_plan_id: String(plan.plan.id),
    details: {
      kind: 'subscription',
      region: intl ? 'international' : 'br',
      offer_name: productName,
      order_id: title,
      plan_token: plan.plan.plan_token,
      currency: planCurrency,
      charge_amount: planAmount
    }
  });
  await rememberSubscription({
    accountId,
    email: buyerEmail,
    qty: qtyN,
    planId: plan.plan.id,
    details: { order_id: title, subscribe_url: checkoutUrl }
  });
  logAssinaturaEvent(req, {
    action: 'dlocal_sub_created',
    provider: 'dlocal',
    email: buyerEmail,
    account_id: accountId,
    details: {
      qty: qtyN,
      amount_cents: amountCents,
      kind: 'subscription',
      region: intl ? 'international' : 'br',
      plan_id: plan.plan.id,
      currency: planCurrency,
      checkout_url: checkoutUrl
    }
  });

  return res.status(200).json({
    success: true,
    id: String(plan.plan.id),
    status: 'PENDING',
    kind: 'subscription',
    checkout_url: checkoutUrl,
    qty: qtyN,
    amount_cents: amountCents,
    offer_name: productName
  });
}
