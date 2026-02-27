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

    // O preço pode ser unit_amount ou tiered (tiers)
    let unitAmount = priceResponse.data.unit_amount || 0;
    const currency = priceResponse.data.currency || 'brl';
    const pricingType = priceResponse.data.billing_scheme || 'per_unit';
    
    // Se for tiered, pega o primeiro tier
    if (pricingType === 'tiered' && priceResponse.data.tiers?.length > 0) {
      unitAmount = priceResponse.data.tiers[0].unit_amount || priceResponse.data.tiers[0].flat_amount || 0;
    }
    
    // Se ainda for 0, tenta pegar do item da subscription
    if (unitAmount === 0 && item.price?.unit_amount) {
      unitAmount = item.price.unit_amount;
    }

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

    // 6. USA A NOVA API INVOICES/CREATE_PREVIEW PARA SIMULAR PRO-RATA
    let proRataAmount = 0;
    let upcomingInvoiceLines = [];
    let upcomingDebug = null;
    let previewTotal = 0;
    let hasDiscount = false;
    let discountPercent = 0;
    
    // Usa POST /v1/invoices/create_preview (nova API da Stripe)
    const previewBody = new URLSearchParams();
    previewBody.append('customer', customerId);
    previewBody.append('subscription', subscription_id);
    previewBody.append('subscription_details[items][0][id]', subscriptionItemId);
    previewBody.append('subscription_details[items][0][quantity]', newQty.toString());
    previewBody.append('subscription_details[proration_behavior]', isUpgrade ? 'always_invoice' : 'none');
    
    const previewFetch = await fetch('https://api.stripe.com/v1/invoices/create_preview', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: previewBody.toString()
    });
    const previewData = await previewFetch.json();
    upcomingDebug = { code: previewFetch.status, data: previewData };
    
    if (previewFetch.status === 200) {
      // Total da fatura (pode ser negativo = crédito)
      previewTotal = previewData.total || 0;
      
      // amount_due é o que será cobrado (nunca negativo)
      proRataAmount = previewData.amount_due || 0;
      
      // Pega todas as linhas para mostrar detalhes
      upcomingInvoiceLines = (previewData.lines?.data || []).map(line => ({
        description: line.description,
        amount: line.amount,
        quantity: line.quantity,
        is_proration: line.parent?.subscription_item_details?.proration || false
      }));
      
      // Verifica se tem desconto
      if (previewData.discounts?.length > 0) {
        hasDiscount = true;
        // Extrai porcentagem do desconto da descrição se possível
        const descWithDiscount = upcomingInvoiceLines.find(l => l.description?.includes('% off'));
        if (descWithDiscount) {
          const match = descWithDiscount.description.match(/(\d+\.?\d*)% off/);
          if (match) discountPercent = parseFloat(match[1]);
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
        // Valores do preview da Stripe (fonte da verdade)
        preview_total: previewTotal,
        pro_rata_amount: proRataAmount,
        has_credit: previewTotal < 0,
        credit_amount: previewTotal < 0 ? Math.abs(previewTotal) : 0,
        has_discount: hasDiscount,
        discount_percent: discountPercent,
        // Detalhes das linhas
        proration_lines: upcomingInvoiceLines,
        // Faturas em aberto
        open_invoices_count: openInvoices.length,
        open_invoices: openInvoices.map(inv => ({
          id: inv.id,
          amount_due: inv.amount_due,
          status: inv.status
        }))
      },
      // DEBUG - remover depois
      debug: {
        subscription_response: {
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
          customer: customerId,
          status: subscription.status
        },
        item_response: {
          id: subscriptionItemId,
          quantity: currentQuantity,
          price_id: priceId,
          item_price_unit_amount: item.price?.unit_amount
        },
        price_response: {
          unit_amount: priceResponse.data?.unit_amount,
          billing_scheme: priceResponse.data?.billing_scheme,
          tiers: priceResponse.data?.tiers,
          currency: currency,
          product: priceResponse.data?.product,
          calculated_unit_amount: unitAmount
        },
        preview_response: upcomingDebug
      }
    });

  } catch (error) {
    console.error('Simulate upgrade error:', error);
    return res.status(500).json({ error: 'Erro ao simular alteração: ' + error.message });
  }
}
