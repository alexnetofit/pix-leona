/**
 * abacatepay-search.js - Busca pagamentos na AbacatePay por email ou CPF
 *
 * Tenta múltiplas APIs (v2 checkouts, v1 billing, v1 pixQrCode) para encontrar pagamentos.
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
      const data = await response.json();
      return { code: response.status, data };
    } catch (err) {
      return { code: 0, error: err.message };
    }
  }

  function matchesSearch(obj) {
    if (!obj) return false;
    const str = JSON.stringify(obj).toLowerCase();

    if (isCpfSearch) {
      const cpfFormatted = `${searchClean.slice(0,3)}.${searchClean.slice(3,6)}.${searchClean.slice(6,9)}-${searchClean.slice(9)}`;
      return str.includes(searchClean) || str.includes(cpfFormatted);
    }
    return str.includes(searchTerm);
  }

  try {
    // Chama todas as APIs em paralelo
    const filterParam = isCpfSearch
      ? `taxId=${encodeURIComponent(search.trim())}`
      : `email=${encodeURIComponent(searchTerm)}`;

    const [v2Filtered, v2All, v1Billing, v1Pix] = await Promise.all([
      apiFetch(`https://api.abacatepay.com/v2/checkouts/list?limit=100&${filterParam}`),
      apiFetch(`https://api.abacatepay.com/v2/checkouts/list?limit=100`),
      apiFetch(`https://api.abacatepay.com/v1/billing/list`),
      apiFetch(`https://api.abacatepay.com/v1/pixQrCode/list`)
    ]);

    console.log(`Search: "${searchTerm}" | v2Filtered: ${v2Filtered.code} (${v2Filtered.data?.data?.length ?? 'null'}) | v2All: ${v2All.code} (${v2All.data?.data?.length ?? 'null'}) | v1Billing: ${v1Billing.code} (${v1Billing.data?.data?.length ?? 'null'}) | v1Pix: ${v1Pix.code} (${v1Pix.data?.data?.length ?? 'null'})`);

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

    // 1. v2 com filtro
    if (v2Filtered.code === 200 && Array.isArray(v2Filtered.data?.data)) {
      for (const item of v2Filtered.data.data) {
        addPayment(item, 'checkout');
      }
    }

    // 2. v2 sem filtro + busca por texto
    if (v2All.code === 200 && Array.isArray(v2All.data?.data)) {
      for (const item of v2All.data.data) {
        if (matchesSearch(item)) {
          addPayment(item, 'checkout');
        }
      }
    }

    // 3. v1 billing + busca por texto
    if (v1Billing.code === 200 && Array.isArray(v1Billing.data?.data)) {
      for (const item of v1Billing.data.data) {
        if (matchesSearch(item)) {
          addPayment(item, 'billing');
        }
      }
    }

    // 4. v1 pixQrCode + busca por texto
    if (v1Pix.code === 200 && Array.isArray(v1Pix.data?.data)) {
      for (const item of v1Pix.data.data) {
        if (matchesSearch(item)) {
          addPayment(item, 'pix');
        }
      }
    }

    // Se não encontrou nada com filtro, retorna TODOS os billings para o usuário navegar
    let showAll = false;
    if (payments.length === 0) {
      showAll = true;
      const allSources = [];

      if (v2All.code === 200 && Array.isArray(v2All.data?.data)) {
        for (const item of v2All.data.data) addPayment(item, 'checkout');
      }
      if (v1Billing.code === 200 && Array.isArray(v1Billing.data?.data)) {
        for (const item of v1Billing.data.data) addPayment(item, 'billing');
      }
      if (v1Pix.code === 200 && Array.isArray(v1Pix.data?.data)) {
        for (const item of v1Pix.data.data) addPayment(item, 'pix');
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

    return res.status(200).json({
      success: true,
      search_term: search.trim(),
      search_type: isCpfSearch ? 'cpf' : 'email',
      show_all: showAll,
      summary,
      payments,
      debug: {
        v2_filtered: { code: v2Filtered.code, count: v2Filtered.data?.data?.length ?? null, error: v2Filtered.data?.error || v2Filtered.error || null },
        v2_all: { code: v2All.code, count: v2All.data?.data?.length ?? null, error: v2All.data?.error || v2All.error || null },
        v1_billing: { code: v1Billing.code, count: v1Billing.data?.data?.length ?? null, error: v1Billing.data?.error || v1Billing.error || null },
        v1_pix: { code: v1Pix.code, count: v1Pix.data?.data?.length ?? null, error: v1Pix.data?.error || v1Pix.error || null }
      }
    });

  } catch (error) {
    console.error('AbacatePay search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
