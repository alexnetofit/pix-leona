/**
 * abacatepay-search.js - Busca pagamentos na AbacatePay por email ou CPF
 *
 * Busca todos os checkouts (v2) sem filtro e filtra por email/CPF no servidor,
 * para capturar tanto checkouts normais (bill_) quanto transparentes (pix_char_).
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

  const abacateKeyV2 = process.env.ABACATEPAY_KEY_V2;

  if (!abacateKeyV2) {
    return res.status(500).json({ error: 'Chave de API v2 do AbacatePay não configurada (ABACATEPAY_KEY_V2)' });
  }

  const { search } = req.body || {};

  if (!search || !search.trim()) {
    return res.status(400).json({ error: 'Informe um email ou CPF para buscar' });
  }

  const searchTerm = search.trim().toLowerCase();
  const searchClean = searchTerm.replace(/\D/g, '');
  const isCpfSearch = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(search.trim()) || (searchClean.length === 11 && /^\d+$/.test(searchClean));

  async function fetchAllCheckouts() {
    const all = [];
    let hasMore = true;
    let cursor = null;

    while (hasMore) {
      const cursorParam = cursor ? `&after=${encodeURIComponent(cursor)}` : '';
      const url = `https://api.abacatepay.com/v2/checkouts/list?limit=100${cursorParam}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${abacateKeyV2}`
        }
      });

      const data = await response.json();

      if (response.status !== 200) {
        const errorMsg = data?.error || `Erro ${response.status}`;
        throw new Error(typeof errorMsg === 'object' ? JSON.stringify(errorMsg) : errorMsg);
      }

      const items = Array.isArray(data.data) ? data.data : [];
      all.push(...items);

      hasMore = data.pagination?.hasMore === true && data.pagination?.next;
      cursor = data.pagination?.next || null;
    }

    return all;
  }

  try {
    const allCheckouts = await fetchAllCheckouts();

    // Filtra por email ou CPF buscando em todo o JSON de cada item
    const cpfFormatted = isCpfSearch
      ? `${searchClean.slice(0,3)}.${searchClean.slice(3,6)}.${searchClean.slice(6,9)}-${searchClean.slice(9)}`
      : null;

    const filtered = allCheckouts.filter(item => {
      const json = JSON.stringify(item).toLowerCase();
      if (isCpfSearch) {
        return json.includes(searchClean) || json.includes(cpfFormatted);
      }
      return json.includes(searchTerm);
    });

    const payments = filtered.map(c => ({
      id: c.id,
      type: c.id?.startsWith('pix_char_') ? 'pix' : 'checkout',
      type_label: c.id?.startsWith('pix_char_') ? 'PIX Transparente' : 'Checkout',
      status: c.status || 'PENDING',
      amount: c.amount || 0,
      paid_amount: c.paidAmount || null,
      url: c.url || null,
      receipt_url: c.receiptUrl || null,
      items: c.items || [],
      customer_id: c.customerId || null,
      external_id: c.externalId || null,
      created_at: c.createdAt || null,
      updated_at: c.updatedAt || null,
      metadata: c.metadata || null,
      transaction_id: c.transactionId || null
    }));

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

    // Debug: conta tipos de IDs no total
    const idPrefixes = {};
    for (const c of allCheckouts) {
      const prefix = (c.id || '').split('_').slice(0, -1).join('_') || 'unknown';
      idPrefixes[prefix] = (idPrefixes[prefix] || 0) + 1;
    }

    return res.status(200).json({
      success: true,
      search_term: search.trim(),
      search_type: isCpfSearch ? 'cpf' : 'email',
      summary,
      payments,
      debug: {
        total_checkouts: allCheckouts.length,
        id_prefixes: idPrefixes
      }
    });

  } catch (error) {
    console.error('AbacatePay search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
