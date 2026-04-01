/**
 * abacatepay-search.js - Busca pagamentos na AbacatePay por email ou CPF
 *
 * Usa GET /v2/checkouts/list com filtro por email ou taxId.
 *
 * Recebe: { "search": "email@example.com" } ou { "search": "123.456.789-01" }
 * Retorna: Lista de checkouts filtrados, ordenados por data (mais recentes primeiro)
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

  const searchTerm = search.trim();
  const searchClean = searchTerm.replace(/\D/g, '');
  const isCpfSearch = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(searchTerm) || (searchClean.length === 11 && /^\d+$/.test(searchClean));

  try {
    // Monta a query com filtro direto por email ou taxId (API v2)
    const filterParam = isCpfSearch
      ? `taxId=${encodeURIComponent(searchTerm)}`
      : `email=${encodeURIComponent(searchTerm.toLowerCase())}`;

    const allCheckouts = [];
    let hasMore = true;
    let cursor = null;

    // Paginação por cursor para pegar todos os resultados
    while (hasMore) {
      const cursorParam = cursor ? `&after=${encodeURIComponent(cursor)}` : '';
      const url = `https://api.abacatepay.com/v2/checkouts/list?limit=100&${filterParam}${cursorParam}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${abacateKey}`
        }
      });

      const data = await response.json();

      if (response.status !== 200 || !data.data) {
        console.error('AbacatePay checkouts/list error:', response.status, JSON.stringify(data));
        break;
      }

      const items = Array.isArray(data.data) ? data.data : [];
      allCheckouts.push(...items);

      hasMore = data.pagination?.hasMore === true && data.pagination?.next;
      cursor = data.pagination?.next || null;
    }

    // Mapeia checkouts para o formato de resposta
    const payments = allCheckouts.map(checkout => ({
      id: checkout.id,
      type: 'checkout',
      type_label: 'Checkout',
      status: checkout.status || 'PENDING',
      amount: checkout.amount || 0,
      paid_amount: checkout.paidAmount || null,
      url: checkout.url || null,
      receipt_url: checkout.receiptUrl || null,
      items: checkout.items || [],
      customer_id: checkout.customerId || null,
      external_id: checkout.externalId || null,
      created_at: checkout.createdAt || null,
      updated_at: checkout.updatedAt || null,
      metadata: checkout.metadata || null,
      transaction_id: checkout.transactionId || null
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

    return res.status(200).json({
      success: true,
      search_term: searchTerm,
      search_type: isCpfSearch ? 'cpf' : 'email',
      summary,
      payments
    });

  } catch (error) {
    console.error('AbacatePay search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
