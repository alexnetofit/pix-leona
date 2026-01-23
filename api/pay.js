/**
 * pay.js - Marca fatura como paga na Stripe (paid_out_of_band)
 * 
 * Recebe: { "invoice_id": "in_xxx" }
 * Retorna: Dados da fatura atualizada
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

  const { invoice_id } = req.body || {};

  if (!invoice_id) {
    return res.status(400).json({ error: 'ID da fatura não informado' });
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
    // 1. Verifica se a fatura existe e está aberta
    const invoiceResponse = await stripeRequest(`invoices/${encodeURIComponent(invoice_id)}`);

    if (invoiceResponse.code !== 200) {
      throw new Error('Fatura não encontrada');
    }

    const invoice = invoiceResponse.data;

    if (invoice.status !== 'open') {
      throw new Error(`Esta fatura não está em aberto (status: ${invoice.status})`);
    }

    // 2. Marca a fatura como paga (paid_out_of_band)
    const payResponse = await stripeRequest(
      `invoices/${encodeURIComponent(invoice_id)}/pay`,
      'POST',
      { paid_out_of_band: 'true' }
    );

    if (payResponse.code !== 200) {
      const errorMsg = payResponse.data?.error?.message || 'Erro ao marcar fatura como paga';
      throw new Error(errorMsg);
    }

    // Retorna sucesso
    return res.status(200).json({
      success: true,
      invoice: {
        id: payResponse.data.id,
        status: payResponse.data.status,
        amount_paid: payResponse.data.amount_paid
      },
      message: 'Fatura marcada como paga com sucesso'
    });

  } catch (error) {
    console.error('Pay error:', error);
    return res.status(500).json({ error: error.message });
  }
}
