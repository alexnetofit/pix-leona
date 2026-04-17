const PADDLE_BASE = 'https://api.paddle.com';
const LEONA_BASE = 'https://apiaws.leonasolutions.io/api/v1/integration';

function paddleHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

function leonaHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

/**
 * Procura uma conta Leona pelo email. Devolve { account_id, profile } ou null.
 * Usa a mesma lógica de unicidade do webhook-guru: se houver conflito (409),
 * só sincroniza se uma única conta for encontrada e estiver ativa.
 */
async function findLeonaAccountByEmail(email, leonaToken) {
  if (!email || !leonaToken) return null;
  const headers = leonaHeaders(leonaToken);

  try {
    const r = await fetch(
      `${LEONA_BASE}/accounts/billing_profile?email=${encodeURIComponent(email.trim().toLowerCase())}`,
      { headers }
    );

    if (r.ok) {
      const profile = await r.json();
      return { account_id: profile.account_id, profile };
    }

    if (r.status === 409) {
      const conflict = await r.json().catch(() => ({}));
      const ids = Array.isArray(conflict.account_ids) ? conflict.account_ids : [];
      if (ids.length === 0) return null;

      const profiles = await Promise.all(ids.map(async (id) => {
        try {
          const pr = await fetch(`${LEONA_BASE}/accounts/${id}/billing_profile`, { headers });
          if (pr.ok) return await pr.json();
        } catch (_) {}
        return null;
      }));

      const valid = profiles.filter(Boolean);
      const active = valid.filter(p =>
        p.subscription_status === 'active' &&
        p.current_period_end &&
        new Date(p.current_period_end) > new Date()
      );

      if (active.length === 1) return { account_id: active[0].account_id, profile: active[0] };
      return null;
    }
  } catch (e) {
    console.error('paddle-subscription: erro ao buscar Leona:', e.message);
  }
  return null;
}

/**
 * Atualiza o billing_profile no Leona. Aceita campos parciais.
 * Retorna { ok, body } da resposta da Leona.
 */
async function updateLeonaBillingProfile(accountId, payload, leonaToken) {
  if (!accountId || !leonaToken) return { ok: false, error: 'sem accountId/token' };

  const headers = leonaHeaders(leonaToken);
  try {
    const r = await fetch(`${LEONA_BASE}/accounts/${accountId}/billing_profile`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
    sync_leona = true
  } = req.body || {};

  const headers = paddleHeaders(paddleToken);

  try {
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
      error: 'action inválida. Use: preview, update, get, cancel, pause, resume, list_transactions, get_transaction, refund'
    });

  } catch (error) {
    console.error('paddle-subscription error:', error);
    return res.status(500).json({ error: error.message });
  }
}
