/**
 * stripe.js - Busca cliente e TODAS as faturas na Stripe
 * 
 * Recebe: { "email": "cliente@exemplo.com" }
 * Retorna: { "customer": {...}, "subscriptions": [...] }
 */

export default async function handler(req, res) {
  // Headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Responde OPTIONS para CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const stripeSecret = process.env.STRIPE_SECRET;

  if (!stripeSecret) {
    return res.status(500).json({ error: 'Chave Stripe não configurada' });
  }

  const { email } = req.body || {};

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  /**
   * Faz requisição para a API da Stripe
   */
  async function stripeRequest(endpoint, method = 'GET', data = null) {
    const url = `https://api.stripe.com/v1/${endpoint}`;
    const auth = Buffer.from(`${stripeSecret}:`).toString('base64');

    const options = {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };

    if (method === 'POST' && data) {
      options.body = new URLSearchParams(data).toString();
    }

    const response = await fetch(url, options);
    const responseData = await response.json();

    return {
      code: response.status,
      data: responseData
    };
  }

  /**
   * Traduz status da fatura para português
   */
  function translateStatus(status) {
    const translations = {
      'draft': 'Rascunho',
      'open': 'Em Aberto',
      'paid': 'Paga',
      'uncollectible': 'Não Cobrável',
      'void': 'Cancelada'
    };
    return translations[status] || status;
  }

  /**
   * Retorna cor do status para o frontend
   */
  function getStatusColor(status) {
    const colors = {
      'draft': '#6c757d',
      'open': '#ffc107',
      'paid': '#00d4aa',
      'uncollectible': '#dc3545',
      'void': '#6c757d'
    };
    return colors[status] || '#6c757d';
  }

  try {
    // 0. Busca o produto disponível para criar assinatura
    const productResponse = await stripeRequest('products/prod_TfvzDiSiAGWTaP');
    const availableProduct = productResponse.code === 200 ? {
      id: 'prod_TfvzDiSiAGWTaP',
      name: productResponse.data.name,
      price_id: 'price_1Sia7qC7W0AK1mCaLqcjn0b9'
    } : null;

    // 1. Busca cliente pelo e-mail
    const customersResponse = await stripeRequest(
      `customers?email=${encodeURIComponent(normalizedEmail)}&limit=100`
    );

    if (customersResponse.code !== 200) {
      throw new Error('Erro ao buscar cliente na Stripe');
    }

    const customers = customersResponse.data.data || [];

    // Se cliente não existe, retorna com flag e produto disponível
    if (customers.length === 0) {
      return res.status(200).json({ 
        customer_exists: false,
        has_subscriptions: false,
        available_product: availableProduct,
        email: normalizedEmail
      });
    }

    const customer = customers[0];
    const customerId = customer.id;

    // 2. Busca TODAS as faturas do cliente
    const invoicesResponse = await stripeRequest(
      `invoices?customer=${encodeURIComponent(customerId)}&limit=100`
    );

    if (invoicesResponse.code !== 200) {
      throw new Error('Erro ao buscar faturas na Stripe');
    }

    const invoicesData = invoicesResponse.data.data || [];

    // 3. Busca assinaturas do cliente
    const subscriptionsResponse = await stripeRequest(
      `subscriptions?customer=${encodeURIComponent(customerId)}&limit=100&status=all`
    );

    const subscriptionsData = subscriptionsResponse.code === 200 
      ? (subscriptionsResponse.data.data || []) 
      : [];

    // Mapa de assinaturas
    const subscriptionsMap = {};

    for (const sub of subscriptionsData) {
      let productName = 'Assinatura';
      let unitAmount = 0;
      let subscriptionItemId = null;
      let currentQuantity = 1;

      // Busca os items da subscription diretamente
      const itemsResponse = await stripeRequest(`subscription_items?subscription=${sub.id}`);
      
      if (itemsResponse.code === 200 && itemsResponse.data.data?.length > 0) {
        const item = itemsResponse.data.data[0];
        subscriptionItemId = item.id;
        currentQuantity = item.quantity || 1;
        
        const priceId = item.price?.id;
        
        // Busca o preço para pegar o unit_amount
        if (priceId) {
          const priceResponse = await stripeRequest(`prices/${priceId}`);
          if (priceResponse.code === 200) {
            unitAmount = priceResponse.data.unit_amount || 0;
            
            // Busca o nome do produto
            if (priceResponse.data.product) {
              const productResponse = await stripeRequest(`products/${priceResponse.data.product}`);
              if (productResponse.code === 200) {
                productName = productResponse.data.name || productName;
              }
            }
          }
        }
      }
      
      subscriptionsMap[sub.id] = {
        id: sub.id,
        status: sub.status,
        product_name: productName,
        current_period_start: sub.current_period_start,
        current_period_end: sub.current_period_end,
        subscription_item_id: subscriptionItemId,
        current_quantity: currentQuantity,
        unit_amount: unitAmount,
        invoices: []
      };
    }

    // 4. Agrupa faturas por assinatura
    const invoicesWithoutSubscription = [];

    for (const invoice of invoicesData) {
      const invoiceFormatted = {
        invoice_id: invoice.id,
        amount_due: invoice.amount_due,
        amount_paid: invoice.amount_paid || 0,
        status: invoice.status,
        status_label: translateStatus(invoice.status),
        status_color: getStatusColor(invoice.status),
        customer_id: invoice.customer,
        subscription_id: invoice.subscription || null,
        description: invoice.description || 'Fatura Stripe',
        created: invoice.created,
        due_date: invoice.due_date || null,
        invoice_url: invoice.hosted_invoice_url || null,
        can_generate_pix: invoice.status === 'open',
        // Metadados do PIX AbacatePay
        abacate_pix_id: invoice.metadata?.abacate_pix_id || null,
        abacate_pix_created: invoice.metadata?.abacate_pix_created || null
      };

      const subscriptionId = invoice.subscription;

      if (subscriptionId && subscriptionsMap[subscriptionId]) {
        subscriptionsMap[subscriptionId].invoices.push(invoiceFormatted);
      } else {
        invoicesWithoutSubscription.push(invoiceFormatted);
      }
    }

    // 5. Monta resposta final
    // Inclui TODAS as assinaturas (mesmo sem faturas) para permitir upgrade/downgrade
    let subscriptions = Object.values(subscriptionsMap);
    
    // Filtra assinaturas ativas (para mostrar primeiro) e outras
    const activeSubscriptions = subscriptions.filter(s => 
      ['active', 'trialing', 'past_due'].includes(s.status)
    );
    const otherSubscriptions = subscriptions.filter(s => 
      !['active', 'trialing', 'past_due'].includes(s.status) && s.invoices.length > 0
    );
    
    // Reorganiza: ativas primeiro, depois outras com faturas
    subscriptions = [...activeSubscriptions, ...otherSubscriptions];

    // Adiciona grupo de faturas avulsas
    if (invoicesWithoutSubscription.length > 0) {
      subscriptions.push({
        id: 'no_subscription',
        status: 'active',
        product_name: 'Faturas Avulsas',
        current_period_end: null,
        invoices: invoicesWithoutSubscription
      });
    }

    // Ordena faturas dentro de cada assinatura (mais recentes primeiro)
    for (const sub of subscriptions) {
      sub.invoices.sort((a, b) => b.created - a.created);
    }

    // Conta totais
    const totalInvoices = invoicesData.length;
    const openInvoices = invoicesData.filter(i => i.status === 'open').length;
    
    // Verifica se tem assinaturas ativas
    const hasActiveSubscriptions = subscriptionsData.some(s => 
      ['active', 'trialing', 'past_due'].includes(s.status)
    );

    return res.status(200).json({
      customer_exists: true,
      has_subscriptions: hasActiveSubscriptions,
      available_product: hasActiveSubscriptions ? null : availableProduct,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name || null
      },
      subscriptions,
      totals: {
        total_invoices: totalInvoices,
        open_invoices: openInvoices
      }
    });

  } catch (error) {
    console.error('Stripe error:', error);
    return res.status(500).json({ error: error.message });
  }
}
