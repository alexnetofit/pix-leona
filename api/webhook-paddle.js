/**
 * webhook-paddle.js - Recebe notificações da Paddle e sincroniza com o Leona.
 *
 * Configurar em Paddle Dashboard → Developer Tools → Notifications:
 *   - URL: https://client.leonaflow.com/api/webhook-paddle
 *   - Secret: salvar como PADDLE_WEBHOOK_SECRET (formato pdl_ntfset_...)
 *   - Eventos:
 *       transaction.completed
 *       transaction.payment_failed
 *       subscription.activated
 *       subscription.canceled
 *       subscription.past_due
 *       subscription.paused
 *       subscription.resumed
 *       subscription.updated
 *
 * O endpoint só sincroniza Leona quando o evento traz custom_data.leona_account_id
 * (que injetamos em paddle-subscription.js → action create_renewal_checkout).
 * Eventos de outras integrações (sem o marker) são reconhecidos mas ignorados,
 * o que mantém o ambiente seguro pra "migrar aos poucos".
 */

import crypto from 'crypto';
import { updateLeonaBillingProfile, getLeonaBillingProfile } from '../lib/leona.js';
import { findGuruActiveSubscriptionsByEmail, cancelGuruSubscription } from '../lib/guru.js';

export const config = {
  api: { bodyParser: false }
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(';').map(s => {
      const [k, ...rest] = s.split('=');
      return [k, rest.join('=')];
    })
  );
  if (!parts.ts || !parts.h1) return false;

  const signedPayload = `${parts.ts}:${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.h1));
  } catch {
    return false;
  }
}

function sumQuantities(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((acc, it) => acc + (Number(it.quantity) || 0), 0);
}

/**
 * Converte ISO 8601 (ou YYYY-MM-DD) pra YYYY-MM-DD.
 * Leona aceita apenas esse formato no campo due_date do POST.
 */
function toDueDate(iso) {
  if (!iso) return null;
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  try { return new Date(s).toISOString().slice(0, 10); } catch { return null; }
}

/**
 * Busca next_billed_at da subscription Paddle. Usado quando o evento e
 * transaction.completed (que NAO inclui next_billed_at no payload — esse
 * campo vive no objeto subscription).
 */
async function fetchPaddleSubscriptionNextBilled(subscriptionId, paddleApiKey) {
  if (!subscriptionId || !paddleApiKey) return null;
  try {
    const r = await fetch(`https://api.paddle.com/subscriptions/${subscriptionId}`, {
      headers: { 'Authorization': `Bearer ${paddleApiKey}`, 'Accept': 'application/json' }
    });
    if (!r.ok) return null;
    const body = await r.json();
    return body.data?.next_billed_at || null;
  } catch (_) {
    return null;
  }
}

