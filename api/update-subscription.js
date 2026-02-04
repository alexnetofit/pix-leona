/**
 * update-subscription.js - Atualiza quantidade da assinatura (upgrade/downgrade)
 * 
 * Recebe: { 
 *   "subscription_id": "sub_xxx",
 *   "subscription_item_id": "si_xxx",
 *   "new_quantity": 5
 * }
 * 
 * Upgrade (aumentar): Gera fatura pro-rata automaticamente
 * Downgrade (reduzir): Apenas reduz, sem fatura
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

  const { subscription_id, subscription_item_id, new_quantity } = req.body || {};

  // Validações
  if (!subscription_id) {
    return res.status(400).json({ error: 'ID da assinatura não informado' });
  }

  if (!subscription_item_id) {
    return res.status(400).json({ error: 'ID do item da assinatura não informado' });
  }

  const qty = parseInt(new_quantity);
  if (!qty || qty < 1) {
    return res.status(400).json({ error: 'Quantidade deve ser pelo menos 1' });
  }

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
    // 1. Busca a assinatura atual para obter quantidade atual
    const subResponse = await stripeRequest(`subscriptions/${encodeURIComponent(subscription_id)}`);
    
    if (subResponse.code !== 200) {
      throw new Error('Assinatura não encontrada');
    }

    const subscription = subResponse.data;
    
    // Encontra o item da assinatura
    const currentItem = subscription.items?.data?.find(item => item.id === subscription_item_id);
    
    if (!currentItem) {
      throw new Error('Item da assinatura não encontrado');
    }

    const currentQuantity = currentItem.quantity || 1;

    // Se quantidade é a mesma, não faz nada
    if (qty === currentQuantity) {
      return res.status(200).json({
        success: true,
        message: 'Quantidade já está igual',
        current_quantity: currentQuantity,
        new_quantity: qty,
        changed: false
      });
    }

    // 2. Determina se é upgrade ou downgrade
    const isUpgrade = qty > currentQuantity;

    // 3. Atualiza o item da assinatura
    const updateData = {
      quantity: qty.toString()
    };

    // Upgrade: gera fatura pro-rata automaticamente
    // Downgrade: não gera fatura
    if (isUpgrade) {
      updateData.proration_behavior = 'always_invoice';
    } else {
      updateData.proration_behavior = 'none';
    }

    const updateResponse = await stripeRequest(
      `subscription_items/${encodeURIComponent(subscription_item_id)}`,
      'POST',
      updateData
    );

    if (updateResponse.code !== 200) {
      throw new Error(updateResponse.data?.error?.message || 'Erro ao atualizar assinatura');
    }

    // 4. Se foi upgrade, busca a fatura gerada
    let invoice = null;
    if (isUpgrade) {
      // Aguarda um pouco para a fatura ser criada
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Busca faturas recentes do cliente
      const invoicesResponse = await stripeRequest(
        `invoices?subscription=${encodeURIComponent(subscription_id)}&limit=1`
      );
      
      if (invoicesResponse.code === 200 && invoicesResponse.data?.data?.length > 0) {
        const latestInvoice = invoicesResponse.data.data[0];
        invoice = {
          id: latestInvoice.id,
          status: latestInvoice.status,
          amount_due: latestInvoice.amount_due,
          hosted_invoice_url: latestInvoice.hosted_invoice_url
        };
      }
    }

    return res.status(200).json({
      success: true,
      message: isUpgrade ? 'Upgrade realizado! Fatura pro-rata gerada.' : 'Downgrade realizado!',
      is_upgrade: isUpgrade,
      previous_quantity: currentQuantity,
      new_quantity: qty,
      changed: true,
      invoice: invoice
    });

  } catch (error) {
    console.error('Update subscription error:', error);
    return res.status(500).json({ error: error.message });
  }
}
