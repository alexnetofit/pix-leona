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
  customerDocumentOf,
  toPagouDocument,
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

function pixAutomaticUnsupported(body) {
  const text = JSON.stringify(body || {}).toLowerCase();
  if (text.includes('unrecognized keys') && (text.includes('document') || text.includes('buyer'))) return true;
  return text.includes('pix_automatic') && (text.includes('not supported') || text.includes('não suport'));
}

function isOneShotKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return kind === 'one_shot' || kind === 'oneshot' || kind === 'avulso' || kind === 'upgrade';
}

function chargeFailed(status, nextAction) {
  const st = String(status || '').toLowerCase();
  return ['error', 'refused', 'failed', 'canceled', 'cancelled', 'incomplete'].includes(st) && !nextAction;
}

function documentRequiredError(body) {
  const text = JSON.stringify(body || {}).toLowerCase();
  return text.includes('document is required') || (text.includes('document') && text.includes('pagar.me'));
}

function buildOneShotPayload({
  title,
  amountCents,
  payMethod,
  token,
  ip,
  buyerName,
  buyerEmail,
  document,
  address,
  phone,
  productName
}) {
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
      ...(phoneFrom(phone) ? { phone: phoneFrom(phone) } : {})
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
  return payload;
}

async function settleOneShot(req, {
  created,
  data,
  buyerEmail,
  accountId,
  qtyN,
  amountCents,
  title,
  productName,
  payMethod,
  fallback
}) {
  if (!created.ok || !data?.id) return null;
  if (chargeFailed(data.status, data.next_action || data.nextAction)) return null;

  await rememberIntent({
    account_id: accountId,
    email: buyerEmail || null,
    qty: qtyN,
    amount_cents: amountCents,
    title,
    checkout_url: null,
    status: 'pending',
    pagou_transaction_id: data.id,
    details: {
      offer_name: productName,
      method: payMethod,
      kind: 'one_shot',
      ...(fallback ? { fallback } : {})
    }
  });

  logAssinaturaEvent(req, {
    action: payMethod === 'pix' ? 'pagou_pix_created' : 'pagou_card_created',
    provider: 'pagou',
    email: buyerEmail,
    account_id: accountId,
    details: {
      qty: qtyN,
      amount_cents: amountCents,
      title,
      tx: data.id,
      status: data.status,
      kind: 'one_shot',
      ...(fallback ? { fallback } : {})
    }
  });

  return {
    success: true,
    id: data.id,
    subscription_id: null,
    status: data.status || null,
    method: payMethod,
    kind: 'one_shot',
    paid: String(data.status || '').toLowerCase() === 'paid',
    next_action: data.next_action || data.nextAction || null,
    pix: extractPix(data),
    qty: qtyN,
    amount_cents: amountCents,
    offer_name: productName,
    ...(fallback ? { fallback } : {})
  };
}

