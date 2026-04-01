/**
 * abacatepay-search.js - Busca pagamentos na AbacatePay por email ou CPF
 *
 * Chama pixQrCode/list e billing/list em paralelo, filtra pelo email ou CPF informado.
 *
 * Recebe: { "search": "email@example.com" } ou { "search": "123.456.789-01" }
 * Retorna: Lista de pagamentos filtrados, ordenados por data (mais recentes primeiro)
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

  async function abacateGet(endpoint) {
    const url = `https://api.abacatepay.com/v1/${endpoint}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${abacateKey}`
      }
    });
    return {
      code: response.status,
      data: await response.json()
    };
  }

  function matchesCustomer(customer) {
    if (!customer) return false;
    const meta = customer.metadata || customer;

    if (isCpfSearch) {
      const taxId = (meta.taxId || '').replace(/\D/g, '');
      return taxId === searchClean;
    }

    const email = (meta.email || '').toLowerCase();
    return email === searchTerm;
  }

  try {
    const [pixResponse, billingResponse] = await Promise.all([
      abacateGet('pixQrCode/list'),
      abacateGet('billing/list')
    ]);

    const payments = [];

    if (pixResponse.code === 200 && pixResponse.data?.data) {
      const pixList = Array.isArray(pixResponse.data.data) ? pixResponse.data.data : [];
      for (const pix of pixList) {
        if (matchesCustomer(pix.customer)) {
          payments.push({
            id: pix.id,
            type: 'pix',
            type_label: 'PIX QR Code',
            status: pix.status || 'PENDING',
            amount: pix.amount || 0,
            description: pix.description || null,
            customer: pix.customer?.metadata || pix.customer || null,
            created_at: pix.createdAt || null,
            expires_at: pix.expiresAt || null,
            metadata: pix.metadata || null
          });
        }
      }
    }

    if (billingResponse.code === 200 && billingResponse.data?.data) {
      const billingList = Array.isArray(billingResponse.data.data) ? billingResponse.data.data : [];
      for (const bill of billingList) {
        if (matchesCustomer(bill.customer)) {
          const totalAmount = bill.amount || 0;
          payments.push({
            id: bill.id,
            type: 'billing',
            type_label: 'Cobrança',
            status: bill.status || 'PENDING',
            amount: totalAmount,
            url: bill.url || null,
            products: bill.products || [],
            customer: bill.customer?.metadata || bill.customer || null,
            created_at: bill.createdAt || null,
            frequency: bill.frequency || null,
            metadata: bill.metadata || null
          });
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

    return res.status(200).json({
      success: true,
      search_term: search.trim(),
      search_type: isCpfSearch ? 'cpf' : 'email',
      summary,
      payments
    });

  } catch (error) {
    console.error('AbacatePay search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
