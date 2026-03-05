/**
 * check.js - Verifica status do PIX no AbacatePay
 * 
 * Se pago, marca a fatura como paga na Stripe automaticamente
 * 
 * Recebe: { "invoice_id": "in_xxx", "pix_id": "pix_xxx" }
 * Retorna: { "paid": true/false, "status": "...", "invoice_updated": true/false }
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

  const { invoice_id, pix_id } = req.body || {};

  if (!invoice_id) {
    return res.status(400).json({ error: 'ID da fatura não informado' });
  }

  if (!pix_id) {
    return res.status(400).json({ error: 'ID do PIX não informado' });
  }

  /**
   * Faz requisição GET para a API do AbacatePay
   */
  async function abacateGet(endpoint) {
    const url = `https://api.abacatepay.com/v1/${endpoint}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${abacateKey}`
      }
    });

    const responseData = await response.json();

    return {
      code: response.status,
      data: responseData
    };
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
    let pixData = null;

    // 1. Consulta o status do PIX no AbacatePay
    // Endpoint correto: GET /pixQrCode/check?id=<pix_id>
    const pixResponse = await abacateGet(`pixQrCode/check?id=${encodeURIComponent(pix_id)}`);
    
    console.log('AbacatePay check response:', JSON.stringify(pixResponse));

    if (pixResponse.code === 200 && pixResponse.data) {
      pixData = pixResponse.data?.data || pixResponse.data;
    } else {
      // Fallback: tenta listar todos e encontrar pelo ID
      const listResponse = await abacateGet('pixQrCode/list');
      console.log('AbacatePay list response:', JSON.stringify(listResponse));

      let found = false;
      if (listResponse.code === 200 && listResponse.data?.data) {
        for (const pix of listResponse.data.data) {
          if (pix.id === pix_id) {
            pixData = pix;
            found = true;
            break;
          }
        }
      }

      if (!found) {
        throw new Error('PIX não encontrado no AbacatePay');
      }
    }

    // 2. Verifica o status do pagamento
    const status = pixData?.status || 'PENDING';
    const paidStatuses = ['PAID', 'COMPLETED', 'CONFIRMED', 'APPROVED', 'RECEIVED', 'SETTLED', 'SUCCESS'];
    const isPaid = paidStatuses.includes(status.toUpperCase());
    
    // Log para debug
    console.log('PIX Status:', status, 'isPaid:', isPaid, 'pixData:', JSON.stringify(pixData));

    const responseData = {
      paid: isPaid,
      status: status,
      invoice_updated: false,
      pix_data: pixData
    };

    // 3. Se pago, marca a fatura na Stripe
    if (isPaid) {
      // Primeiro verifica se a fatura ainda está aberta
      const invoiceResponse = await stripeRequest(`invoices/${encodeURIComponent(invoice_id)}`);

      if (invoiceResponse.code === 200) {
        const invoice = invoiceResponse.data;

        if (invoice.status === 'open') {
          // Marca como paga
          const payResponse = await stripeRequest(
            `invoices/${encodeURIComponent(invoice_id)}/pay`,
            'POST',
            { paid_out_of_band: 'true' }
          );

          if (payResponse.code === 200) {
            responseData.invoice_updated = true;
            responseData.stripe_status = 'paid';
          } else {
            // Fallback: fatura de Checkout bloqueia paid_out_of_band
            const payError = payResponse.data?.error?.message || '';
            if (payError.includes('Checkout')) {
              console.log(`Check: Fatura ${invoice_id} é de Checkout, convertendo...`);

              const lineItems = invoice.lines?.data || [];
              const firstItem = lineItems[0];
              const priceId = firstItem?.price?.id || 'price_1Sia7qC7W0AK1mCaLqcjn0b9';
              const qty = firstItem?.quantity || 1;
              const invCustomerId = invoice.customer;

              // Expira a sessão de Checkout
              const sessionsResp = await stripeRequest('checkout/sessions?limit=100');
              if (sessionsResp.code === 200) {
                const session = sessionsResp.data.data.find(s => s.invoice === invoice_id);
                if (session) {
                  await stripeRequest(`checkout/sessions/${encodeURIComponent(session.id)}/expire`, 'POST');
                }
              }

              // Cria nova assinatura com send_invoice
              const newSubResp = await stripeRequest('subscriptions', 'POST', {
                customer: invCustomerId,
                'items[0][price]': priceId,
                'items[0][quantity]': qty.toString(),
                'collection_method': 'send_invoice',
                'days_until_due': '7'
              });

              if (newSubResp.code === 200) {
                const newInvId = typeof newSubResp.data.latest_invoice === 'string'
                  ? newSubResp.data.latest_invoice
                  : newSubResp.data.latest_invoice?.id;

                // Finaliza se necessário
                const newInvResp = await stripeRequest(`invoices/${encodeURIComponent(newInvId)}`);
                if (newInvResp.code === 200 && newInvResp.data.status === 'draft') {
                  await stripeRequest(`invoices/${encodeURIComponent(newInvId)}/finalize`, 'POST');
                }

                // Salva o pix_id no metadata da nova fatura
                if (pix_id) {
                  await stripeRequest(`invoices/${encodeURIComponent(newInvId)}`, 'POST', {
                    'metadata[abacate_pix_id]': pix_id,
                    'metadata[abacate_pix_created]': new Date().toISOString()
                  });
                }

                // Marca como paga
                const newPayResp = await stripeRequest(
                  `invoices/${encodeURIComponent(newInvId)}/pay`, 'POST',
                  { paid_out_of_band: 'true' }
                );

                if (newPayResp.code === 200) {
                  responseData.invoice_updated = true;
                  responseData.stripe_status = 'paid';
                  responseData.converted_from_checkout = true;
                  responseData.new_invoice_id = newInvId;
                } else {
                  responseData.stripe_error = newPayResp.data?.error?.message || 'Erro ao pagar nova fatura';
                }
              } else {
                responseData.stripe_error = 'Erro ao recriar assinatura';
              }
            } else {
              responseData.stripe_error = payError || 'Erro ao atualizar fatura';
            }
          }
        } else if (invoice.status === 'paid') {
          // Já estava paga
          responseData.invoice_updated = true;
          responseData.stripe_status = 'already_paid';
        }
      }
    }

    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Check error:', error);
    return res.status(500).json({ error: error.message });
  }
}
