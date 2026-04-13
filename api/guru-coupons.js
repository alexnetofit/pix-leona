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

  const { action, coupon_code, email } = req.body || {};
  const headers = GURU_HEADERS(guruToken);

  try {
    if (action === 'list') {
      const r = await fetch(`${GURU_BASE}/coupons?limit=50&is_active=1&has_transactions=0`, { headers });
      const data = await r.json();
      return res.status(200).json({ coupons: data });
    }

    if (action === 'get') {
      if (!coupon_code) return res.status(400).json({ error: 'coupon_code obrigatório' });
      const listRes = await fetch(`${GURU_BASE}/coupons?limit=100&is_active=1&has_transactions=0`, { headers });
      const listData = await listRes.json();
      const coupons = Array.isArray(listData.data) ? listData.data : [];
      const found = coupons.find(c => c.code === coupon_code);
      if (!found) return res.status(404).json({ error: 'Cupom não encontrado' });
      const detailRes = await fetch(`${GURU_BASE}/coupons/${found.id}`, { headers });
      const detail = await detailRes.json();
      return res.status(200).json({ coupon: detail });
    }

    if (action === 'create_all') {
      const results = [];
      for (let pct = 5; pct <= 95; pct += 5) {
        const code = `up-leona-${pct}`;
        const body = {
          code,
          discount_type: 'Percentage',
          discount_value: pct,
          valid_until: '2030-12-31',
          max_uses: 0,
          max_uses_per_customer: 0,
          max_subscription_cycles: 1,
          is_active: true
        };
        const r = await fetch(`${GURU_BASE}/coupons`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });
        const data = await r.json();
        results.push({ code, status: r.status, data });
      }
      return res.status(200).json({ results });
    }

    if (action === 'add_email') {
      if (!coupon_code || !email) {
        return res.status(400).json({ error: 'coupon_code e email são obrigatórios' });
      }

      const listRes = await fetch(`${GURU_BASE}/coupons?limit=100&is_active=1&has_transactions=0`, { headers });
      const listData = await listRes.json();
      const coupons = Array.isArray(listData.data) ? listData.data : [];
      const found = coupons.find(c => c.code === coupon_code);
      if (!found) return res.status(404).json({ error: `Cupom ${coupon_code} não encontrado` });

      const detailRes = await fetch(`${GURU_BASE}/coupons/${found.id}`, { headers });
      const detail = await detailRes.json();
      const couponData = detail.data || detail;

      const existingEmails = couponData.allowed_emails || couponData.emails || [];
      const emailLower = email.trim().toLowerCase();
      if (existingEmails.includes(emailLower)) {
        return res.status(200).json({ success: true, message: 'Email já está na lista', coupon_id: found.id });
      }

      const updatedEmails = [...existingEmails, emailLower];

      const patchBody = {
        validate_by: 'email',
        allowed_emails: updatedEmails,
        emails: updatedEmails
      };

      const patchRes = await fetch(`${GURU_BASE}/coupons/${found.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patchBody)
      });
      const patchData = await patchRes.json();

      return res.status(200).json({
        success: patchRes.ok,
        coupon_id: found.id,
        status: patchRes.status,
        response: patchData
      });
    }

    return res.status(400).json({ error: 'action inválida. Use: list, get, create_all, add_email' });

  } catch (error) {
    console.error('guru-coupons error:', error);
    return res.status(500).json({ error: error.message });
  }
}
