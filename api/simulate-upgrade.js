// API para simular upgrade/downgrade de assinatura
// Usa a API invoices/upcoming da Stripe para calcular valores exatos

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const stripeSecret = process.env.STRIPE_SECRET;

  if (!stripeSecret) {
    return res.status(500).json({ error: 'Stripe não configurado' });
  }

  try {
    const { subscription_id, new_quantity } = req.body;

    if (!subscription_id || !new_quantity) {
      return res.status(400).json({ error: 'subscription_id e new_quantity são obrigatórios' });
    }

    const newQty = parseInt(new_quantity);
    if (newQty < 1) {
      return res.status(400).json({ error: 'Quantidade deve ser pelo menos 1' });
    }

    // Função para fazer requisições à Stripe
    async function stripeRequest(endpoint, method = 'GET', params = null) {
      const options = {
        method,
        headers: {
          'Authorization': `Bearer ${stripeSecret}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      };

      let url = `https://api.stripe.com/v1/${endpoint}`;
      
      if (params) {
        const queryString = new URLSearchParams(params).toString();
        if (method === 'GET') {
          // GET: parâmetros vão na query string
          url += (endpoint.includes('?') ? '&' : '?') + queryString;
        } else {
          // POST/PUT/DELETE: parâmetros vão no body
          options.body = queryString;
        }
      }

      const response = await fetch(url, options);
      const data = await response.json();
      return { code: response.status, data };
    }

    // 1. Busca a subscription
    const subResponse = await stripeRequest(`subscriptions/${subscription_id}`);
    if (subResponse.code !== 200) {
      return res.status(404).json({ error: 'Assinatura não encontrada' });
    }

    const subscription = subResponse.data;
    const customerId = subscription.customer;
    const currentPeriodStart = subscription.current_period_start;
    const currentPeriodEnd = subscription.current_period_end;

    // 2. Busca os items da subscription
    const itemsResponse = await stripeRequest(`subscription_items?subscription=${subscription_id}`);
    if (itemsResponse.code !== 200 || !itemsResponse.data.data?.length) {
      return res.status(400).json({ error: 'Não foi possível obter os items da assinatura' });
    }

    const item = itemsResponse.data.data[0];
    const subscriptionItemId = item.id;
    const currentQuantity = item.quantity || 1;
    const priceId = item.price?.id;

    if (newQty === currentQuantity) {
      return res.status(400).json({ error: 'A nova quantidade é igual à atual' });
    }

    // 3. Busca o preço
    const priceResponse = await stripeRequest(`prices/${priceId}`);
    if (priceResponse.code !== 200) {
      return res.status(400).json({ error: 'Não foi possível obter o preço' });
    }

    const unitAmount = priceResponse.data.unit_amount || 0;
    const currency = priceResponse.data.currency || 'brl';

    // 4. Busca o nome do produto
    let productName = 'Assinatura';
    if (priceResponse.data.product) {
      const productResponse = await stripeRequest(`products/${priceResponse.data.product}`);
      if (productResponse.code === 200) {
        productName = productResponse.data.name || productName;
      }
    }

    // 5. Calcula valores básicos
    const isUpgrade = newQty > currentQuantity;
    const diff = Math.abs(newQty - currentQuantity);
    const currentMonthly = currentQuantity * unitAmount;
    const newMonthly = newQty * unitAmount;
    const monthlyDiff = newMonthly - currentMonthly;

    // Dias restantes no ciclo
    const now = Math.floor(Date.now() / 1000);
    const remainingSeconds = Math.max(0, currentPeriodEnd - now);
    const remainingDays = Math.ceil(remainingSeconds / 86400);

    // 6. USA A API INVOICES/UPCOMING PARA SIMULAR PRO-RATA EXATO
    let proRataAmount = 0;
    let upcomingInvoiceLines = [];
    
    if (isUpgrade) {
      // Simula a fatura pro-rata usando a API da Stripe
      const upcomingParams = {
        customer: customerId,
        subscription: subscription_id,
        [`subscription_items[0][id]`]: subscriptionItemId,
        [`subscription_items[0][quantity]`]: newQty.toString(),
        subscription_proration_behavior: 'always_invoice'
      };
      
      const upcomingResponse = await stripeRequest('invoices/upcoming', 'GET', upcomingParams);
      
      if (upcomingResponse.code === 200) {
        const upcomingInvoice = upcomingResponse.data;
        
        // Filtra apenas os itens de proration (créditos e débitos)
        upcomingInvoiceLines = (upcomingInvoice.lines?.data || []).filter(line => 
          line.proration === true
        );
        
        // Soma os valores de proration
        proRataAmount = upcomingInvoiceLines.reduce((sum, line) => sum + line.amount, 0);
        
        // Se não encontrou linhas de proration, usa o total da invoice menos o valor mensal
        if (proRataAmount === 0 && upcomingInvoice.amount_due > 0) {
          proRataAmount = upcomingInvoice.amount_due;
        }
      }
    }

    // 7. Verifica se tem faturas em aberto
    const invoicesResponse = await stripeRequest(
      `invoices?subscription=${subscription_id}&status=open&limit=10`
    );
    const openInvoices = invoicesResponse.code === 200 ? (invoicesResponse.data.data || []) : [];

    return res.status(200).json({
      success: true,
      simulation: {
        subscription_id,
        subscription_item_id: subscriptionItemId,
        product_name: productName,
        currency,
        current_quantity: currentQuantity,
        new_quantity: newQty,
        is_upgrade: isUpgrade,
        difference: diff,
        unit_amount: unitAmount,
        current_monthly: currentMonthly,
        new_monthly: newMonthly,
        monthly_difference: monthlyDiff,
        remaining_days: remainingDays,
        pro_rata_amount: proRataAmount,
        proration_lines: upcomingInvoiceLines.map(line => ({
          description: line.description,
          amount: line.amount
        })),
        open_invoices_count: openInvoices.length,
        open_invoices: openInvoices.map(inv => ({
          id: inv.id,
          amount_due: inv.amount_due,
          status: inv.status
        }))
      }
    });

  } catch (error) {
    console.error('Simulate upgrade error:', error);
    return res.status(500).json({ error: 'Erro ao simular alteração: ' + error.message });
  }
}
