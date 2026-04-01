/**
 * abacatepay-search.js - Busca pagamentos na AbacatePay por email ou CPF
 *
 * Testa múltiplos endpoints para encontrar os checkouts (pix_char_...).
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const abacateKey = process.env.ABACATEPAY_KEY;

  if (!abacateKey) {
    return res.status(500).json({ error: 'Chave de API do AbacatePay não configurada' });
  }

  const { search } = req.body || {};

  if (!search || !search.trim()) {
    return res.status(400).json({ error: 'Informe um email ou CPF para buscar' });
  }

  const searchTerm = search.trim().toLowerCase();
  const searchClean = searchTerm.replace(/\D/g, '');
  const isCpfSearch = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(search.trim()) || (searchClean.length === 11 && /^\d+$/.test(searchClean));

  async function apiFetch(url) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${abacateKey}`
        }
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 300) }; }
      return { code: response.status, data };
    } catch (err) {
      return { code: 0, data: null, error: err.message };
    }
  }

  try {
    const filterParam = isCpfSearch
      ? `taxId=${encodeURIComponent(search.trim())}`
      : `email=${encodeURIComponent(searchTerm)}`;

    // Testa todas as URLs possíveis em paralelo
    const urls = {
      v2_checkouts_filtered: `https://api.abacatepay.com/v2/checkouts/list?limit=100&${filterParam}`,
      v2_checkouts_all: `https://api.abacatepay.com/v2/checkouts/list?limit=100`,
      v1_checkouts_filtered: `https://api.abacatepay.com/v1/checkouts/list?limit=100&${filterParam}`,
      v1_checkouts_all: `https://api.abacatepay.com/v1/checkouts/list?limit=100`,
      v1_billing: `https://api.abacatepay.com/v1/billing/list`,
      v1_pix: `https://api.abacatepay.com/v1/pixQrCode/list`,
    };

    const results = {};
    const entries = Object.entries(urls);
    const responses = await Promise.all(entries.map(([, url]) => apiFetch(url)));
    entries.forEach(([key], i) => { results[key] = responses[i]; });

    // Log para Vercel
    for (const [key, r] of Object.entries(results)) {
      const count = Array.isArray(r.data?.data) ? r.data.data.length : 'N/A';
      console.log(`${key}: code=${r.code}, count=${count}, error=${r.data?.error || r.error || 'none'}`);
    }

    // Encontra a melhor fonte de dados (primeiro endpoint que retorna array de itens)
    const payments = [];
    const seenIds = new Set();

    function addPayment(item, source) {
      if (seenIds.has(item.id)) return;
      seenIds.add(item.id);
      payments.push({
        id: item.id,
        type: source,
        type_label: source === 'pix' ? 'PIX QR Code' : 'Checkout',
        status: item.status || 'PENDING',
        amount: item.amount || 0,
        paid_amount: item.paidAmount || null,
        url: item.url || null,
        receipt_url: item.receiptUrl || null,
        items: item.items || item.products || [],
        customer_id: item.customerId || null,
        external_id: item.externalId || null,
        created_at: item.createdAt || null,
        updated_at: item.updatedAt || null,
        metadata: item.metadata || null,
        transaction_id: item.transactionId || null
      });
    }

    // Prioridade: endpoints filtrados primeiro, depois sem filtro
    const priority = [
      'v2_checkouts_filtered', 'v1_checkouts_filtered',
      'v2_checkouts_all', 'v1_checkouts_all',
      'v1_billing', 'v1_pix'
    ];

    let usedSource = null;
    let showAll = false;

    // Tenta endpoints filtrados primeiro
    for (const key of ['v2_checkouts_filtered', 'v1_checkouts_filtered']) {
      const r = results[key];
      if (r.code === 200 && Array.isArray(r.data?.data) && r.data.data.length > 0) {
        for (const item of r.data.data) addPayment(item, 'checkout');
        usedSource = key;
        break;
      }
    }

    // Se não encontrou com filtro, tenta sem filtro e retorna tudo
    if (payments.length === 0) {
      showAll = true;
      for (const key of ['v2_checkouts_all', 'v1_checkouts_all', 'v1_billing', 'v1_pix']) {
        const r = results[key];
        if (r.code === 200 && Array.isArray(r.data?.data) && r.data.data.length > 0) {
          const type = key.includes('pix') ? 'pix' : (key.includes('billing') ? 'billing' : 'checkout');
          for (const item of r.data.data) addPayment(item, type);
          if (!usedSource) usedSource = key;
        }
      }
    }

    payments.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });

    const summary = {
      total: payments.length,
      paid: payments.filter(p => p.status === 'PAID').length,
      pending: payments.filter(p => p.status === 'PENDING').length,
      expired: payments.filter(p => p.status === 'EXPIRED').length,
      cancelled: payments.filter(p => p.status === 'CANCELLED').length,
      refunded: payments.filter(p => p.status === 'REFUNDED').length
    };

    // Monta debug com code e erro de cada endpoint
    const debug = {};
    for (const [key, r] of Object.entries(results)) {
      debug[key] = {
        code: r.code,
        count: Array.isArray(r.data?.data) ? r.data.data.length : null,
        error: r.data?.error || r.error || null
      };
    }

    return res.status(200).json({
      success: true,
      search_term: search.trim(),
      search_type: isCpfSearch ? 'cpf' : 'email',
      show_all: showAll,
      source: usedSource,
      summary,
      payments,
      debug
    });

  } catch (error) {
    console.error('AbacatePay search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
