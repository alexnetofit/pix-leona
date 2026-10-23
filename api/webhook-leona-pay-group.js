/**
 * POST /api/webhook-leona-pay-group
 * business.approved cria o grupo "{primeiro nome} - Leona Pay" no WhatsApp do Alex.
 * URL: https://client.leonaflow.com/api/webhook-leona-pay-group
 */
import { sbConfigured, sbInsert } from '../lib/supabase.js';
import { leonaPayWebhookRecord } from '../lib/leona-pay-group-webhook.js';
import { createLeonaPayGroup, leonaPayGroupImageDataUri, leonaPhoneForEmail, parseApprovedBusiness } from '../lib/leona-pay-group.js';

function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'] || req?.headers?.['x-real-ip'] || '';
  return String(forwarded).split(',')[0].trim() || req?.socket?.remoteAddress || null;
}

function publicGroup(result) {
  if (!result) return null;
  if (result.skipped) return { skipped: true, reason: result.reason || null };
  if (!result.ok) return { ok: false, reason: result.reason || null, step: result.step || null };
  return {
    ok: true,
    name: result.groupName,
    jid: result.groupJid,
    created: result.created,
    description: result.description,
    image: result.image,
    maxAdmin: result.maxAdmin,
    leadAdded: result.leadAdded,
    leadInvited: result.leadInvited,
    leadReason: result.leadReason
  };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    let photo = false;
    try {
      photo = leonaPayGroupImageDataUri().startsWith('data:image/jpeg;base64,');
    } catch {
      photo = false;
    }
    return res.status(200).json({
      ok: true,
      service: 'leona-pay-group',
      photo,
      webhook: 'https://client.leonaflow.com/api/webhook-leona-pay-group'
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const parsed = parseApprovedBusiness(req.body);
  let group = null;
  if (parsed.ok) {
    let leonaPhone = null;
    if (!parsed.phone && parsed.email) {
      try {
        leonaPhone = await leonaPhoneForEmail(parsed.email);
      } catch (error) {
        console.error('webhook-leona-pay-group: leona phone', error.message);
      }
    }
    try {
      group = await createLeonaPayGroup(req.body, { phone: leonaPhone });
    } catch (error) {
      console.error('webhook-leona-pay-group: criação falhou', error.message);
      group = { ok: false, reason: 'falha ao criar o grupo', step: 'create' };
    }
  } else if (parsed.skipped) {
    group = parsed;
  } else {
    group = { ok: false, reason: parsed.reason };
  }

  const summary = publicGroup(group);
  const record = leonaPayWebhookRecord(req.body, {
    contentType: req.headers['content-type'] || null,
    query: req.query || {},
    group: summary
  });

  console.log('webhook-leona-pay-group', JSON.stringify({
    email: record.email,
    event: parsed.event || null,
    group: summary
  }));

  let stored = false;
  let id = null;
  if (sbConfigured()) {
    try {
      const row = await sbInsert('assinatura_access_logs', {
        ...record,
        ip: clientIp(req),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 400) || null
      });
      stored = true;
      id = row?.id || null;
    } catch (error) {
      console.error('webhook-leona-pay-group: falha ao gravar', error.message);
    }
  }

  if (parsed.ok && !group?.groupJid) {
    return res.status(500).json({
      ok: false,
      received: true,
      stored,
      id,
      group: summary
    });
  }

  return res.status(200).json({
    ok: true,
    received: true,
    stored,
    id,
    group: summary
  });
}
