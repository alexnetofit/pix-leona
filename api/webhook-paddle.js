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
import { updateLeonaBillingProfile } from '../lib/leona.js';

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

function extractLeonaAccountId(data) {
  const raw =
    data?.custom_data?.leona_account_id ??
    data?.subscription?.custom_data?.leona_account_id ??
    null;
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
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

  const eventType = event.event_type || event.type;
  const data = event.data || {};
  const accountId = extractLeonaAccountId(data);

  console.log(`webhook-paddle: evento ${eventType} | leona_account_id=${accountId} | tx=${data.id}`);

  // Sem marker leona = não veio do nosso fluxo de renovação. Ack e segue.
  if (!accountId) {
    return res.status(200).json({ received: true, ignored: true, reason: 'sem leona_account_id' });
  }

  if (!leonaToken) {
    console.error('webhook-paddle: LEONA_BILLING_TOKEN não configurado');
    return res.status(200).json({ received: true, error: 'LEONA_BILLING_TOKEN ausente' });
  }

  try {
    let payload = null;

    switch (eventType) {
      case 'transaction.completed': {
        // Pode ser 1ª compra (sem subscription ainda) — usa items da própria tx.
        const qty = sumQuantities(data.items);
        payload = {
          status: 'active',
          ...(qty > 0 ? { starter_instances: qty } : {})
        };
        break;
      }

      case 'subscription.activated':
      case 'subscription.resumed': {
        const qty = sumQuantities(data.items);
        payload = {
          status: 'active',
          ...(qty > 0 ? { starter_instances: qty } : {})
        };
        break;
      }

      case 'subscription.updated': {
        const qty = sumQuantities(data.items);
        payload = qty > 0 ? { starter_instances: qty } : null;
        break;
      }

      case 'subscription.canceled': {
        payload = { status: 'canceled', starter_instances: 0 };
        break;
      }

      case 'subscription.paused': {
        payload = { status: 'inactive' };
        break;
      }

      case 'subscription.past_due':
      case 'transaction.payment_failed': {
        // Por enquanto só logamos — não cancela na Leona automaticamente
        // pra dar tempo do dunning recuperar.
        console.log(`webhook-paddle: ${eventType} para account ${accountId} (sem ação)`);
        return res.status(200).json({ received: true, action: 'log_only' });
      }

      default:
        return res.status(200).json({ received: true, ignored: true, reason: `evento ${eventType} sem handler` });
    }

    if (!payload) {
      return res.status(200).json({ received: true, action: 'noop', reason: 'payload vazio' });
    }

    const result = await updateLeonaBillingProfile(accountId, payload, leonaToken);
    if (!result.ok) {
      console.error(`webhook-paddle: falha ao atualizar Leona ${accountId}:`, result);
      return res.status(200).json({ received: true, leona_sync: { ok: false, error: result.body?.error || result.error } });
    }

    return res.status(200).json({
      received: true,
      leona_sync: { ok: true, account_id: accountId, payload }
    });

  } catch (e) {
    console.error('webhook-paddle: erro inesperado:', e);
    return res.status(200).json({ received: true, error: e.message });
  }
}
