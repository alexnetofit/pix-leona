/**
 * Avisa o painel de afiliados quando a Pagou confirma (ou estorna) um pagamento.
 * Reusa o webhook Guru já em produção — o id vai prefixado com `pagou:` pra
 * não colidir com transação Guru e pra ser idempotente.
 */
const AFFILIATES_GURU_WEBHOOK = 'https://parceiros.leonaflow.com/api/webhooks/guru';

export function affiliatesWebhookToken() {
  return (
    process.env.GURU_WEBHOOK_API_TOKEN ||
    process.env.AFILIADOS_GURU_WEBHOOK_API_TOKEN ||
    process.env.GURU_API_KEY ||
    ''
  );
}

export function buildAffiliatesPagouPayload({
  txId,
  email,
  name,
  amountCents,
  paidAt,
  status = 'approved'
}) {
  const cents = Number(amountCents);
  const reais = Number.isFinite(cents) && cents > 0 ? cents / 100 : 0;
  return {
    api_token: affiliatesWebhookToken(),
    webhook_type: 'transaction',
    status,
    id: txId.startsWith('pagou:') ? txId : `pagou:${txId}`,
    contact: {
      email: String(email || '').trim().toLowerCase(),
      name: name || null
    },
    payment: {
      total: reais,
      gross: reais
    },
    dates: {
      confirmed_at: paidAt || new Date().toISOString()
    }
  };
}

export async function notifyAffiliatesPagou({
  txId,
  email,
  name,
  amountCents,
  paidAt,
  status = 'approved'
}) {
  if (!affiliatesWebhookToken()) {
    console.warn('notify-affiliates: GURU_WEBHOOK_API_TOKEN ausente — comissão Pagou não enviada');
    return { skipped: true, reason: 'missing_token' };
  }
  if (!txId || !email) return { skipped: true, reason: 'missing_tx_or_email' };

  const payload = buildAffiliatesPagouPayload({
    txId,
    email,
    name,
    amountCents,
    paidAt,
    status
  });
  if (status === 'approved' && !(payload.payment.total > 0)) {
    return { skipped: true, reason: 'no_amount' };
  }

  try {
    const r = await fetch(AFFILIATES_GURU_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await r.json().catch(() => ({}));
    console.log('notify-affiliates: pagou', r.status, payload.id, body?.status || body?.error || '');
    return { ok: r.ok, http: r.status, body };
  } catch (err) {
    console.error('notify-affiliates:', err.message);
    return { ok: false, error: err.message };
  }
}

export function isAffiliateReversal(eventName, status) {
  const ev = String(eventName || '').toLowerCase();
  const st = String(status || '').toLowerCase();
  if (ev === 'transaction.refunded' || ev === 'subscription.chargeback_received' || ev === 'transaction.chargedback') {
    return ev.includes('charge') ? 'chargeback' : 'refunded';
  }
  if (st === 'refunded') return 'refunded';
  if (st === 'chargedback' || st === 'chargeback') return 'chargeback';
  return null;
}
