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
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!paddleToken) return res.status(500).json({ error: 'PADDLE_API_KEY não configurado' });

  const { email } = req.body || {};
  if (!email || !email.trim()) return res.status(400).json({ error: 'Informe um e-mail' });

  const emailClean = email.trim().toLowerCase();
  const headers = paddleHeaders(paddleToken);

  try {
    const [customersRes, productsRes, leonaRes] = await Promise.all([
      fetch(`${PADDLE_BASE}/customers?email=${encodeURIComponent(emailClean)}`, { headers }),
      fetch(`${PADDLE_BASE}/products?include=prices&per_page=200&status=active`, { headers }),
      leonaToken
        ? fetch(`https://apiaws.leonasolutions.io/api/v1/integration/accounts/billing_profile?email=${encodeURIComponent(emailClean)}`, {
            headers: { 'Authorization': `Bearer ${leonaToken}`, 'Accept': 'application/json' }
          }).catch(e => ({ ok: false, _error: e.message }))
        : Promise.resolve(null)
    ]);

    // --- Paddle customers ---
    let paddle = { found: false, customer: null, subscriptions: [] };

    if (customersRes.ok) {
      const customersData = await customersRes.json();
      const customers = customersData.data || [];
      const customer = customers.find(c => c.email?.toLowerCase() === emailClean) || customers[0] || null;

      if (customer) {
        paddle.found = true;
        paddle.customer = {
          id: customer.id,
          email: customer.email,
          name: customer.name || null,
          status: customer.status
        };

        const subsRes = await fetch(`${PADDLE_BASE}/subscriptions?customer_id=${customer.id}&per_page=50`, { headers });
        if (subsRes.ok) {
          const subsData = await subsRes.json();
          const subs = subsData.data || [];

          paddle.subscriptions = await Promise.all(subs.map(async (s) => {
            let transactions = [];
            try {
              const txRes = await fetch(
                `${PADDLE_BASE}/transactions?subscription_id=${s.id}&per_page=20&order_by=billed_at[DESC]`,
                { headers }
              );
              if (txRes.ok) {
                const txData = await txRes.json();
                transactions = (txData.data || []).map(t => ({
                  id: t.id,
                  status: t.status,
                  origin: t.origin,
                  invoice_id: t.invoice_id,
                  invoice_number: t.invoice_number,
                  billed_at: t.billed_at,
                  created_at: t.created_at,
                  currency_code: t.currency_code,
                  total: t.details?.totals?.total || null,
                  grand_total: t.details?.totals?.grand_total || null,
                  fee: t.details?.totals?.fee || null,
                  earnings: t.details?.totals?.earnings || null,
                  collection_mode: t.collection_mode,
                  payments: (t.payments || []).map(p => ({
                    payment_method_id: p.payment_method_id,
                    status: p.status,
                    amount: p.amount,
                    method_details: p.method_details
                  })),
                  items_summary: (t.items || []).map(it => ({
                    item_id: it.id,
                    quantity: it.quantity,
                    price_name: it.price?.name || it.price?.description || null,
                    product_id: it.price?.product_id || null
                  }))
                }));
              }
            } catch (_) {}

            return {
              id: s.id,
              status: s.status,
              currency_code: s.currency_code,
              started_at: s.started_at,
              first_billed_at: s.first_billed_at,
              next_billed_at: s.next_billed_at,
              paused_at: s.paused_at,
              canceled_at: s.canceled_at,
              current_billing_period: s.current_billing_period,
              billing_cycle: s.billing_cycle,
              items: (s.items || []).map(item => ({
                price_id: item.price?.id,
                product_id: item.price?.product_id,
                product_name: item.product?.name || item.price?.description || null,
                quantity: item.quantity,
                unit_price: item.price?.unit_price,
                billing_cycle: item.price?.billing_cycle,
                status: item.status
              })),
              management_urls: s.management_urls || null,
              scheduled_change: s.scheduled_change || null,
              discount: s.discount || null,
              transactions
            };
          }));
        }
      }
    }

    // --- Paddle products ---
    let products = [];
    if (productsRes.ok) {
      const productsData = await productsRes.json();
      products = (productsData.data || []).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        prices: (p.prices || []).map(pr => ({
          id: pr.id,
          description: pr.description,
          unit_price: pr.unit_price,
          billing_cycle: pr.billing_cycle,
          trial_period: pr.trial_period,
          status: pr.status
        }))
      }));
    }

    // --- Leona (same logic as guru-search.js) ---
    let leona = { found: false, billing_profile: null, billing_profiles: null, error: null };
    if (leonaRes === null) {
      leona.error = 'LEONA_BILLING_TOKEN não configurado';
    } else if (leonaRes._error) {
      leona.error = leonaRes._error;
    } else if (leonaRes.ok) {
      const leonaBody = await leonaRes.json();
      leona = { found: true, billing_profile: leonaBody, billing_profiles: [leonaBody], error: null };
    } else if (leonaRes.status === 409) {
      const conflict = await leonaRes.json().catch(() => ({}));
      const ids = conflict.account_ids || [];
      if (ids.length > 0) {
        const profiles = await Promise.all(ids.map(async (accId) => {
          try {
            const r = await fetch(
              `https://apiaws.leonasolutions.io/api/v1/integration/accounts/${accId}/billing_profile`,
              { headers: { 'Authorization': `Bearer ${leonaToken}`, 'Accept': 'application/json' } }
            );
            if (r.ok) return await r.json();
          } catch (_) {}
          return null;
        }));
        const valid = profiles.filter(Boolean);
        leona = { found: valid.length > 0, billing_profile: valid[0] || null, billing_profiles: valid, error: null };
      } else {
        leona.error = 'Múltiplas contas encontradas mas sem IDs retornados';
      }
    }

    return res.status(200).json({ paddle, leona, products });

  } catch (error) {
    console.error('paddle-search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
