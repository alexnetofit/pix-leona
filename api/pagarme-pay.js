/**
 * POST /api/pagarme-pay — checkout Pagar.me (Stone) da /assinatura.
 * GET  /api/pagarme-pay?id=or_xxx — status do pedido (assinatura).
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { assertAccountAccess } from '../lib/leona.js';
import {
  getPagarmeOrder,
  getPagarmePaymentLink,
  pagarmeConfigured,
  pagarmeOrderLooksPaid
} from '../lib/pagarme.js';
import { createPagarmeAssinaturaCheckout } from '../lib/pagarme-assinatura.js';
import { paymentLinkLooksPaid } from '../lib/trilha-fulfill.js';

function readCard(body = {}) {
  const raw = body.card && typeof body.card === 'object' ? body.card : {};
  const number = String(raw.number || '').replace(/\D/g, '');
  const holder = String(raw.holder_name || body.name || '').trim();
  const expiry = String(raw.exp || raw.expiry || '').replace(/\D/g, '');
  let expMonth = Number(raw.exp_month);
  let expYear = Number(raw.exp_year);
  if ((!expMonth || !expYear) && expiry.length >= 4) {
    expMonth = Number(expiry.slice(0, 2));
    expYear = Number(expiry.slice(2));
  }
  if (expYear && expYear < 100) expYear += 2000;
  const cvv = String(raw.cvv || '').replace(/\D/g, '');
  if (number.length < 13 || !holder || !expMonth || !expYear || cvv.length < 3) return null;
  return { number, holder_name: holder, exp_month: expMonth, exp_year: expYear, cvv };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });
  if (!pagarmeConfigured()) return res.status(500).json({ error: 'PAGARME_KEY não configurada' });

  if (req.method === 'GET') {
    const { id, account_id, email } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    const access = await assertAccountAccess({
      accountId: account_id,
      queryEmail: email,
      leonaToken,
      route: '/api/pagarme-pay'
    });
    if (!access.ok) return res.status(access.status).json(access.body);
    if (/^or_/i.test(String(id))) {
      const found = await getPagarmeOrder(id);
      if (!found.ok || !found.body?.id) {
        return res.status(found.status || 404).json({ error: 'Cobrança não encontrada' });
      }
      return res.status(200).json({
        id: found.body.id,
        status: found.body.status || null,
        paid: pagarmeOrderLooksPaid(found.body)
      });
    }
    const found = await getPagarmePaymentLink(id);
    if (!found.ok || !found.body?.id) {
      return res.status(found.status || 404).json({ error: 'Checkout não encontrado' });
    }
    return res.status(200).json({
      id: found.body.id,
      status: found.body.status || null,
      paid: paymentLinkLooksPaid(found.body),
      checkout_url: found.body.url || null
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { account_id, email, qty, amount, kind, name, method, card_token } = req.body || {};
  const accountId = account_id != null ? String(account_id).trim() : '';
  if (!accountId) return res.status(400).json({ error: 'account_id obrigatório' });
  const payMethod = String(method || 'pix').toLowerCase() === 'card'
    || String(method || '').toLowerCase() === 'credit_card'
    ? 'credit_card'
    : 'pix';
  const card = payMethod === 'credit_card' && !card_token ? readCard(req.body || {}) : null;

  const access = await assertAccountAccess({
    accountId,
    queryEmail: email,
    leonaToken,
    route: '/api/pagarme-pay'
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const created = await createPagarmeAssinaturaCheckout({
    accountId: String(access.profile.account_id ?? accountId),
    email: access.profileEmail || email,
    name: name || access.profile?.user?.name,
    qty,
    kind,
    amount,
    profile: access.profile,
    method: payMethod,
    cardToken: card_token || null,
    card
  });

  if (!created.ok) {
    logAssinaturaEvent(req, {
      action: 'pagarme_pay_error',
      provider: 'pagarme',
      email: access.profileEmail || email,
      account_id: accountId,
      details: { qty, kind, method: payMethod, error: created.error, status: created.status }
    });
    return res.status(created.status && created.status < 500 ? created.status : 502).json({
      error: created.error
    });
  }

  logAssinaturaEvent(req, {
    action: 'pagarme_pay_created',
    provider: 'pagarme',
    email: access.profileEmail || email,
    account_id: String(access.profile.account_id ?? accountId),
    details: {
      qty: created.qty,
      amount_cents: created.amountCents,
      kind: created.oneShot ? 'one_shot' : 'subscription',
      payment_id: created.id,
      method: payMethod,
      paid: Boolean(created.paid)
    }
  });

  return res.status(200).json({
    success: true,
    id: created.id,
    status: created.paid ? 'paid' : 'PENDING',
    paid: Boolean(created.paid),
    kind: created.oneShot ? 'one_shot' : 'subscription',
    pix: created.pix || null,
    qty: created.qty,
    amount_cents: created.amountCents,
    offer_name: created.productName
  });
}
