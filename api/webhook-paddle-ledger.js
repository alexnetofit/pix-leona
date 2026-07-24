import { createHmac, timingSafeEqual } from 'node:crypto';
import { insertPaddleWebhookEvent } from '../lib/paddle-ledger.js';

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

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyPaddleWebhookSignature(
  rawBody,
  header,
  secret,
  now = Date.now(),
  toleranceSeconds = 300
) {
  if (!header || !secret) return false;
  const timestamps = [];
  const signatures = [];
  for (const part of String(header).split(';')) {
    const [key, ...rest] = part.split('=');
    const value = rest.join('=');
    if (key === 'ts') timestamps.push(value);
    if (key === 'h1') signatures.push(value);
  }
  const timestamp = Number(timestamps[0]);
  if (!Number.isInteger(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}:${rawBody}`)
    .digest('hex');
  return signatures.some(signature => safeEqual(signature, expected));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Webhook Paddle não configurado' });
  }

  try {
    const raw = await readRawBody(req);
    if (!verifyPaddleWebhookSignature(
      raw,
      req.headers['paddle-signature'],
      secret
    )) {
      return res.status(401).json({ error: 'Assinatura inválida' });
    }

    const payload = JSON.parse(raw);
    if (!payload?.event_id || !payload?.event_type || !payload?.occurred_at || !payload?.data) {
      return res.status(400).json({ error: 'Evento Paddle inválido' });
    }
    const result = await insertPaddleWebhookEvent({
      event_id: payload.event_id,
      notification_id: payload.notification_id || null,
      event_type: payload.event_type,
      occurred_at: payload.occurred_at,
      entity_id: payload.data.id || null,
      leona_account_id:
        payload.data.custom_data?.leona_account_id ||
        payload.data.custom_data?.account_id ||
        null,
      payload
    });
    return res.status(200).json({
      received: true,
      duplicate: result.duplicate
    });
  } catch (error) {
    console.error('[webhook-paddle-ledger]', error);
    return res.status(500).json({ error: 'Falha ao persistir evento Paddle' });
  }
}
