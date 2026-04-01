/**
 * abacatepay-search.js - Busca pagamentos na AbacatePay por email ou CPF
 *
 * Usa customer/list para encontrar o cliente, depois cruza com pixQrCode/list e billing/list.
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

  function normalizeCustomer(customer) {
    if (!customer) return null;
    const meta = customer.metadata || {};
    return {
      id: customer.id || null,
      name: meta.name || customer.name || null,
      email: (meta.email || customer.email || '').toLowerCase(),
      taxId: (meta.taxId || customer.taxId || '').replace(/\D/g, ''),
      cellphone: meta.cellphone || customer.cellphone || null
    };
  }

  function customerMatches(customer) {
    const norm = normalizeCustomer(customer);
    if (!norm) return false;

    if (isCpfSearch) {
      return norm.taxId === searchClean;
    }
    return norm.email === searchTerm;
  }

  try {
    const [customerResponse, pixResponse, billingResponse] = await Promise.all([
      abacateGet('customer/list'),
      abacateGet('pixQrCode/list'),
      abacateGet('billing/list')
    ]);

    // 1. Encontra IDs dos clientes que batem com a busca
    const matchingCustomerIds = new Set();
    let matchedCustomerData = null;

    if (customerResponse.code === 200 && customerResponse.data?.data) {
      const customers = Array.isArray(customerResponse.data.data) ? customerResponse.data.data : [];
      for (const cust of customers) {
        if (customerMatches(cust)) {
          matchingCustomerIds.add(cust.id);
          if (!matchedCustomerData) {
            matchedCustomerData = normalizeCustomer(cust);
          }
        }
      }
    }

    console.log(`AbacatePay search: term="${searchTerm}", type=${isCpfSearch ? 'cpf' : 'email'}, matching_customers=${matchingCustomerIds.size}`);

    const payments = [];

    // 2. Filtra PIX QR Codes
    if (pixResponse.code === 200 && pixResponse.data?.data) {
      const pixList = Array.isArray(pixResponse.data.data) ? pixResponse.data.data : [];
      if (pixList.length > 0) {
        console.log('PIX sample keys:', Object.keys(pixList[0]).join(', '));
      }
      for (const pix of pixList) {
        let matched = false;

        // Match por customer direto no PIX (se a API retornar)
        if (pix.customer && customerMatches(pix.customer)) {
          matched = true;
        }

        // Match por customerId
        if (!matched && pix.customerId && matchingCustomerIds.has(pix.customerId)) {
          matched = true;
        }

        // Match por customer.id
        if (!matched && pix.customer?.id && matchingCustomerIds.has(pix.customer.id)) {
          matched = true;
        }

        if (matched) {
          const custData = normalizeCustomer(pix.customer) || matchedCustomerData;
          payments.push({
            id: pix.id,
            type: 'pix',
            type_label: 'PIX QR Code',
            status: pix.status || 'PENDING',
            amount: pix.amount || 0,
            description: pix.description || null,
            customer: custData,
            created_at: pix.createdAt || null,
            expires_at: pix.expiresAt || null,
            metadata: pix.metadata || null
          });
        }
      }
    }

    // 3. Filtra Billings/Cobranças
    if (billingResponse.code === 200 && billingResponse.data?.data) {
      const billingList = Array.isArray(billingResponse.data.data) ? billingResponse.data.data : [];
      if (billingList.length > 0) {
        console.log('Billing sample keys:', Object.keys(billingList[0]).join(', '));
      }
      for (const bill of billingList) {
        let matched = false;

        if (bill.customer && customerMatches(bill.customer)) {
          matched = true;
        }

        if (!matched && bill.customerId && matchingCustomerIds.has(bill.customerId)) {
          matched = true;
        }

        if (!matched && bill.customer?.id && matchingCustomerIds.has(bill.customer.id)) {
          matched = true;
        }

        if (matched) {
          const custData = normalizeCustomer(bill.customer) || matchedCustomerData;
          payments.push({
            id: bill.id,
            type: 'billing',
            type_label: 'Cobrança',
            status: bill.status || 'PENDING',
            amount: bill.amount || bill.paidAmount || 0,
            url: bill.url || null,
            products: bill.products || [],
            customer: custData,
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
      customer_found: matchingCustomerIds.size > 0,
      customer: matchedCustomerData,
      summary,
      payments,
      debug: {
        customers_total: customerResponse.data?.data?.length || 0,
        pix_total: pixResponse.data?.data?.length || 0,
        billing_total: billingResponse.data?.data?.length || 0,
        matching_customer_ids: Array.from(matchingCustomerIds)
      }
    });

  } catch (error) {
    console.error('AbacatePay search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
