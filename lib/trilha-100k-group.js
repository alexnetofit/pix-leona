/** Entrada no grupo WhatsApp da Cúpula dos 100k (Trilha). */

import { sbConfigured, sbInsert, sbSelect } from './supabase.js';

export const TRILHA_100K_PRIZE_ID = '100k';
export const TRILHA_100K_MILESTONE = 100_000;
export const TRILHA_100K_PHONE_LIMIT = 3;
export const TRILHA_100K_PHONE_LIMIT_REASON =
  'Esta conta já usou o máximo de WhatsApps permitidos para entrar no grupo.';
export const TRILHA_100K_PHONES_TABLE = 'trilha_100k_group_phones';
export const DEFAULT_TRILHA_100K_GROUP_JID = '120363411351432584@g.us';
export const DEFAULT_TRILHA_100K_UAZAPI_URL = 'https://leona16.uazapi.com';
export const DEFAULT_TRILHA_100K_HELP_PHONE = '5511987846444';

export function trilha100kGroupConfig(env = process.env) {
  const rawUrl = String(env.TRILHA_100K_UAZAPI_URL || DEFAULT_TRILHA_100K_UAZAPI_URL).trim();
  const url = rawUrl.replace(/\/instance\/[^/]+\/?$/i, '').replace(/\/+$/, '');
  const token = String(env.TRILHA_100K_UAZAPI_TOKEN || '').trim();
  const groupJid = String(env.TRILHA_100K_GROUP_JID || DEFAULT_TRILHA_100K_GROUP_JID).trim();
  const helpPhone = String(env.TRILHA_100K_HELP_PHONE || DEFAULT_TRILHA_100K_HELP_PHONE).replace(/\D/g, '');
  return { url, token, groupJid, helpPhone };
}

export function decideTrilha100kPhoneUse(usedPhones, phone, limit = TRILHA_100K_PHONE_LIMIT) {
  const used = [...new Set(
    (usedPhones || [])
      .map((value) => String(value || '').replace(/\D/g, ''))
      .filter(Boolean)
  )];
  const want = String(phone || '').replace(/\D/g, '');
  if (!want) return { ok: false, reason: 'Informe o WhatsApp' };
  if (used.includes(want)) return { ok: true, already: true };
  if (used.length >= limit) return { ok: false, reason: TRILHA_100K_PHONE_LIMIT_REASON };
  return { ok: true, already: false };
}

export async function listTrilha100kPhones(accountId) {
  if (!sbConfigured()) throw new Error('Supabase da trilha não configurado');
  const rows = await sbSelect(TRILHA_100K_PHONES_TABLE, {
    eq: { account_id: String(accountId) },
    select: 'phone',
    limit: 20
  });
  return rows.map((row) => String(row.phone || '').replace(/\D/g, '')).filter(Boolean);
}

export async function rememberTrilha100kPhone({ accountId, email, phone }) {
  if (!sbConfigured()) throw new Error('Supabase da trilha não configurado');
  try {
    await sbInsert(TRILHA_100K_PHONES_TABLE, {
      account_id: String(accountId),
      email: email || null,
      phone
    });
    return { ok: true };
  } catch (error) {
    const msg = String(error.message || '');
    if (/duplicate|unique|already exists/i.test(msg)) return { ok: true, already: true };
    if (/phone limit reached/i.test(msg)) return { ok: false, reason: TRILHA_100K_PHONE_LIMIT_REASON };
    throw error;
  }
}

export function normalizeWhatsappNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return { ok: false, error: 'Informe o WhatsApp' };
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (!/^55\d{10,11}$/.test(digits)) {
    return { ok: false, error: 'WhatsApp inválido. Use DDD + número (ex.: 11 98784-6444).' };
  }
  return { ok: true, phone: digits };
}

export function trilha100kHelpMessage(email) {
  const mail = String(email || '').trim();
  return `Preciso de ajuda para entrar no Grupo de 100k. Email: ${mail || 'não informado'}`;
}

export function trilha100kHelpUrl(email, helpPhone = DEFAULT_TRILHA_100K_HELP_PHONE) {
  const phone = String(helpPhone || DEFAULT_TRILHA_100K_HELP_PHONE).replace(/\D/g, '');
  return `https://wa.me/${phone}?text=${encodeURIComponent(trilha100kHelpMessage(email))}`;
}

export function extractUazapiReason(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [
    payload.error,
    payload.message,
    payload.msg,
    payload.reason,
    payload?.data?.error,
    payload?.data?.message
  ].filter((value) => typeof value === 'string' && value.trim());
  if (parts.length) return parts[0].trim();
  const failed = payload.failed || payload.Failed || payload.errors;
  if (Array.isArray(failed) && failed.length) {
    const first = failed[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      return String(first.error || first.message || first.reason || JSON.stringify(first));
    }
  }
  return '';
}

function participantPhones(group) {
  const list = group?.Participants || group?.participants || group?.group?.Participants || [];
  return (Array.isArray(list) ? list : []).map((row) => (
    String(row?.PhoneNumber || row?.PN || row?.phone || row?.JID || '').replace(/\D/g, '')
  ));
}

export function groupHasPhone(group, phone) {
  const want = String(phone || '').replace(/\D/g, '');
  if (!want) return false;
  return participantPhones(group).some((digits) => digits.endsWith(want) || want.endsWith(digits));
}

export function interpretGroupAdd({ httpOk, payload, phone, groupAfter }) {
  const reason = extractUazapiReason(payload);
  if (!httpOk) {
    return { ok: false, reason: reason || 'A API do WhatsApp recusou o convite' };
  }
  if (groupHasPhone(groupAfter || payload?.group || payload, phone)) {
    return { ok: true };
  }
  if (reason) return { ok: false, reason };
  return {
    ok: false,
    reason: 'WhatsApp não confirmou a entrada. O número pode estar errado, com privacidade bloqueando ou o grupo pedindo aprovação.'
  };
}

async function uazapiPost(config, path, body) {
  const res = await fetch(`${config.url}${path}`, {
    method: 'POST',
    headers: {
      token: config.token,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await res.json().catch(() => ({}));
  return { httpOk: res.ok, status: res.status, payload };
}

export async function addPhoneToTrilha100kGroup(phone, env = process.env) {
  const config = trilha100kGroupConfig(env);
  if (!config.token) {
    return { ok: false, reason: 'Integração do grupo 100k sem token' };
  }

  const infoBefore = await uazapiPost(config, '/group/info', { groupJid: config.groupJid });
  if (infoBefore.httpOk && groupHasPhone(infoBefore.payload, phone)) {
    return { ok: true, already: true };
  }

  const added = await uazapiPost(config, '/group/updateParticipants', {
    groupJid: config.groupJid,
    participants: [phone],
    action: 'add'
  });

  let groupAfter = added.payload?.group || null;
  if (!groupHasPhone(groupAfter, phone)) {
    const infoAfter = await uazapiPost(config, '/group/info', { groupJid: config.groupJid });
    if (infoAfter.httpOk) groupAfter = infoAfter.payload;
  }

  return interpretGroupAdd({
    httpOk: added.httpOk,
    payload: added.payload,
    phone,
    groupAfter
  });
}
