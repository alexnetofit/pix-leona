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

/**
 * Após pagamento de uma transaction de migração (Guru→Paddle), ajusta a
 * subscription recém-criada para:
 *   1. Ancorar a próxima cobrança em `anchor_at` (a data Guru), sem cobrar
 *      nada agora — `proration_billing_mode: 'do_not_bill'`.
 *   2. Attachar o tier discount recorrente (saved discount criado pelo
 *      paddle-subscription.action=create_migration_checkout) pra que as
 *      próximas cobranças mensais já saiam com o desconto por volume.
 *
 * Faz tudo best-effort: se uma etapa falha, loga e continua. O custom_data
 * da transaction é a fonte da verdade pra anchor_at e tier_discount_id.
 */
async function applyMigrationAnchor({ subscriptionId, anchorAt, tierDiscountId, paddleApiKey }) {
  if (!subscriptionId || !paddleApiKey) {
    return { ok: false, error: 'subscription_id ou PADDLE_API_KEY ausente' };
  }
  const headers = {
    'Authorization': `Bearer ${paddleApiKey}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  const result = { anchor: null, discount: null };

  // Pré-checa o estado atual da subscription. A Paddle rejeita PATCH
  // de next_billed_at se o anchor for <= started_at — nesse caso o
  // ciclo Paddle "default" (D → D+30) prevalece, o que efetivamente
  // dá ao cliente um mês quase de graça quando ele migra colado no
  // vencimento Guru. Esse cenário deveria ter sido bloqueado no
  // create_migration_checkout (MIN_MIGRATION_DAYS), mas se chegou
  // aqui, é melhor logar bem visivel pro suporte.
  let subSnapshot = null;
  try {
    const r = await fetch(`https://api.paddle.com/subscriptions/${subscriptionId}`, { headers });
    if (r.ok) {
      const body = await r.json();
      subSnapshot = body.data || null;
    }
  } catch (_) {}

  if (anchorAt) {
    let anchorIso = anchorAt;
    if (/^\d{4}-\d{2}-\d{2}$/.test(anchorAt)) {
      anchorIso = `${anchorAt}T00:00:00Z`;
    }

    // Defesa explícita: se anchor_at já passou em relação ao
    // started_at da sub, skipa o PATCH e loga warning. Sem isso,
    // o PATCH 4xx fica enterrado no response body e ninguém vê.
    const startedAtMs = subSnapshot?.started_at ? new Date(subSnapshot.started_at).getTime() : null;
    const anchorMs = new Date(anchorIso).getTime();
    if (startedAtMs && Number.isFinite(anchorMs) && anchorMs <= startedAtMs) {
      console.warn(
        `[migration_anchor] ANCHOR NO PASSADO sub=${subscriptionId} anchor=${anchorIso} started_at=${subSnapshot.started_at}. ` +
        `PATCH skipado — ciclo Paddle ficará D→D+30 e o cliente terá 1 mês quase grátis. ` +
        `Considere ajustar a sub manualmente ou aguardar 1 ciclo.`
      );
      result.anchor = {
        ok: false,
        skipped: true,
        reason: 'anchor_in_past',
        anchor_at: anchorIso,
        started_at: subSnapshot.started_at
      };
    } else {
      try {
        const r = await fetch(`https://api.paddle.com/subscriptions/${subscriptionId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            next_billed_at: anchorIso,
            proration_billing_mode: 'do_not_bill'
          })
        });
        const body = await r.json().catch(() => ({}));
        result.anchor = { ok: r.ok, status: r.status, error: r.ok ? null : (body?.error || body) };
        if (!r.ok) {
          console.warn(
            `[migration_anchor] PATCH next_billed_at FALHOU sub=${subscriptionId} ` +
            `anchor=${anchorIso} status=${r.status} error=${JSON.stringify(body?.error || body)}`
          );
        }
      } catch (e) {
        console.warn(`[migration_anchor] EXCEPTION no PATCH next_billed_at sub=${subscriptionId}: ${e.message}`);
        result.anchor = { ok: false, error: e.message };
      }
    }
  }

  if (tierDiscountId) {
    try {
      const r = await fetch(`https://api.paddle.com/subscriptions/${subscriptionId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          discount: {
            id: tierDiscountId,
            effective_from: 'next_billing_period'
          },
          proration_billing_mode: 'do_not_bill'
        })
      });
      const body = await r.json().catch(() => ({}));
      result.discount = { ok: r.ok, status: r.status, error: r.ok ? null : (body?.error || body) };
      if (!r.ok) {
        console.warn(
          `[migration_anchor] PATCH discount FALHOU sub=${subscriptionId} ` +
          `discount=${tierDiscountId} status=${r.status} error=${JSON.stringify(body?.error || body)}`
        );
      }
    } catch (e) {
      console.warn(`[migration_anchor] EXCEPTION no PATCH discount sub=${subscriptionId}: ${e.message}`);
      result.discount = { ok: false, error: e.message };
    }
  }

  return result;
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
  let migrationAnchorResult = null;
  switch (eventType) {
    case 'transaction.completed': {
      const qty = sumQuantities(data.items);
      const subId = data.subscription_id || null;

      // Migração Guru→Paddle: a transaction marca migration:true em
      // custom_data. Antes de ler next_billed_at do Paddle, a gente
      // PATCHa a subscription pra:
      //   1. mover next_billed_at pra data Guru (do_not_bill, sem cobrar)
      //   2. attachar o tier discount recorrente
      // Aí o fetchPaddleSubscriptionNextBilled abaixo já devolve a
      // data correta pra sincronizar com o Leona.
      const cd = data.custom_data || {};
      if (cd.migration === true && subId) {
        migrationAnchorResult = await applyMigrationAnchor({
          subscriptionId: subId,
          anchorAt: cd.anchor_at || null,
          tierDiscountId: cd.tier_discount_id || null,
          paddleApiKey
        });
      }

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
        leona_sync: { ok: false, status: result.status, error: result.body?.error || result.error, body: result.body },
        ...(migrationAnchorResult ? { migration_anchor: migrationAnchorResult } : {})
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
      guru_cancel: guruCancel,
      ...(migrationAnchorResult ? { migration_anchor: migrationAnchorResult } : {})
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
