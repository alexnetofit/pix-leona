/**
 * POST /api/pagarme-pay — checkout Pagar.me (Stone) da /assinatura.
 * GET  /api/pagarme-pay?id=pl_xxx — status do link.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { assertAccountAccess } from '../lib/leona.js';
import { getPagarmePaymentLink, pagarmeConfigured } from '../lib/pagarme.js';
import { createPagarmeAssinaturaCheckout } from '../lib/pagarme-assinatura.js';
import { paymentLinkLooksPaid } from '../lib/trilha-fulfill.js';

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

  const { account_id, email, qty, amount, kind, name } = req.body || {};
  const accountId = account_id != null ? String(account_id).trim() : '';
  if (!accountId) return res.status(400).json({ error: 'account_id obrigatório' });

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
    profile: access.profile
  });

  if (!created.ok) {
    logAssinaturaEvent(req, {
      action: 'pagarme_pay_error',
      provider: 'pagarme',
      email: access.profileEmail || email,
      account_id: accountId,
      details: { qty, kind, error: created.error, status: created.status, body: created.body }
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
      payment_link_id: created.id
    }
  });

  return res.status(200).json({
    success: true,
    id: created.id,
    status: 'PENDING',
    kind: created.oneShot ? 'one_shot' : 'subscription',
    checkout_url: created.checkout_url,
    qty: created.qty,
    amount_cents: created.amountCents,
    offer_name: created.productName
  });
}
