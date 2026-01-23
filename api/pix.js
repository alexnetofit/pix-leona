/**
 * pix.js - Gera PIX QR Code via AbacatePay
 * 
 * Usa o endpoint /pixQrCode/create para gerar PIX direto com QR Code
 * 
 * Recebe: { "invoice_id": "in_xxx", "cpf": "12345678900", "customer_name": "...", "customer_email": "..." }
 * Retorna: Dados do PIX (QR Code, código copia e cola)
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
  const abacateKey = process.env.ABACATEPAY_KEY;

  if (!stripeSecret || !abacateKey) {
    return res.status(500).json({ error: 'Chaves de API não configuradas' });
  }

  const { invoice_id, cpf, customer_name, customer_email } = req.body || {};

  if (!invoice_id) {
    return res.status(400).json({ error: 'ID da fatura não informado' });
  }

  // Valida CPF
  const cpfClean = cpf ? cpf.replace(/\D/g, '') : '';
  if (cpfClean.length !== 11) {
    return res.status(400).json({ error: 'CPF inválido ou não informado' });
  }

  // Formata CPF (xxx.xxx.xxx-xx)
  const cpfFormatted = `${cpfClean.slice(0, 3)}.${cpfClean.slice(3, 6)}.${cpfClean.slice(6, 9)}-${cpfClean.slice(9, 11)}`;

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
   * Faz requisição para a API do AbacatePay
   */
  async function abacateRequest(endpoint, data) {
    const url = `https://api.abacatepay.com/v1/${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${abacateKey}`
      },
      body: JSON.stringify(data)
    });

    const responseData = await response.json();

    return {
      code: response.status,
      data: responseData
    };
  }

  try {
    // 1. Busca fatura na Stripe
    const invoiceResponse = await stripeRequest(`invoices/${encodeURIComponent(invoice_id)}`);

    if (invoiceResponse.code !== 200) {
      throw new Error('Fatura não encontrada na Stripe');
    }

    const invoice = invoiceResponse.data;

    // Verifica se a fatura está aberta
    if (invoice.status !== 'open') {
      throw new Error(`Esta fatura não está em aberto (status: ${invoice.status})`);
    }

    const amountCents = invoice.amount_due;
    const customerId = invoice.customer;

    // 2. Busca dados do cliente na Stripe (ou usa os enviados pelo front)
    let customerName = customer_name;
    let customerEmail = customer_email;
    let customerPhone = '11999999999';

    if (!customerName || !customerEmail) {
      const customerResponse = await stripeRequest(`customers/${encodeURIComponent(customerId)}`);
      if (customerResponse.code === 200) {
        const customer = customerResponse.data;
        customerName = customerName || customer.name || 'Cliente';
        customerEmail = customerEmail || customer.email || 'cliente@email.com';
        customerPhone = customer.phone || '11999999999';
      }
    }

    // Garante valores padrão
    customerName = customerName || 'Cliente';
    customerEmail = customerEmail || 'cliente@email.com';

    // Formata telefone
    const phoneClean = customerPhone.replace(/\D/g, '');
    let phoneFormatted = '(11) 99999-9999';
    if (phoneClean.length >= 10) {
      phoneFormatted = `(${phoneClean.slice(0, 2)}) ${phoneClean.slice(2, 7)}-${phoneClean.slice(7, 11)}`;
    }

    // 3. Cria PIX QR Code no AbacatePay
    const pixData = {
      amount: amountCents, // Em centavos
      expiresIn: 3600, // 1 hora para expirar
      description: `Fatura ${invoice_id}`,
      customer: {
        name: customerName,
        cellphone: phoneFormatted,
        email: customerEmail,
        taxId: cpfFormatted
      },
      metadata: {
        externalId: invoice_id
      }
    };

    const pixResponse = await abacateRequest('pixQrCode/create', pixData);

    if (pixResponse.code !== 200 && pixResponse.code !== 201) {
      let errorMsg = pixResponse.data?.error || pixResponse.data?.message || 'Erro desconhecido';
      if (typeof errorMsg === 'object') {
        errorMsg = JSON.stringify(errorMsg);
      }
      throw new Error(`Erro AbacatePay: ${errorMsg} (Code: ${pixResponse.code})`);
    }

    // 4. Extrai dados do PIX da resposta
    const pixResult = pixResponse.data?.data || pixResponse.data;

    // QR Code e código copia e cola
    const qrCodeImage = pixResult?.qrCode?.image || pixResult?.qrCodeImage || pixResult?.image || null;
    const pixCode = pixResult?.qrCode?.payload || pixResult?.brCode || pixResult?.payload || pixResult?.emv || null;
    const pixId = pixResult?.id || null;

    // Formata valor
    const amountFormatted = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(amountCents / 100);

    // Monta resposta
    return res.status(200).json({
      success: true,
      qr_code_url: qrCodeImage,
      pix_code: pixCode,
      pix_id: pixId,
      amount: amountCents,
      amount_formatted: amountFormatted,
      customer: {
        name: customerName,
        email: customerEmail,
        cpf: `${cpfClean.slice(0, 3)}.***.***-${cpfClean.slice(9, 11)}`
      },
      invoice_id: invoice_id,
      expires_in: 3600,
      raw_response: pixResult
    });

  } catch (error) {
    console.error('PIX error:', error);
    return res.status(500).json({ error: error.message });
  }
}
