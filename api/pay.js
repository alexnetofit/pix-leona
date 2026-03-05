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

    if (payResponse.code === 200) {
      return res.status(200).json({
        success: true,
        invoice: {
          id: payResponse.data.id,
          status: payResponse.data.status,
          amount_paid: payResponse.data.amount_paid
        },
        message: 'Fatura marcada como paga com sucesso'
      });
    }

    // Fallback: fatura criada pelo Checkout (charge_automatically) bloqueia paid_out_of_band
    const errorMsg = payResponse.data?.error?.message || '';
    if (!errorMsg.includes('Checkout')) {
      throw new Error(errorMsg || 'Erro ao marcar fatura como paga');
    }

    console.log(`Pay: Fatura ${invoice_id} é de Checkout, convertendo...`);

    const lineItems = invoice.lines?.data || [];
    const firstItem = lineItems[0];
    const priceId = firstItem?.price?.id || 'price_1Sia7qC7W0AK1mCaLqcjn0b9';
    const qty = firstItem?.quantity || 1;
    const customerId = invoice.customer;

    // Busca e expira a sessão de Checkout
    const sessionsResponse = await stripeRequest('checkout/sessions?limit=100');
    if (sessionsResponse.code === 200) {
      const session = sessionsResponse.data.data.find(s => s.invoice === invoice_id);
      if (session) {
        await stripeRequest(`checkout/sessions/${encodeURIComponent(session.id)}/expire`, 'POST');
      }
    }

    // Cria nova assinatura com send_invoice
    const newSubResponse = await stripeRequest('subscriptions', 'POST', {
      customer: customerId,
      'items[0][price]': priceId,
      'items[0][quantity]': qty.toString(),
      'collection_method': 'send_invoice',
      'days_until_due': '7'
    });

    if (newSubResponse.code !== 200) {
      throw new Error('Erro ao recriar assinatura: ' + (newSubResponse.data?.error?.message || ''));
    }

    // Busca e finaliza a nova fatura
    const newInvoiceId = typeof newSubResponse.data.latest_invoice === 'string'
      ? newSubResponse.data.latest_invoice
      : newSubResponse.data.latest_invoice?.id;

    const newInvResponse = await stripeRequest(`invoices/${encodeURIComponent(newInvoiceId)}`);
    let newInvoice = newInvResponse.data;

    if (newInvResponse.code === 200 && newInvoice.status === 'draft') {
      const finalizeResponse = await stripeRequest(
        `invoices/${encodeURIComponent(newInvoiceId)}/finalize`, 'POST'
      );
      if (finalizeResponse.code === 200) {
        newInvoice = finalizeResponse.data;
      }
    }

    // Marca a nova fatura como paga
    const newPayResponse = await stripeRequest(
      `invoices/${encodeURIComponent(newInvoiceId)}/pay`, 'POST',
      { paid_out_of_band: 'true' }
    );

    if (newPayResponse.code !== 200) {
      throw new Error('Erro ao pagar nova fatura: ' + (newPayResponse.data?.error?.message || ''));
    }

    return res.status(200).json({
      success: true,
      converted_from_checkout: true,
      invoice: {
        id: newPayResponse.data.id,
        status: newPayResponse.data.status,
        amount_paid: newPayResponse.data.amount_paid
      },
      old_invoice_id: invoice_id,
      message: 'Fatura de Checkout convertida e marcada como paga'
    });

  } catch (error) {
    console.error('Pay error:', error);
    return res.status(500).json({ error: error.message });
  }
}
