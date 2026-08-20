/**
 * POST /api/pagou-checkout
 * Devolve o checkout Leona (/pagar) pra /assinatura.
 */
import { applyCors } from '../lib/auth.js';
import { assertAccountAccess } from '../lib/leona.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { createPagouCheckoutLink, pagouConfigured } from '../lib/pagou.js';
import { leonaAmountCents, makeLeonaRef, reaisToCents } from '../lib/leona-pricing.js';
import { sbConfigured, sbInsert } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });
  if (!pagouConfigured()) return res.status(500).json({ error: 'PAGOU_SECRET_KEY não configurado' });

  const { account_id, email, qty, amount, offer_name, hosted } = req.body || {};
  const accountId = account_id != null ? String(account_id).trim() : '';
  const qtyN = Math.max(1, Number(qty) || 0);
  if (!accountId) return res.status(400).json({ error: 'account_id obrigatório' });
  if (!qtyN) return res.status(400).json({ error: 'qty obrigatória' });

  const access = await assertAccountAccess({
    accountId,
    queryEmail: email,
    leonaToken,
    route: '/api/pagou-checkout'
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const amountCents = reaisToCents(amount) || leonaAmountCents(qtyN);
  const title = makeLeonaRef(accountId, qtyN);
  const productName = offer_name || `Leona Flow — ${qtyN} conex${qtyN === 1 ? 'ão' : 'ões'}`;

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'client.leonaflow.com').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const params = new URLSearchParams({
    account_id: accountId,
    qty: String(qtyN),
    amount: String(amountCents / 100)
  });
  if (access.profileEmail || email) params.set('email', access.profileEmail || email);
  if (productName) params.set('offer', productName);
  let url = `${proto}://${host}/pagar?${params.toString()}`;

  if (hosted) {
    const created = await createPagouCheckoutLink({
      currency: 'BRL',
      title,
      products: [{
        external_id: `leona-starter-${qtyN}`,
        name: productName,
        price: amountCents,
        quantity: 1,
        type: 'digital',
        image_url: 'https://client.leonaflow.com/leona-finance-192.png'
      }]
    });
    const hostedUrl = created.body?.data?.url || created.body?.url || null;
    if (!created.ok || !hostedUrl) {
      return res.status(created.status || 502).json({
        error: created.body?.detail || created.body?.message || 'Pagou não gerou o checkout'
      });
    }
    url = hostedUrl;
  }

  if (sbConfigured()) {
    try {
      await sbInsert('pagou_checkout_intents', {
        account_id: accountId,
        email: access.profileEmail || email || null,
        qty: qtyN,
        amount_cents: amountCents,
        title,
        checkout_url: url,
        status: 'pending',
        details: { offer_name: productName }
      });
    } catch (err) {
      console.error('pagou-checkout: falha ao gravar intent', err.message);
    }
  }

  logAssinaturaEvent(req, {
    action: 'pagou_checkout_created',
    provider: 'pagou',
    email: access.profileEmail || email,
    account_id: accountId,
    details: { qty: qtyN, amount_cents: amountCents, title, url: String(url).slice(0, 220) }
  });

  return res.status(200).json({
    success: true,
    url,
    qty: qtyN,
    amount_cents: amountCents,
    offer_name: productName
  });
}
