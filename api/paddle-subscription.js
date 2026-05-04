import { findLeonaAccountByEmail, updateLeonaBillingProfile } from '../lib/leona.js';

const PADDLE_BASE = 'https://api.paddle.com';

function paddleHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

/**
 * Tenta resolver o email do customer da subscription, usado para localizar
 * a conta Leona quando o frontend não envia account_id explicitamente.
 */
async function fetchSubscriptionEmail(subscriptionId, paddleToken) {
  const headers = paddleHeaders(paddleToken);
  try {
    const subRes = await fetch(`${PADDLE_BASE}/subscriptions/${subscriptionId}`, { headers });
    if (!subRes.ok) return null;
    const subBody = await subRes.json();
    const customerId = subBody.data?.customer_id;
    if (!customerId) return null;

    const cusRes = await fetch(`${PADDLE_BASE}/customers/${customerId}`, { headers });
    if (!cusRes.ok) return null;
    const cusBody = await cusRes.json();
    return (cusBody.data?.email || '').toLowerCase().trim() || null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve o accountId Leona a partir de várias dicas: o caller pode mandar
 * um accountId direto, um email, ou nenhum dos dois (cai no lookup pelo
 * customer Paddle da subscription).
 */
async function resolveLeonaAccountId({ accountId, email, subscriptionId }, paddleToken, leonaToken) {
  if (accountId) return accountId;
  let useEmail = email;
  if (!useEmail && subscriptionId) {
    useEmail = await fetchSubscriptionEmail(subscriptionId, paddleToken);
  }
  if (!useEmail) return null;
  const match = await findLeonaAccountByEmail(useEmail, leonaToken);
  return match?.account_id || null;
}

/**
 * Soma a quantidade de instâncias dos itens da subscription.
 */
function sumInstances(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((acc, it) => acc + (Number(it.quantity) || 0), 0);
}

/**
 * Tabela de tiers da Leona Flow.
 *
 * Paddle Billing não tem tiered pricing nativo num price único, então a gente
 * mantém o unit_price em R$127 e aplica um non-catalog discount do tipo
 * `flat_per_seat` (centavos por seat) que renova junto com a subscription
 * (recur=true, sem teto). A tabela:
 *
 *   1    conexão  → R$127/ea (sem desconto)
 *   2-3  conexões → R$ 99/ea (desconto R$28 por seat)
 *   4+   conexões → R$ 79/ea (desconto R$48 por seat)
 *
 * Mudou regra de tier? Mexer aqui (preço unit_price em centavos):
 */
const TIER_BASE_UNIT_CENTS = 12700;
function tierUnitCents(qty) {
  const q = Number(qty) || 0;
  if (q >= 4) return 7900;
  if (q >= 2) return 9900;
  return TIER_BASE_UNIT_CENTS;
}
function tierDiscount(qty) {
  const q = Number(qty) || 0;
  if (q < 2) return null;
  const perSeatCents = TIER_BASE_UNIT_CENTS - tierUnitCents(q);
  if (perSeatCents <= 0) return null;
  // Currency_code do discount herda do currency_code da transaction
  // (já passamos 'BRL' no txBody). Paddle rejeita se vier explicitamente aqui.
  return {
    type: 'flat_per_seat',
    amount: String(perSeatCents),
    description: q >= 4
      ? 'Desconto por volume (4+ conexões)'
      : 'Desconto por volume (2-3 conexões)',
    recur: true,
    maximum_recurring_intervals: null
  };
}
function fmtBRL(centavos) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format((Number(centavos) || 0) / 100);
}
function buildTierSummary(qty) {
  const q = Number(qty) || 0;
  const unit = tierUnitCents(q);
  const total = unit * q;
  const baseTotal = TIER_BASE_UNIT_CENTS * q;
  const savings = baseTotal - total;
  return {
    quantity: q,
    unit_amount: String(unit),
    total_amount: String(total),
    base_unit_amount: String(TIER_BASE_UNIT_CENTS),
    base_total_amount: String(baseTotal),
    savings_amount: String(savings),
    formatted_unit: fmtBRL(unit),
    formatted_total: fmtBRL(total),
    formatted_base_unit: fmtBRL(TIER_BASE_UNIT_CENTS),
    formatted_savings: fmtBRL(savings),
    discount: tierDiscount(q)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const paddleToken = process.env.PADDLE_API_KEY;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!paddleToken) return res.status(500).json({ error: 'PADDLE_API_KEY não configurado' });

  const {
    action,
    subscription_id,
    items,
    proration_billing_mode,
    effective_from,
    transaction_id,
    refund_type,
    refund_reason,
    account_id,
    email,
    sync_leona = true,
    price_id,
    quantity,
    name
  } = req.body || {};

  const headers = paddleHeaders(paddleToken);

  try {
    // ----------------------------------------------------------------
    // pricing_preview — usado pelo simulador ao vivo na tela de renovação.
    // Recebe { price_id, quantity } e devolve totals já com tier aplicado.
    // ----------------------------------------------------------------
    if (action === 'pricing_preview') {
      if (!price_id || !quantity) {
        return res.status(400).json({ error: 'price_id e quantity são obrigatórios' });
      }
      const r = await fetch(`${PADDLE_BASE}/pricing-preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: [{ price_id, quantity: Number(quantity) }],
          currency_code: 'BRL',
          address: { country_code: 'BR' }
        })
      });
      const data = await r.json();
      if (r.ok) {
        // Augmenta com nosso tier (Paddle não tem tiered pricing nativo num price único)
        data.tier = buildTierSummary(Number(quantity));
      }
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    // ----------------------------------------------------------------
    // create_renewal_checkout — gera link de checkout hosted da Paddle.
    // Reaproveita customer existente quando possível, e injeta o
    // leona_account_id em custom_data para o webhook reativar a conta
    // certinha após o pagamento.
    // ----------------------------------------------------------------
    if (action === 'create_renewal_checkout') {
      if (!price_id || !quantity || !email) {
        return res.status(400).json({ error: 'price_id, quantity e email são obrigatórios' });
      }

      let customerId = null;
      try {
        const cusRes = await fetch(
          `${PADDLE_BASE}/customers?email=${encodeURIComponent(email)}`,
          { headers }
        );
        if (cusRes.ok) {
          const cusBody = await cusRes.json();
          const match = (cusBody.data || []).find(
            c => c.email?.toLowerCase() === email.toLowerCase()
          );
          customerId = match?.id || null;
        }
      } catch (_) {}

      const qtyInt = Number(quantity);
      const discount = tierDiscount(qtyInt);
      const unitCents = tierUnitCents(qtyInt);

      const txBody = {
        items: [{ price_id, quantity: qtyInt }],
        collection_mode: 'automatic',
        currency_code: 'BRL',
        custom_data: {
          leona_account_id: account_id != null ? String(account_id) : null,
          source: 'leona-renewal-page',
          quantity: qtyInt,
          tier_label: `${qtyInt} ${qtyInt === 1 ? 'conexão' : 'conexões'} (R$ ${(unitCents / 100).toFixed(2).replace('.', ',')}/ea)`
        },
        ...(discount ? { discount } : {}),
        ...(customerId
          ? { customer_id: customerId }
          : { customer: { email, ...(name ? { name } : {}) } })
      };

      const r = await fetch(`${PADDLE_BASE}/transactions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(txBody)
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      return res.status(200).json({
        checkout_url: data.data?.checkout?.url || null,
        transaction_id: data.data?.id || null,
        customer_id: data.data?.customer_id || null
      });
    }

    if (action === 'preview') {
      if (!subscription_id || !items) {
        return res.status(400).json({ error: 'subscription_id e items são obrigatórios' });
      }
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/preview`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          items,
          proration_billing_mode: proration_billing_mode || 'prorated_immediately'
        })
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'update') {
      if (!subscription_id || !items) {
        return res.status(400).json({ error: 'subscription_id e items são obrigatórios' });
      }
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          items,
          proration_billing_mode: proration_billing_mode || 'prorated_immediately'
        })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      let leonaSync = null;
      if (sync_leona && leonaToken) {
        const accId = await resolveLeonaAccountId(
          { accountId: account_id, email, subscriptionId: subscription_id },
          paddleToken,
          leonaToken
        );
        if (accId) {
          const subItems = data.data?.items || [];
          const newQty = sumInstances(subItems);
          const result = await updateLeonaBillingProfile(accId, {
            starter_instances: newQty,
            status: 'active'
          }, leonaToken);
          leonaSync = { account_id: accId, starter_instances: newQty, ok: result.ok, error: result.body?.error };
        } else {
          leonaSync = { ok: false, error: 'conta Leona não encontrada' };
        }
      }

      return res.status(200).json({ ...data, leona_sync: leonaSync });
    }

    if (action === 'get') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}`, { headers });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'cancel') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const eff = effective_from === 'immediately' ? 'immediately' : 'next_billing_period';
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/cancel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ effective_from: eff })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      let leonaSync = null;
      if (sync_leona && leonaToken && eff === 'immediately') {
        const accId = await resolveLeonaAccountId(
          { accountId: account_id, email, subscriptionId: subscription_id },
          paddleToken,
          leonaToken
        );
        if (accId) {
          const result = await updateLeonaBillingProfile(accId, {
            status: 'canceled',
            starter_instances: 0
          }, leonaToken);
          leonaSync = { account_id: accId, ok: result.ok, error: result.body?.error };
        }
      }

      return res.status(200).json({ ...data, leona_sync: leonaSync });
    }

    if (action === 'pause') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const eff = effective_from === 'immediately' ? 'immediately' : 'next_billing_period';
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/pause`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ effective_from: eff })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      let leonaSync = null;
      if (sync_leona && leonaToken && eff === 'immediately') {
        const accId = await resolveLeonaAccountId(
          { accountId: account_id, email, subscriptionId: subscription_id },
          paddleToken,
          leonaToken
        );
        if (accId) {
          const result = await updateLeonaBillingProfile(accId, {
            status: 'inactive'
          }, leonaToken);
          leonaSync = { account_id: accId, ok: result.ok, error: result.body?.error };
        }
      }

      return res.status(200).json({ ...data, leona_sync: leonaSync });
    }

    if (action === 'resume') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/resume`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ effective_from: 'immediately' })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      let leonaSync = null;
      if (sync_leona && leonaToken) {
        const accId = await resolveLeonaAccountId(
          { accountId: account_id, email, subscriptionId: subscription_id },
          paddleToken,
          leonaToken
        );
        if (accId) {
          const subItems = data.data?.items || [];
          const newQty = sumInstances(subItems);
          const result = await updateLeonaBillingProfile(accId, {
            status: 'active',
            ...(newQty > 0 ? { starter_instances: newQty } : {})
          }, leonaToken);
          leonaSync = { account_id: accId, ok: result.ok, error: result.body?.error };
        }
      }

      return res.status(200).json({ ...data, leona_sync: leonaSync });
    }

    if (action === 'list_transactions') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const r = await fetch(
        `${PADDLE_BASE}/transactions?subscription_id=${encodeURIComponent(subscription_id)}&per_page=50&order_by=billed_at[DESC]`,
        { headers }
      );
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'get_transaction') {
      if (!transaction_id) return res.status(400).json({ error: 'transaction_id é obrigatório' });
      const r = await fetch(
        `${PADDLE_BASE}/transactions/${transaction_id}?include=adjustments`,
        { headers }
      );
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'refund') {
      if (!transaction_id) return res.status(400).json({ error: 'transaction_id é obrigatório' });

      const txRes = await fetch(`${PADDLE_BASE}/transactions/${transaction_id}`, { headers });
      const txBody = await txRes.json();
      if (!txRes.ok) return res.status(txRes.status).json(txBody);

      const txItems = (txBody.data?.items || []).filter(it => it.id);
      if (txItems.length === 0) {
        return res.status(400).json({ error: 'Transação sem itens reembolsáveis' });
      }

      const itemsBody = txItems.map(it => ({
        item_id: it.id,
        type: refund_type === 'partial' ? 'partial' : 'full'
      }));

      const r = await fetch(`${PADDLE_BASE}/adjustments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'refund',
          transaction_id,
          reason: refund_reason || 'Reembolso solicitado pelo cliente',
          items: itemsBody
        })
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    return res.status(400).json({
      error: 'action inválida. Use: pricing_preview, create_renewal_checkout, preview, update, get, cancel, pause, resume, list_transactions, get_transaction, refund'
    });

  } catch (error) {
    console.error('paddle-subscription error:', error);
    return res.status(500).json({ error: error.message });
  }
}
