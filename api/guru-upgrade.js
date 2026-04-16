const GURU_BASE = 'https://digitalmanager.guru/api/v2';
const GURU_HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'n8n'
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const guruToken = process.env.GURU_TOKEN;
  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });

  const { subscription_id, offer_id } = req.body || {};
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
    if (subRes.ok) {
      const subData = await subRes.json();
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

    return res.status(200).json({
      success: true,
      subscription: upgradeData,
      invoice
    });

  } catch (error) {
    console.error('guru-upgrade error:', error);
    return res.status(500).json({ error: error.message });
  }
}
