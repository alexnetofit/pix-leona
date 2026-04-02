/**
 * abacatepay-search.js - Busca pagamentos na AbacatePay por email ou CPF
 *
 * Usa:
 * - GET /v2/transparents/list  (PIX QR Codes / checkouts transparentes - pix_char_)
 * - GET /v2/checkouts/list     (checkouts normais - bill_)
 *
 * Filtra por email ou CPF buscando no JSON de cada item.
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

  async function fetchPaginated(basePath) {
    const all = [];
    let hasMore = true;
    let cursor = null;

    while (hasMore) {
      const sep = basePath.includes('?') ? '&' : '?';
      const cursorParam = cursor ? `${sep}after=${encodeURIComponent(cursor)}` : '';
      const url = `https://api.abacatepay.com/v2${basePath}${cursorParam}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${abacateKeyV2}`
        }
      });

      if (response.status !== 200) {
        const errData = await response.json().catch(() => ({}));
        console.error(`AbacatePay ${basePath}: ${response.status}`, errData.error || '');
        break;
      }

      const data = await response.json();
      const items = Array.isArray(data.data) ? data.data : [];
      all.push(...items);

      hasMore = data.pagination?.hasMore === true && data.pagination?.next;
      cursor = data.pagination?.next || null;
    }

    return all;
  }

  try {
    // Busca checkouts transparentes (pix_char_) e normais (bill_) em paralelo
    const emailFilter = isCpfSearch ? '' : `?email=${encodeURIComponent(searchTerm)}`;
    const taxIdFilter = isCpfSearch ? `?taxId=${encodeURIComponent(search.trim())}` : '';
    const checkoutFilter = isCpfSearch ? taxIdFilter : emailFilter;

    const [transparents, checkouts] = await Promise.all([
      fetchPaginated('/transparents/list?limit=100'),
      fetchPaginated(`/checkouts/list${checkoutFilter}&limit=100`)
    ]);

    console.log(`AbacatePay search: ${transparents.length} transparents, ${checkouts.length} checkouts`);

    // Filtra transparents por email/CPF no JSON (esse endpoint não tem filtro por email)
    const cpfFormatted = isCpfSearch
      ? `${searchClean.slice(0,3)}.${searchClean.slice(3,6)}.${searchClean.slice(6,9)}-${searchClean.slice(9)}`
      : null;

    function matchesSearch(item) {
      const json = JSON.stringify(item).toLowerCase();
      if (isCpfSearch) {
        return json.includes(searchClean) || json.includes(cpfFormatted);
      }
      return json.includes(searchTerm);
    }

    const payments = [];
    const seenIds = new Set();

    function addPayment(item, type, typeLabel) {
      if (seenIds.has(item.id)) return;
      seenIds.add(item.id);
      payments.push({
        id: item.id,
        type,
        type_label: typeLabel,
        status: item.status || 'PENDING',
        amount: item.amount || 0,
        paid_amount: item.paidAmount || null,
        url: item.url || null,
        receipt_url: item.receiptUrl || null,
        items: item.items || [],
        customer_id: item.customerId || null,
        customer: item.customer?.metadata || item.customer || null,
        external_id: item.externalId || null,
        created_at: item.createdAt || null,
        updated_at: item.updatedAt || null,
        metadata: item.metadata || null,
        transaction_id: item.transactionId || null,
        expires_at: item.expiresAt || null
      });
    }

    // Transparentes: filtrar no servidor
    for (const item of transparents) {
      if (matchesSearch(item)) {
        addPayment(item, 'pix', 'PIX Transparente');
      }
    }

    // Checkouts: já vem filtrado pela API (email/taxId)
    for (const item of checkouts) {
      addPayment(item, 'checkout', 'Checkout');
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
      payments,
      debug: {
        transparents_total: transparents.length,
        checkouts_total: checkouts.length
      }
    });

  } catch (error) {
    console.error('AbacatePay search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
