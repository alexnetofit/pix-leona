/**
 * webhook-abacatepay.js - Recebe notificações de pagamento PIX da AbacatePay
 * 
 * Quando um PIX é pago, a AbacatePay envia um POST para este endpoint.
 * O webhook busca a fatura na Stripe pelo metadata abacate_pix_id 
 * e marca como paga automaticamente.
 * 
 * Configurar no dashboard da AbacatePay:
 * - URL: https://seu-dominio.vercel.app/api/webhook-abacatepay
 * - Secret: mesmo valor de WEBHOOK_SECRET_ABACATE na Vercel
 */

export default async function handler(req, res) {
  // Apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const stripeSecret = process.env.STRIPE_SECRET;
  const webhookSecret = process.env.WEBHOOK_SECRET_ABACATE;

  if (!stripeSecret) {
    console.error('Webhook: STRIPE_SECRET não configurada');
    return res.status(500).json({ error: 'Configuração incompleta' });
  }

  // 1. Valida o secret da AbacatePay (via query string)
  if (webhookSecret) {
    const receivedSecret = req.query.webhookSecret;
    if (receivedSecret !== webhookSecret) {
      console.error('Webhook: Secret inválido recebido:', receivedSecret);
      return res.status(401).json({ error: 'Secret inválido' });
    }
  }

  try {
    const event = req.body;

    console.log('Webhook recebido:', JSON.stringify(event));

    // 2. Verifica se é um evento de pagamento
    if (event.event !== 'billing.paid') {
      console.log('Webhook: Evento ignorado:', event.event);
      return res.status(200).json({ received: true, ignored: true });
    }

    // 3. Extrai o pix_id do payload
    const pixId = event.data?.pixQrCode?.id || null;
    const pixStatus = event.data?.pixQrCode?.status || null;
    const paymentAmount = event.data?.payment?.amount || 0;

    if (!pixId) {
      console.error('Webhook: pix_id não encontrado no payload');
      return res.status(200).json({ received: true, error: 'pix_id não encontrado' });
    }

    console.log(`Webhook: PIX ${pixId} pago (status: ${pixStatus}, valor: ${paymentAmount})`);

    // 4. Busca a fatura na Stripe pelo metadata abacate_pix_id
    // Usa a Search API da Stripe
    async function stripeRequest(endpoint, method = 'GET', data = null) {
      const url = `https://api.stripe.com/v1/${endpoint}`;
      const options = {
        method,
        headers: {
          'Authorization': `Bearer ${stripeSecret}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      };

      if (method === 'POST' && data) {
        options.body = new URLSearchParams(data).toString();
      }

      const response = await fetch(url, options);
      const responseData = await response.json();
      return { code: response.status, data: responseData };
    }

    // Busca invoice pelo metadata usando Search API
    const searchQuery = `metadata["abacate_pix_id"]:"${pixId}"`;
    const searchUrl = `invoices/search?query=${encodeURIComponent(searchQuery)}`;
    const searchResponse = await stripeRequest(searchUrl);

    if (searchResponse.code !== 200 || !searchResponse.data?.data?.length) {
      console.log('Webhook: Nenhuma fatura encontrada para pix_id:', pixId);
      return res.status(200).json({ 
        received: true, 
        pix_id: pixId,
        invoice_found: false 
      });
    }

    const invoice = searchResponse.data.data[0];
    console.log(`Webhook: Fatura encontrada: ${invoice.id} (status: ${invoice.status})`);

    // 5. Se a fatura está aberta, marca como paga
    if (invoice.status === 'open') {
      const payResponse = await stripeRequest(
        `invoices/${encodeURIComponent(invoice.id)}/pay`,
        'POST',
        { paid_out_of_band: 'true' }
      );

      if (payResponse.code === 200) {
        console.log(`Webhook: Fatura ${invoice.id} marcada como paga!`);
        return res.status(200).json({
          received: true,
          pix_id: pixId,
          invoice_id: invoice.id,
          invoice_updated: true,
          new_status: 'paid'
        });
      } else {
        console.error('Webhook: Erro ao marcar fatura como paga:', payResponse.data?.error?.message);
        return res.status(200).json({
          received: true,
          pix_id: pixId,
          invoice_id: invoice.id,
          invoice_updated: false,
          error: payResponse.data?.error?.message
        });
      }
    } else if (invoice.status === 'paid') {
      console.log(`Webhook: Fatura ${invoice.id} já estava paga`);
      return res.status(200).json({
        received: true,
        pix_id: pixId,
        invoice_id: invoice.id,
        invoice_updated: false,
        already_paid: true
      });
    } else {
      console.log(`Webhook: Fatura ${invoice.id} com status ${invoice.status}, não é possível marcar como paga`);
      return res.status(200).json({
        received: true,
        pix_id: pixId,
        invoice_id: invoice.id,
        invoice_updated: false,
        current_status: invoice.status
      });
    }

  } catch (error) {
    console.error('Webhook error:', error);
    // Retorna 200 mesmo com erro para a AbacatePay não ficar reenviando
    return res.status(200).json({ received: true, error: error.message });
  }
}
