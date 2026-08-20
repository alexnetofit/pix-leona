/**
 * POST /api/pagou-pay — cria PIX ou cartão na Pagou.
 * GET  /api/pagou-pay?id=&account_id=&email= — status da transação.
 */
import { applyCors } from '../lib/auth.js';
import { assertAccountAccess } from '../lib/leona.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { createPagouTransaction, extractPix, getPagouTransaction, pagouConfigured } from '../lib/pagou.js';
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

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });
  if (!pagouConfigured()) return res.status(500).json({ error: 'PAGOU_SECRET_KEY não configurado' });

  if (req.method === 'GET') {
    const { id, account_id, email } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    const access = await assertAccountAccess({
      accountId: account_id,
      queryEmail: email,
      leonaToken,
      route: '/api/pagou-pay'
    });
    if (!access.ok) return res.status(access.status).json(access.body);

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
    buyer
  } = req.body || {};

  const accountId = account_id != null ? String(account_id).trim() : '';
  const qtyN = Math.max(1, Number(qty) || 0);
  const payMethod = String(method || 'pix').toLowerCase() === 'credit_card' ? 'credit_card' : 'pix';
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

  const payload = {
    external_ref: title,
    amount: amountCents,
    currency: 'BRL',
    method: payMethod,
    buyer: {
      name: buyerName,
      email: buyerEmail,
      document,
      address: addressFrom(buyer?.address || buyer),
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
    const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '')
      .split(',')[0]
      .trim();
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
        status: created.status,
        error: created.body?.detail || created.body?.message || created.body?.error || created.body
      }
    });
    return res.status(created.status || 502).json({
      error: created.body?.detail || created.body?.message || 'Pagou não gerou o pagamento'
    });
  }

  if (sbConfigured()) {
    try {
      await sbInsert('pagou_checkout_intents', {
        account_id: accountId,
        email: buyerEmail || null,
        qty: qtyN,
        amount_cents: amountCents,
        title,
        checkout_url: null,
        status: 'pending',
        pagou_transaction_id: data.id,
        details: { offer_name: productName, method: payMethod }
      });
    } catch (err) {
      console.error('pagou-pay: falha ao gravar intent', err.message);
    }
  }

  logAssinaturaEvent(req, {
    action: payMethod === 'pix' ? 'pagou_pix_created' : 'pagou_card_created',
    provider: 'pagou',
    email: buyerEmail,
    account_id: accountId,
    details: { qty: qtyN, amount_cents: amountCents, title, tx: data.id, status: data.status }
  });

  return res.status(200).json({
    success: true,
    id: data.id,
    status: data.status || null,
    method: payMethod,
    paid: String(data.status || '').toLowerCase() === 'paid',
    next_action: data.next_action || null,
    pix: extractPix(data),
    qty: qtyN,
    amount_cents: amountCents,
    offer_name: productName
  });
}
