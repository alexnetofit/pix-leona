/**
 * POST /api/pagou-pay — cria assinatura Pagou (padrão) ou avulso (upgrade no ciclo).
 * GET  /api/pagou-pay?id=&account_id=&email=&type= — status da cobrança.
 */
import { applyCors } from '../lib/auth.js';
import { assertAccountAccess } from '../lib/leona.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import {
  createPagouSubscription,
  createPagouTransaction,
  extractPix,
  firstSubscriptionTransaction,
  getPagouSubscription,
  getPagouTransaction,
  pagouConfigured,
  subscriptionPaid,
  upsertPagouCustomer
} from '../lib/pagou.js';
import { leonaAmountCents, makeLeonaRef, reaisToCents } from '../lib/leona-pricing.js';
import { sbConfigured, sbInsert } from '../lib/supabase.js';

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function documentFrom(raw) {
  const number = onlyDigits(raw);
  if (number.length === 14) return { type: 'CNPJ', number };
  if (number.length === 11) return { type: 'CPF', number };
  return null;
}

function phoneFrom(raw) {
  const digits = onlyDigits(raw);
  if (!digits) return undefined;
  if (digits.startsWith('55') && digits.length >= 12) return `+${digits}`;
  if (digits.length >= 10) return `+55${digits}`;
  return undefined;
}

function customerPhone(raw) {
  const digits = onlyDigits(raw);
  if (!digits) return undefined;
  if (digits.startsWith('55') && digits.length >= 13) return digits.slice(-11);
  if (digits.length === 11) return digits;
  return undefined;
}

function addressFrom(raw = {}) {
  const zip = onlyDigits(raw.zip || raw.zipCode || raw.cep);
  return {
    street: String(raw.street || 'Avenida Paulista').trim() || 'Avenida Paulista',
    number: String(raw.number || '1000').trim() || '1000',
    neighborhood: String(raw.neighborhood || 'Bela Vista').trim() || 'Bela Vista',
    city: String(raw.city || 'Sao Paulo').trim() || 'Sao Paulo',
    state: String(raw.state || 'SP').trim().slice(0, 2).toUpperCase() || 'SP',
    zipCode: zip || '01310100',
    country: 'BR'
  };
}

function txPayload(data = {}) {
  return data.data || data;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '')
    .split(',')[0]
    .trim();
}

function billingDayOfMonth() {
  const day = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    day: 'numeric'
  }).format(new Date()));
  return Math.min(28, Math.max(1, day || 1));
}

function pagouError(body) {
  return body?.detail || body?.message || body?.error || 'Pagou não gerou o pagamento';
}

function isOneShotKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return kind === 'one_shot' || kind === 'oneshot' || kind === 'avulso' || kind === 'upgrade';
}

async function rememberIntent(row) {
  if (!sbConfigured()) return;
  try {
    await sbInsert('pagou_checkout_intents', row);
  } catch (err) {
    console.error('pagou-pay: falha ao gravar intent', err.message);
  }
}

