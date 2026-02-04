/**
 * subscription.js - Cria customer e/ou assinatura na Stripe
 * 
 * Recebe: { 
 *   "email": "cliente@exemplo.com",
 *   "name": "Nome do Cliente",
 *   "quantity": 1,
 *   "customer_id": "cus_xxx" (opcional)
 * }
 * Retorna: { "success": true, "customer": {...}, "subscription": {...}, "invoice": {...} }
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

  const { email, name, quantity, customer_id } = req.body || {};

  // Validações
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }

  if (!customer_id && !name) {
    return res.status(400).json({ error: 'Nome é obrigatório para criar novo cliente' });
  }

  const qty = parseInt(quantity) || 1;
  if (qty < 1) {
    return res.status(400).json({ error: 'Quantidade deve ser pelo menos 1' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Produto e preço fixos
  const PRICE_ID = 'price_1Sia7qC7W0AK1mCaLqcjn0b9';

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

  try {
    let customerId = customer_id;
    let customerData = null;

    // 1. Se não tem customer_id, cria um novo customer
    if (!customerId) {
      const createCustomerResponse = await stripeRequest('customers', 'POST', {
        email: normalizedEmail,
        name: name
      });

      if (createCustomerResponse.code !== 200) {
        throw new Error(createCustomerResponse.data?.error?.message || 'Erro ao criar cliente');
      }

      customerId = createCustomerResponse.data.id;
      customerData = createCustomerResponse.data;
    } else {
      // Busca dados do customer existente
      const customerResponse = await stripeRequest(`customers/${encodeURIComponent(customerId)}`);
      if (customerResponse.code === 200) {
        customerData = customerResponse.data;
      }
    }

    // 2. Cria a assinatura (sem trial)
    const subscriptionData = {
      customer: customerId,
      'items[0][price]': PRICE_ID,
      'items[0][quantity]': qty.toString(),
      'collection_method': 'send_invoice',
      'days_until_due': '7'
    };

    const createSubResponse = await stripeRequest('subscriptions', 'POST', subscriptionData);

    if (createSubResponse.code !== 200) {
      throw new Error(createSubResponse.data?.error?.message || 'Erro ao criar assinatura');
    }

    const subscription = createSubResponse.data;

    // 3. Busca a fatura criada pela assinatura
    let invoice = null;
    if (subscription.latest_invoice) {
      const invoiceId = typeof subscription.latest_invoice === 'string' 
        ? subscription.latest_invoice 
        : subscription.latest_invoice.id;
      
      const invoiceResponse = await stripeRequest(`invoices/${encodeURIComponent(invoiceId)}`);
      if (invoiceResponse.code === 200) {
        invoice = invoiceResponse.data;
        
        // Finaliza a fatura se estiver em draft
        if (invoice.status === 'draft') {
          const finalizeResponse = await stripeRequest(
            `invoices/${encodeURIComponent(invoiceId)}/finalize`,
            'POST'
          );
          if (finalizeResponse.code === 200) {
            invoice = finalizeResponse.data;
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      customer: {
        id: customerId,
        email: customerData?.email || normalizedEmail,
        name: customerData?.name || name
      },
      subscription: {
        id: subscription.id,
        status: subscription.status
      },
      invoice: invoice ? {
        id: invoice.id,
        status: invoice.status,
        amount_due: invoice.amount_due,
        hosted_invoice_url: invoice.hosted_invoice_url
      } : null
    });

  } catch (error) {
    console.error('Subscription error:', error);
    return res.status(500).json({ error: error.message });
  }
}
