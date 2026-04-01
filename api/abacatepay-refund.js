/**
 * abacatepay-refund.js - Reembolso via saque (withdraw) na AbacatePay
 *
 * Cria um saque para a chave PIX do cliente como forma de reembolso.
 *
 * Recebe: { "amount": 5000, "pix_key": "123.456.789-01", "pix_key_type": "CPF", "description": "...", "external_id": "..." }
 * Retorna: Dados do saque criado
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const abacateKey = process.env.ABACATEPAY_KEY;

  if (!abacateKey) {
    return res.status(500).json({ error: 'Chave de API do AbacatePay não configurada' });
  }

  const { amount, pix_key, pix_key_type, description, external_id } = req.body || {};

  if (!amount || amount < 350) {
    return res.status(400).json({ error: 'Valor mínimo para reembolso é R$ 3,50 (350 centavos)' });
  }

  if (!pix_key || !pix_key.trim()) {
    return res.status(400).json({ error: 'Chave PIX não informada' });
  }

  const validKeyTypes = ['CPF', 'CNPJ', 'PHONE', 'EMAIL', 'RANDOM', 'BR_CODE'];
  if (!pix_key_type || !validKeyTypes.includes(pix_key_type)) {
    return res.status(400).json({ error: `Tipo de chave PIX inválido. Use: ${validKeyTypes.join(', ')}` });
  }

  if (!external_id || !external_id.trim()) {
    return res.status(400).json({ error: 'ID externo não informado' });
  }

  try {
    const withdrawData = {
      externalId: external_id.trim(),
      method: 'PIX',
      amount: Math.round(amount),
      pix: {
        type: pix_key_type,
        key: pix_key.trim()
      }
    };

    if (description) {
      withdrawData.description = description.trim();
    }

    const response = await fetch('https://api.abacatepay.com/v1/withdraw/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${abacateKey}`
      },
      body: JSON.stringify(withdrawData)
    });

    const data = await response.json();

    if (response.status !== 200 && response.status !== 201) {
      const errorMsg = data?.error || data?.message || 'Erro desconhecido ao criar saque';
      return res.status(response.status || 500).json({
        error: typeof errorMsg === 'object' ? JSON.stringify(errorMsg) : errorMsg
      });
    }

    const transaction = data?.data || data;

    return res.status(200).json({
      success: true,
      transaction: {
        id: transaction.id,
        status: transaction.status,
        amount: transaction.amount,
        receipt_url: transaction.receiptUrl || null,
        created_at: transaction.createdAt || null
      }
    });

  } catch (error) {
    console.error('AbacatePay refund error:', error);
    return res.status(500).json({ error: error.message });
  }
}
