const GURU_BASE = 'https://digitalmanager.guru/api/v2';
const GURU_HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'n8n'
});

const LEONA_PRODUCT_ID = 'a1869b83-b28d-4257-a986-1df94558a152';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const guruToken = process.env.GURU_TOKEN;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });

  const { email } = req.body || {};
  if (!email || !email.trim()) return res.status(400).json({ error: 'Informe um e-mail' });

  const emailClean = email.trim().toLowerCase();
  const headers = GURU_HEADERS(guruToken);

  try {
    const [contactRes, offersRes, leonaRes] = await Promise.all([
      fetch(`${GURU_BASE}/contacts?email=${encodeURIComponent(emailClean)}&limit=20`, { headers }),
      fetch(`${GURU_BASE}/products/${LEONA_PRODUCT_ID}/offers?limit=50`, { headers }),
      leonaToken
        ? fetch(`https://apiaws.leonasolutions.io/api/v1/integration/accounts/billing_profile?email=${encodeURIComponent(emailClean)}`, {
            headers: { 'Authorization': `Bearer ${leonaToken}`, 'Accept': 'application/json' }
          }).catch(e => ({ ok: false, _error: e.message }))
        : Promise.resolve(null)
    ]);

    const contactData = contactRes.ok ? await contactRes.json() : { data: [] };
    const contacts = Array.isArray(contactData.data) ? contactData.data : [];
    const contact = contacts.find(c => c.email?.toLowerCase() === emailClean) || null;

    const offersData = offersRes.ok ? await offersRes.json() : { data: [] };
    const rawOffers = Array.isArray(offersData.data) ? offersData.data : [];
    const offers = rawOffers
      .filter(o => o.is_active)
      .map(o => ({
        id: o.id,
        name: o.name,
        value: o.value,
        currency: o.currency || 'BRL',
        checkout_url: o.checkout_url,
        payment_types: o.payment_types || [],
        plan: o.plan || null
      }))
      .sort((a, b) => a.value - b.value);

    let leona = { found: false, billing_profile: null, error: null };
    if (leonaRes === null) {
      leona.error = 'LEONA_BILLING_TOKEN não configurado';
    } else if (leonaRes._error) {
      leona.error = leonaRes._error;
    } else if (leonaRes.ok) {
      const leonaBody = await leonaRes.json();
      leona = { found: true, billing_profile: leonaBody, error: null };
    } else if (leonaRes.status === 409) {
      const conflict = await leonaRes.json().catch(() => ({}));
      leona = { found: false, billing_profile: null, error: 'Múltiplas contas encontradas', account_ids: conflict.account_ids };
    } else {
      leona = { found: false, billing_profile: null, error: null };
    }

    let guru = { found: false, contact: null, subscriptions: [], transactions: [] };

    if (contact) {
      guru.found = true;
      guru.contact = {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        doc: contact.doc,
        phone: contact.phone_number ? `+${contact.phone_local_code || '55'}${contact.phone_number}` : null
      };

      const subsRes = await fetch(
        `${GURU_BASE}/subscriptions?contact_id=${contact.id}&limit=50`,
        { headers }
      );

      if (subsRes.ok) {
        const subsData = await subsRes.json();
        guru.subscriptions = (Array.isArray(subsData.data) ? subsData.data : []).map(s => ({
          id: s.id,
          subscription_code: s.subscription_code,
          product_name: s.product?.name || '',
          product_group: s.product?.group?.name || '',
          status: s.last_status,
          status_at: s.last_status_at,
          payment_method: s.payment_method,
          charged_times: s.charged_times,
          cycle_start: s.cycle_start_date,
          cycle_end: s.cycle_end_date,
          next_cycle: s.next_cycle_at,
          started_at: s.started_at,
          cancelled_at: s.cancelled_at,
          trial_start: s.trial_started_at,
          trial_end: s.trial_finished_at,
          charged_every_days: s.charged_every_days
        }));

        if (guru.subscriptions.length > 0) {
          const txRes = await fetch(
            `${GURU_BASE}/transactions?contact_id=${contact.id}&limit=100`,
            { headers }
          );
          if (txRes.ok) {
            const txData = await txRes.json();
            guru.transactions = (Array.isArray(txData.data) ? txData.data : []).map(t => ({
              id: t.id,
              status: t.status,
              product_name: t.product?.name || '',
              offer_name: t.product?.offer?.name || '',
              subscription_id: t.subscription?.internal_id || null,
              subscription_code: t.subscription?.subscription_code || null,
              invoice: t.invoice ? {
                id: t.invoice.id,
                status: t.invoice.status,
                value: t.invoice.value,
                cycle: t.invoice.cycle,
                charge_at: t.invoice.charge_at,
                period_start: t.invoice.period_start,
                period_end: t.invoice.period_end
              } : null,
              payment: t.payment ? {
                method: t.payment.method,
                total: t.payment.total,
                net: t.payment.net,
                currency: t.payment.currency,
                installments: t.payment.installments?.qty || 1,
                card_brand: t.payment.credit_card?.brand || null,
                card_last4: t.payment.credit_card?.last_digits || null
              } : null,
              dates: t.dates ? {
                created_at: t.dates.created_at,
                confirmed_at: t.dates.confirmed_at,
                ordered_at: t.dates.ordered_at
              } : null
            }));
          }
        }
      }
    }

    return res.status(200).json({ guru, leona, offers });

  } catch (error) {
    console.error('guru-search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
