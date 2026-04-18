const GURU_BASE = 'https://digitalmanager.guru/api/v2';
const LEONA_BASE = 'https://apiaws.leonasolutions.io/api/v1/integration';

const GURU_HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'n8n'
});

const LEONA_HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json'
});

async function updateLeonaStarterInstances(accountId, starterInstances, leonaToken) {
  if (!accountId || !leonaToken) return { ok: false, error: 'sem account_id ou LEONA_TOKEN' };
  try {
    const r = await fetch(`${LEONA_BASE}/accounts/${accountId}/billing_profile`, {
      method: 'POST',
      headers: LEONA_HEADERS(leonaToken),
      body: JSON.stringify({ starter_instances: starterInstances })
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const guruToken = process.env.GURU_TOKEN;
  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });

  const { subscription_id, offer_id, sync_leona } = req.body || {};
  if (!subscription_id || !offer_id) {
    return res.status(400).json({ error: 'subscription_id e offer_id são obrigatórios' });
  }

  const headers = GURU_HEADERS(guruToken);

  try {
    const upgradeRes = await fetch(`${GURU_BASE}/subscriptions/${subscription_id}/plans`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ offer_id })
    });

    const upgradeData = await upgradeRes.json().catch(() => ({}));

    if (!upgradeRes.ok) {
      return res.status(upgradeRes.status).json({
        success: false,
        error: upgradeData.message || upgradeData.error || `Erro ${upgradeRes.status} ao alterar plano`,
        details: upgradeData
      });
    }

    const subRes = await fetch(
      `${GURU_BASE}/subscriptions/${subscription_id}`,
      { headers }
    );

    let invoice = null;
    let currentOfferId = null;
    if (subRes.ok) {
      const subData = await subRes.json();
      currentOfferId = subData.current_offer?.id || subData.offer?.id || null;
      const ci = subData.current_invoice;
      if (ci) {
        invoice = {
          id: ci.id,
          status: ci.status,
          value: ci.value,
          type: ci.type,
          cycle: ci.cycle,
          charge_at: ci.charge_at,
          period_start: ci.period_start,
          period_end: ci.period_end,
          payment_url: ci.payment_url || null
        };
      }
    }

    let leonaSync = null;
    if (sync_leona && sync_leona.account_id && Number.isFinite(Number(sync_leona.starter_instances))) {
      const leonaToken = process.env.LEONA_TOKEN;
      if (!leonaToken) {
        leonaSync = { ok: false, error: 'LEONA_TOKEN não configurado' };
      } else {
        const qty = Number(sync_leona.starter_instances);
        const result = await updateLeonaStarterInstances(sync_leona.account_id, qty, leonaToken);
        leonaSync = {
          ok: result.ok,
          account_id: sync_leona.account_id,
          starter_instances: qty,
          error: result.ok ? null : (result.body?.error || result.error || `HTTP ${result.status || '?'}`)
        };
      }
    }

    return res.status(200).json({
      success: true,
      subscription: upgradeData,
      invoice,
      current_offer_id: currentOfferId,
      leona_sync: leonaSync
    });

  } catch (error) {
    console.error('guru-upgrade error:', error);
    return res.status(500).json({ error: error.message });
  }
}
