const PADDLE_BASE = 'https://api.paddle.com';

function paddleHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const paddleToken = process.env.PADDLE_API_KEY;
  if (!paddleToken) return res.status(500).json({ error: 'PADDLE_API_KEY não configurado' });

  const { action, subscription_id, items, proration_billing_mode } = req.body || {};
  const headers = paddleHeaders(paddleToken);

  try {
    if (action === 'preview') {
      if (!subscription_id || !items) {
        return res.status(400).json({ error: 'subscription_id e items são obrigatórios' });
      }

      const body = {
        items,
        proration_billing_mode: proration_billing_mode || 'prorated_immediately'
      };

      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/preview`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body)
      });

      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'update') {
      if (!subscription_id || !items) {
        return res.status(400).json({ error: 'subscription_id e items são obrigatórios' });
      }

      const body = {
        items,
        proration_billing_mode: proration_billing_mode || 'prorated_immediately'
      };

      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body)
      });

      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'get') {
      if (!subscription_id) {
        return res.status(400).json({ error: 'subscription_id é obrigatório' });
      }

      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}`, { headers });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'cancel') {
      if (!subscription_id) {
        return res.status(400).json({ error: 'subscription_id é obrigatório' });
      }

      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/cancel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ effective_from: 'next_billing_period' })
      });

      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    return res.status(400).json({ error: 'action inválida. Use: preview, update, get, cancel' });

  } catch (error) {
    console.error('paddle-subscription error:', error);
    return res.status(500).json({ error: error.message });
  }
}