async function fallbackCardOneShot(req, oneShotArgs, extra) {
  if (oneShotArgs.payMethod !== 'credit_card') return null;
  const created = await createPagouTransaction(buildOneShotPayload(oneShotArgs));
  return settleOneShot(req, {
    created,
    data: txPayload(created.body),
    buyerEmail: extra.buyerEmail,
    accountId: extra.accountId,
    qtyN: extra.qtyN,
    amountCents: extra.amountCents,
    title: extra.title,
    productName: extra.productName,
    payMethod: 'credit_card',
    fallback: 'card_sub_to_tx'
  });
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
  const document = toPagouDocument(buyer?.document || buyer?.cpf || buyer?.cnpj) || documentFrom(buyer?.document || buyer?.cpf || buyer?.cnpj);
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

  const oneShotArgs = {
    title,
    amountCents,
    payMethod,
    token,
    ip,
    buyerName,
    buyerEmail,
    document,
    address,
    phone: buyer?.phone,
    productName
  };

  if (oneShot) {
    const created = await createPagouTransaction(buildOneShotPayload(oneShotArgs));
    const data = txPayload(created.body);
    const json = await settleOneShot(req, {
      created,
      data,
      buyerEmail,
      accountId,
      qtyN,
      amountCents,
      title,
      productName,
      payMethod
    });
    if (!json) {
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
    return res.status(200).json(json);
  }

  const customer = await upsertPagouCustomer({
    name: buyerName,
    email: buyerEmail,
    document,
    phone: customerPhone(buyer?.phone),
    address,
    ip,
    externalRef: `leona:${accountId}`
  });
  if (!customer.ok || !customer.data?.id || !customerDocumentOf(customer.data)) {
    logAssinaturaEvent(req, {
      action: 'pagou_pay_error',
      provider: 'pagou',
      email: buyerEmail,
      account_id: accountId,
      details: { qty: qtyN, method: payMethod, kind: 'subscription', error: customer.body, step: 'customer' }
    });
    return res.status(customer.status || 502).json({
      error: pagouError(customer.body) || 'Informe um CPF ou CNPJ válido para assinar'
    });
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
  const buyerPayload = {
    name: buyerName,
    email: buyerEmail,
    document,
    address,
    ...(phoneFrom(buyer?.phone) ? { phone: phoneFrom(buyer.phone) } : {})
  };
  const documentFields = {
    document,
    buyer: buyerPayload
  };

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
        idempotency_key: title,
        ...documentFields,
        ...(ip ? { ip_address: ip } : {})
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

  let created = await createPagouSubscription(subPayload);
  let data = txPayload(created.body);
  if ((!created.ok || !data?.id) && payMethod === 'pix' && pixAutomaticUnsupported(created.body)) {
    const pixTx = await createPagouTransaction({
      external_ref: title,
      amount: amountCents,
      currency: 'BRL',
      method: 'pix',
      buyer: {
        name: buyerName,
        email: buyerEmail,
        document,
        address,
        ...(phoneFrom(buyer?.phone) ? { phone: phoneFrom(buyer.phone) } : {})
      },
      products: [{ name: productName, price: amountCents, quantity: 1 }]
    });
    created = pixTx;
    data = txPayload(pixTx.body);
    if (created.ok && data?.id) {
      await rememberIntent({
        account_id: accountId,
        email: buyerEmail || null,
        qty: qtyN,
        amount_cents: amountCents,
        title,
        checkout_url: null,
        status: 'pending',
        pagou_transaction_id: data.id,
        details: { offer_name: productName, method: 'pix', kind: 'subscription', fallback: 'pix_tx' }
      });
      logAssinaturaEvent(req, {
        action: 'pagou_pix_created',
        provider: 'pagou',
        email: buyerEmail,
        account_id: accountId,
        details: { qty: qtyN, amount_cents: amountCents, title, tx: data.id, status: data.status, kind: 'subscription', fallback: 'pix_tx' }
      });
      return res.status(200).json({
        success: true,
        id: data.id,
        subscription_id: null,
        status: data.status || null,
        method: 'pix',
        kind: 'subscription',
        paid: String(data.status || '').toLowerCase() === 'paid',
        next_action: data.next_action || null,
        pix: extractPix(data),
        qty: qtyN,
        amount_cents: amountCents,
        offer_name: productName
      });
    }
  }
  if (!created.ok || !data?.id) {
    const skipSameToken = documentRequiredError(created.body);
    const fallback = skipSameToken
      ? null
      : await fallbackCardOneShot(req, oneShotArgs, {
          buyerEmail,
          accountId,
          qtyN,
          amountCents,
          title,
          productName
        });
    if (fallback) return res.status(200).json(fallback);

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
        error: created.body,
        retry_one_shot: skipSameToken || payMethod === 'credit_card'
      }
    });
    return res.status(created.status || 502).json({
      error: skipSameToken
        ? 'Não deu para assinar neste cartão. Tentando cobrança avulsa…'
        : pagouError(created.body),
      retry_one_shot: true
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

  const firstStatus = String(firstTx?.status || data.status || '').toLowerCase();
  if (chargeFailed(firstStatus, nextAction)) {
    const fallback = await fallbackCardOneShot(req, oneShotArgs, {
      buyerEmail,
      accountId,
      qtyN,
      amountCents,
      title,
      productName
    });
    if (fallback) return res.status(200).json(fallback);

    logAssinaturaEvent(req, {
      action: 'pagou_pay_error',
      provider: 'pagou',
      email: buyerEmail,
      account_id: accountId,
      details: {
        qty: qtyN,
        method: payMethod,
        kind: 'subscription',
        subscription_id: data.id,
        tx: firstTx?.id || null,
        status: firstStatus
      }
    });
    return res.status(402).json({
      error: 'Cartão recusado. Tente outro cartão ou pague com PIX.',
      subscription_id: data.id,
      status: firstStatus
    });
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