function extractLeonaAccountId(data) {
  const raw =
    data?.custom_data?.leona_account_id ??
    data?.subscription?.custom_data?.leona_account_id ??
    null;
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Logica pura de processamento de evento Paddle. Recebe o evento ja parseado
 * (sem precisar validar signature aqui — quem chama e responsavel) e os
 * tokens. Retorna { status, body } pra o handler HTTP responder do mesmo
 * jeito que o webhook responderia.
 *
 * Tambem usado pelo /api/webhook-paddle-replay (debug — autenticado por
 * SUPPORT_CHAT_TOKEN) e pelo proprio handler do webhook real.
 */
export async function processPaddleEvent(event, opts = {}) {
  const {
    leonaToken = process.env.LEONA_BILLING_TOKEN,
    paddleApiKey = process.env.PADDLE_API_KEY,
    guruToken = process.env.GURU_TOKEN
  } = opts;

  const eventType = event?.event_type || event?.type;
  const data = event?.data || {};
  const accountId = extractLeonaAccountId(data);

  if (!accountId) {
    return { status: 200, body: { received: true, ignored: true, reason: 'sem leona_account_id', event_type: eventType } };
  }
  if (!leonaToken) {
    return { status: 200, body: { received: true, error: 'LEONA_BILLING_TOKEN ausente', event_type: eventType } };
  }

  let payload = null;
  switch (eventType) {
    case 'transaction.completed': {
      const qty = sumQuantities(data.items);
      const subId = data.subscription_id || null;
      const nextBilled = subId ? await fetchPaddleSubscriptionNextBilled(subId, paddleApiKey) : null;
      const dueDate = toDueDate(nextBilled);
      payload = {
        status: 'active',
        ...(qty > 0 ? { starter_instances: qty } : {}),
        ...(dueDate ? { due_date: dueDate } : {})
      };
      break;
    }
    case 'subscription.activated':
    case 'subscription.resumed': {
      const qty = sumQuantities(data.items);
      const dueDate = toDueDate(data.next_billed_at);
      payload = {
        status: 'active',
        ...(qty > 0 ? { starter_instances: qty } : {}),
        ...(dueDate ? { due_date: dueDate } : {})
      };
      break;
    }
    case 'subscription.updated': {
      const qty = sumQuantities(data.items);
      const dueDate = toDueDate(data.next_billed_at);
      payload = (qty > 0 || dueDate)
        ? { ...(qty > 0 ? { starter_instances: qty } : {}), ...(dueDate ? { due_date: dueDate } : {}) }
        : null;
      break;
    }
    case 'subscription.canceled':
      payload = { status: 'canceled', starter_instances: 0 };
      break;
    case 'subscription.paused':
      payload = { status: 'inactive' };
      break;
    case 'subscription.past_due':
    case 'transaction.payment_failed':
      return { status: 200, body: { received: true, action: 'log_only', event_type: eventType, account_id: accountId } };
    default:
      return { status: 200, body: { received: true, ignored: true, reason: `evento ${eventType} sem handler`, account_id: accountId } };
  }

  if (!payload) {
    return { status: 200, body: { received: true, action: 'noop', reason: 'payload vazio', account_id: accountId } };
  }

  const result = await updateLeonaBillingProfile(accountId, payload, leonaToken);
  if (!result.ok) {
    return {
      status: 200,
      body: {
        received: true,
        event_type: eventType,
        account_id: accountId,
        payload_attempted: payload,
        leona_sync: { ok: false, status: result.status, error: result.body?.error || result.error, body: result.body }
      }
    };
  }

  let guruCancel = null;
  const isActivationEvent = (eventType === 'transaction.completed' || eventType === 'subscription.activated');
  if (isActivationEvent && guruToken) {
    try {
      const profile = await getLeonaBillingProfile(accountId, leonaToken);
      const profileEmail = profile?.user?.email || null;
      if (profileEmail) {
        const subs = await findGuruActiveSubscriptionsByEmail(profileEmail, guruToken);
        if (subs.length === 0) {
          guruCancel = { skipped: true, reason: 'sem subs Guru ativas' };
        } else {
          const results = [];
          for (const s of subs) {
            const r = await cancelGuruSubscription(s.id, guruToken);
            results.push({ id: s.id, ok: r.ok, error: r.ok ? null : (r.body?.message || r.error) });
          }
          guruCancel = { attempted: subs.length, results };
        }
      } else {
        guruCancel = { skipped: true, reason: 'sem email no billing_profile' };
      }
    } catch (err) {
      guruCancel = { skipped: true, error: err.message };
    }
  } else if (isActivationEvent && !guruToken) {
    guruCancel = { skipped: true, reason: 'GURU_TOKEN nao configurado' };
  }

  return {
    status: 200,
    body: {
      received: true,
      event_type: eventType,
      leona_sync: { ok: true, account_id: accountId, payload },
      guru_cancel: guruCancel
    }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!webhookSecret) {
    console.error('webhook-paddle: PADDLE_WEBHOOK_SECRET não configurado');
    return res.status(503).json({ error: 'Webhook não configurado' });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    console.error('webhook-paddle: erro lendo body:', e.message);
    return res.status(400).json({ error: 'Body inválido' });
  }

  const sig = req.headers['paddle-signature'];
  if (!verifyPaddleSignature(raw, sig, webhookSecret)) {
    console.error('webhook-paddle: assinatura inválida');
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return res.status(400).json({ error: 'JSON inválido' });
  }

  console.log(`webhook-paddle: evento ${event.event_type} | tx=${event.data?.id}`);

  try {
    const { status, body } = await processPaddleEvent(event, { leonaToken });
    return res.status(status).json(body);
  } catch (e) {
    console.error('webhook-paddle: erro inesperado:', e);
    return res.status(200).json({ received: true, error: e.message });
  }
}
