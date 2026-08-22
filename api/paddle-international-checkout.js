/**
 * POST /api/paddle-international-checkout
 * Checkout recorrente Paddle pra cliente de fora do Brasil (sem CPF).
 */
import { applyCors } from '../lib/auth.js';
import { assertAccountAccess } from '../lib/leona.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import {
  buildPaddleInternationalTransaction,
  findStarterPriceId,
  paddleInternationalReady
} from '../lib/geo-billing.js';
import {
  createCustomer,
  createTransaction,
  listCustomersByEmail,
  listProducts
} from '../lib/paddle-client.js';

function ensurePaddleEnv() {
  if (!process.env.PADDLE_ENVIRONMENT) process.env.PADDLE_ENVIRONMENT = 'production';
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  if (!paddleInternationalReady()) {
    return res.status(503).json({
      error: 'Pagamento internacional indisponível. Fale com o suporte.',
      code: 'PADDLE_NOT_CONFIGURED'
    });
  }

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'Configuração incompleta' });

  const { account_id, email, qty, name } = req.body || {};
  const accountId = account_id != null ? String(account_id).trim() : '';
  const qtyN = Math.max(1, Number(qty) || 0);
  if (!accountId) return res.status(400).json({ error: 'account_id obrigatório' });
  if (!qtyN) return res.status(400).json({ error: 'qty obrigatória' });

  const access = await assertAccountAccess({
    accountId,
    queryEmail: email,
    leonaToken,
    route: '/api/paddle-international-checkout'
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const buyerEmail = access.profileEmail || String(email || '').trim().toLowerCase();
  const buyerName = String(name || access.profile?.user?.name || '').trim() || null;

  try {
    ensurePaddleEnv();
    const products = await listProducts();
    const priceId = findStarterPriceId(products, process.env.PADDLE_STARTER_PRICE_ID);
    if (!priceId) {
      return res.status(503).json({
        error: 'Plano Starter não encontrado na Paddle.',
        code: 'STARTER_PRICE_MISSING'
      });
    }

    const existing = await listCustomersByEmail(buyerEmail);
    const customer = existing[0] || await createCustomer({
      email: buyerEmail,
      name: buyerName,
      customData: { leona_account_id: accountId }
    });

    const origin = String(req.headers?.origin || 'https://client.leonaflow.com').replace(/\/+$/, '');
    const transaction = await createTransaction(buildPaddleInternationalTransaction({
      accountId,
      qty: qtyN,
      customerId: customer.id,
      priceId,
      checkoutUrl: `${origin}/checkout`
    }));

    const qs = new URLSearchParams();
    qs.set('_ptxn', transaction.id);
    qs.set('aid', accountId);
    if (customer.id) qs.set('cid', customer.id);
    const checkoutUrl = `${origin}/checkout?${qs.toString()}`;

    logAssinaturaEvent(req, {
      action: 'paddle_international_checkout',
      provider: 'paddle',
      email: buyerEmail,
      account_id: accountId,
      details: {
        qty: qtyN,
        customer_id: customer.id,
        transaction_id: transaction.id,
        price_id: priceId
      }
    });

    return res.status(200).json({
      checkout_url: checkoutUrl,
      transaction_id: transaction.id,
      customer_id: customer.id,
      account_id: accountId,
      qty: qtyN
    });
  } catch (err) {
    console.error('paddle-international-checkout:', err.message, err.body || '');
    logAssinaturaEvent(req, {
      action: 'paddle_international_error',
      provider: 'paddle',
      email: buyerEmail,
      account_id: accountId,
      details: { error: err.message, qty: qtyN }
    });
    return res.status(err.status && err.status < 500 ? err.status : 502).json({
      error: err.message || 'Falha ao abrir o checkout internacional'
    });
  }
}