async function hydratePixFromTx(txId, fallback = {}) {
  if (!txId) return extractPix(fallback);
  const found = await getPagouTransaction(txId);
  if (!found.ok) return extractPix(fallback);
  return extractPix(txPayload(found.body));
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });
  if (!pagouConfigured()) return res.status(500).json({ error: 'PAGOU_SECRET_KEY não configurado' });

  if (req.method === 'GET') {
    const { id, account_id, email, type } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    const access = await assertAccountAccess({
      accountId: account_id,
      queryEmail: email,
      leonaToken,
      route: '/api/pagou-pay'
    });
    if (!access.ok) return res.status(access.status).json(access.body);

    const wantSub = String(type || '').toLowerCase() === 'subscription';
    if (wantSub) {
      const found = await getPagouSubscription(id);
      const data = txPayload(found.body);
      if (!found.ok || !data?.id) {
        return res.status(found.status || 404).json({ error: 'Assinatura não encontrada' });
      }
      const tx = firstSubscriptionTransaction(data);
      return res.status(200).json({
        id: data.id,
        subscription_id: data.id,
        transaction_id: tx?.id || null,
        status: data.status || null,
        method: data.payment_method || data.paymentMethod || null,
        paid: subscriptionPaid(data),
        pix: extractPix(data)
      });
    }

    const found = await getPagouTransaction(id);
    const data = txPayload(found.body);
    if (!found.ok || !data?.id) {
      return res.status(found.status || 404).json({ error: 'Transação não encontrada' });
    }
    return res.status(200).json({
      id: data.id,
      status: data.status || null,
      method: data.method || null,
      paid: String(data.status || '').toLowerCase() === 'paid',
      pix: extractPix(data)
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const {
    account_id,
    email,
    qty,
    amount,
    offer_name,
    method,
    token,
    buyer,
    kind
  } = req.body || {};

  const accountId = account_id != null ? String(account_id).trim() : '';
  const qtyN = Math.max(1, Number(qty) || 0);
  const payMethod = String(method || 'pix').toLowerCase() === 'credit_card' ? 'credit_card' : 'pix';
  const oneShot = isOneShotKind(kind);
  if (!accountId) return res.status(400).json({ error: 'account_id obrigatório' });
  if (!qtyN) return res.status(400).json({ error: 'qty obrigatória' });

  const access = await assertAccountAccess({
    accountId,
    queryEmail: email,
    leonaToken,
    route: '/api/pagou-pay'
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const amountCents = reaisToCents(amount) || leonaAmountCents(qtyN);
  const title = `${makeLeonaRef(accountId, qtyN)}:${Date.now()}`;
  const productName = offer_name || `Leona Flow — ${qtyN} conex${qtyN === 1 ? 'ão' : 'ões'}`;
  const buyerEmail = access.profileEmail || email;
  const buyerName = String(buyer?.name || '').trim();
  const document = documentFrom(buyer?.document || buyer?.cpf || buyer?.cnpj);
  const address = addressFrom(buyer?.address || buyer);
  const ip = clientIp(req);
  if (!buyerName || buyerName.split(/\s+/).length < 2) {
    return res.status(400).json({ error: 'Informe nome e sobrenome' });
  }
  if (!document) {
    return res.status(400).json({ error: 'CPF ou CNPJ inválido' });
  }
  if (!phoneFrom(buyer?.phone)) {
    return res.status(400).json({ error: 'Informe um celular com DDD' });
  }
  if (payMethod === 'credit_card' && !token) {
    return res.status(400).json({ error: 'Token do cartão ausente' });
  }

  if (oneShot) {
    const payload = {
      external_ref: title,
      amount: amountCents,
      currency: 'BRL',
      method: payMethod,
      buyer: {
        name: buyerName,
        email: buyerEmail,
        document,
        address,
        ...(phoneFrom(buyer?.phone) ? { phone: phoneFrom(buyer.phone) } : {})
      },
      products: [{
        name: productName,
        price: amountCents,
        quantity: 1
      }]
    };
    if (payMethod === 'credit_card') {
      payload.token = token;
      payload.installments = 1;
      if (ip) payload.ip_address = ip;
    }

    const created = await createPagouTransaction(payload);
    const data = txPayload(created.body);
    if (!created.ok || !data?.id) {
      logAssinaturaEvent(req, {
        action: 'pagou_pay_error',
        provider: 'pagou',
        email: buyerEmail,
        account_id: accountId,
        details: {
          qty: qtyN,
          method: payMethod,
          kind: 'one_shot',
          status: created.status,
          error: created.body
        }
      });
      return res.status(created.status || 502).json({ error: pagouError(created.body) });
    }

    await rememberIntent({
      account_id: accountId,
      email: buyerEmail || null,
      qty: qtyN,
      amount_cents: amountCents,
      title,
      checkout_url: null,
      status: 'pending',
      pagou_transaction_id: data.id,
      details: { offer_name: productName, method: payMethod, kind: 'one_shot' }
    });

    logAssinaturaEvent(req, {
      action: payMethod === 'pix' ? 'pagou_pix_created' : 'pagou_card_created',
      provider: 'pagou',
      email: buyerEmail,
      account_id: accountId,
      details: { qty: qtyN, amount_cents: amountCents, title, tx: data.id, status: data.status, kind: 'one_shot' }
    });

    return res.status(200).json({
      success: true,
      id: data.id,
      subscription_id: null,
      status: data.status || null,
      method: payMethod,
      kind: 'one_shot',
      paid: String(data.status || '').toLowerCase() === 'paid',
      next_action: data.next_action || null,
      pix: extractPix(data),
      qty: qtyN,
      amount_cents: amountCents,
      offer_name: productName
    });
  }

  const customer = await upsertPagouCustomer({
    name: buyerName,
    email: buyerEmail,
    document,
    phone: customerPhone(buyer?.phone),
    address,
    externalRef: `leona:${accountId}`,
    ...(ip ? { ip_address: ip } : {})
  });
  if (!customer.ok || !customer.data?.id) {
    logAssinaturaEvent(req, {
      action: 'pagou_pay_error',
      provider: 'pagou',
      email: buyerEmail,
      account_id: accountId,
      details: { qty: qtyN, method: payMethod, kind: 'subscription', error: customer.body, step: 'customer' }
    });
    return res.status(customer.status || 502).json({ error: pagouError(customer.body) });
  }

  const metadata = {
    leona_ref: makeLeonaRef(accountId, qtyN),
    account_id: accountId,
    qty: String(qtyN),
    kind: 'subscription'
  };
  const products = [{
    name: productName,
    price: amountCents,
    quantity: 1
  }];

  const subPayload = payMethod === 'credit_card'
    ? {
        customer_id: customer.data.id,
        token,
        amount: amountCents,
        currency: 'BRL',
        interval: 'month',
        interval_count: 1,
        failure_policy: 'retry_then_cancel',
        payment_method: 'credit_card',
        products,
        metadata,
        idempotency_key: title
      }
    : {
        customer_id: customer.data.id,
        amount: amountCents,
        currency: 'BRL',
        interval: 'month',
        interval_count: 1,
        failure_policy: 'retry_then_cancel',
        payment_method: 'pix_automatic',
        billing_day_of_month: billingDayOfMonth(),
        comment: title.slice(0, 140),
        products,
        metadata,
        idempotency_key: title
      };

  const created = await createPagouSubscription(subPayload);
  const data = txPayload(created.body);
  if (!created.ok || !data?.id) {
    logAssinaturaEvent(req, {
      action: 'pagou_pay_error',
      provider: 'pagou',
      email: buyerEmail,
      account_id: accountId,
      details: {
        qty: qtyN,
        method: payMethod,
        kind: 'subscription',
        status: created.status,
        error: created.body
      }
    });
    return res.status(created.status || 502).json({
      error: pagouError(created.body)
    });
  }

  const firstTx = firstSubscriptionTransaction(data);
  let nextAction = data.next_action || data.nextAction || null;
  let pix = extractPix(data);
  if (firstTx?.id) {
    const tx = await getPagouTransaction(firstTx.id);
    const txData = txPayload(tx.body);
    nextAction = txData.next_action || txData.nextAction || nextAction;
    pix = extractPix(txData);
  } else if (!pix.qr_code) {
    pix = await hydratePixFromTx(data.latest_transaction_id || data.latestTransactionId, data);
  }

  await rememberIntent({
    account_id: accountId,
    email: buyerEmail || null,
    qty: qtyN,
    amount_cents: amountCents,
    title,
    checkout_url: null,
    status: 'pending',
    pagou_transaction_id: firstTx?.id || null,
    details: {
      offer_name: productName,
      method: payMethod === 'pix' ? 'pix_automatic' : payMethod,
      kind: 'subscription',
      pagou_subscription_id: data.id,
      pagou_customer_id: customer.data.id
    }
  });

  logAssinaturaEvent(req, {
    action: payMethod === 'pix' ? 'pagou_pix_sub_created' : 'pagou_card_sub_created',
    provider: 'pagou',
    email: buyerEmail,
    account_id: accountId,
    details: {
      qty: qtyN,
      amount_cents: amountCents,
      title,
      subscription_id: data.id,
      tx: firstTx?.id || null,
      status: data.status,
      kind: 'subscription'
    }
  });

  return res.status(200).json({
    success: true,
    id: firstTx?.id || data.id,
    subscription_id: data.id,
    status: firstTx?.status || data.status || null,
    method: payMethod,
    kind: 'subscription',
    paid: subscriptionPaid(data) || String(firstTx?.status || '').toLowerCase() === 'paid',
    next_action: nextAction,
    pix,
    qty: qtyN,
    amount_cents: amountCents,
    offer_name: productName
  });
}
