/**
 * Abre o grupo de suporte do Leona Pay quando chega business.approved.
 *
 * Quem cria o grupo já entra como admin. O Max e o Alex (12991426510)
 * entram e são promovidos, então o grupo fica com três admins.
 * Foto e descrição copiadas do grupo "Álvaro - Leona Pay".
 * O cliente entra com o telefone do payload ou, na falta dele, o da conta Leona.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LEONA_PAY_WELCOME_TEXT = [
  'Opa, seja bem vindo(a) ao Leona Pay!!',
  '',
  '🚨🚨 *Antes de tudo entre no nosso canal de avisos e comunicados:*',
  'https://whatsapp.com/channel/0029VbEclpODzgTBHLWVJX34',
  '',
  'Me conta um pouco sobre a sua operação, enquanto reviso os dados da sua conta.',
  '',
  '• Qual seu faturamento médio diário (estimado em BRL)?',
  '',
  '• Como foi seu último mês e quais países você roda?',
  '',
  '• Você veio por algum mentor?'
].join('\n');

export function leonaPayPrivateInviteText(link) {
  return [
    'Opa, sua conta no Leona Pay foi aprovada!',
    `Link do seu grupo: ${link}`,
    '',
    LEONA_PAY_WELCOME_TEXT
  ].join('\n');
}

export function leonaPayGroupDescription({ companyName = '', email = '', clientName = '', createdAt = '', businessId = '' } = {}) {
  const lines = ['*Grupo de suporte para parceiros LEONAPAY🔥*', ''];
  if (companyName) lines.push(`Empresa: ${companyName}`);
  if (email) lines.push(`E-mail: ${email}`);
  if (clientName) lines.push(`Cliente: ${clientName}`);
  const created = formatCreatedAt(createdAt);
  if (created) lines.push(`Criada em: ${created}`);
  if (businessId) lines.push(`ID: ${businessId}`);
  lines.push(
    '',
    'Link pra login ↓',
    'https://client.leonapay.com.br/login',
    '',
    'Link pra cadastro ↓',
    'https://client.leonapay.com.br/registro',
    '',
    'Nosso site ↓',
    'https://leonapay.com.br'
  );
  const text = lines.join('\n');
  return text.length <= 512 ? text : text.slice(0, 512).trim();
}

function formatCreatedAt(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export const DEFAULT_LEONA_PAY_MAX_PHONE = '5521964746924';
export const LEONA_PAY_ALEX_PHONE = '5512991426510';
export const LEONA_PAY_OWNER_PHONE = LEONA_PAY_ALEX_PHONE;
const APPROVED_EVENT = 'business.approved';
const PHONE_KEYS = ['phone', 'whatsapp', 'mobile', 'celular', 'telephone', 'telefone', 'phoneNumber'];
const NAME_KEYS = ['name', 'nome'];

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

function pickString(source, keys) {
  const obj = asObject(source);
  if (!obj) return '';
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

export function normalizeLeadPhone(raw, country = 'BR') {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits) return { ok: false, error: 'payload sem telefone' };
  const cc = String(country || 'BR').trim().toUpperCase() || 'BR';
  if (cc === 'BR' && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`;
  if (digits.length < 10 || digits.length > 15) return { ok: false, error: 'telefone inválido' };
  return { ok: true, phone: digits };
}

export function leonaPayFirstName(name) {
  const first = String(name || '').replace(/\s+/g, ' ').trim().split(' ')[0] || '';
  if (!first) return '';
  const lower = first.toLocaleLowerCase('pt-BR');
  return lower.charAt(0).toLocaleUpperCase('pt-BR') + lower.slice(1);
}

export function leonaPayGroupName(name) {
  const first = leonaPayFirstName(name);
  if (!first) return '';
  const titled = `${first} - Leona Pay`;
  return titled.length <= 100 ? titled : titled.slice(0, 100).trim();
}

export async function leonaPhoneForEmail(email, { env = process.env, fetchImpl = fetch } = {}) {
  const token = String(env.LEONA_BILLING_TOKEN || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  if (!token || !mail.includes('@')) return null;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'pix-leona-ops'
  };
  const base = 'https://apiaws.leonasolutions.io/api/v1/integration/accounts';
  const listed = await fetchImpl(`${base}/billing_profile?email=${encodeURIComponent(mail)}`, { headers });
  const body = await listed.json().catch(() => ({}));
  if (listed.status === 409 && Array.isArray(body.account_ids)) {
    const found = [];
    for (const id of body.account_ids) {
      const res = await fetchImpl(`${base}/${encodeURIComponent(id)}/billing_profile`, { headers });
      const profile = await res.json().catch(() => ({}));
      const phone = profile?.user?.phone;
      if (phone) found.push({ phone: String(phone), active: profile.subscription_status === 'active' });
    }
    return (found.find((row) => row.active) || found[0])?.phone || null;
  }
  return body?.user?.phone ? String(body.user.phone) : null;
}

export function parseApprovedBusiness(body) {
  const payload = asObject(body);
  if (!payload) return { ok: false, reason: 'payload inválido' };
  const event = String(payload.event || '').trim();
  if (event !== APPROVED_EVENT) {
    return { ok: false, skipped: true, reason: 'evento ignorado', event: event || null };
  }
  const business = asObject(payload.business) || {};
  const owner = asObject(payload.owner) || {};
  const clientName = pickString(owner, NAME_KEYS);
  const companyName = pickString(business, ['tradeName', 'legalName']);
  const name = clientName || companyName;
  if (!name) return { ok: false, reason: 'sem nome do cliente' };
  const email = (pickString(owner, ['email', 'Email']) || pickString(business, ['email', 'Email'])).toLowerCase();
  const createdAt = pickString(business, ['createdAt', 'created_at']);
  const phoneRaw = pickString(owner, PHONE_KEYS)
    || pickString(business, PHONE_KEYS)
    || pickString(payload, PHONE_KEYS);
  const phone = normalizeLeadPhone(phoneRaw, business.country || 'BR');
  return {
    ok: true,
    event,
    businessId: pickString(business, ['id']) || null,
    name,
    email: email.includes('@') ? email.slice(0, 320) : null,
    phone: phone.ok ? phone.phone : null,
    phoneError: phone.ok ? null : phone.error,
    companyName: companyName || null,
    clientName: clientName || name,
    createdAt: createdAt || null,
    groupName: leonaPayGroupName(name)
  };
}

export function leonaPayGroupConfig(env = process.env) {
  const rawUrl = String(env.LEONA_PAY_UAZAPI_URL || '').trim();
  const url = rawUrl.replace(/\/instance\/[^/]+\/?$/i, '').replace(/\/+$/, '');
  const token = String(env.LEONA_PAY_UAZAPI_TOKEN || '').trim();
  const maxPhone = String(env.LEONA_PAY_MAX_PHONE || DEFAULT_LEONA_PAY_MAX_PHONE).replace(/\D/g, '');
  return { url, token, maxPhone };
}

export function normalizeGroupTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function groupJidOf(group) {
  return group?.JID || group?.jid || group?.groupJid || null;
}

function groupTitleOf(group) {
  return group?.Name || group?.name || '';
}

function listGroups(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.groups || payload?.data || [];
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function brazilCore(digits) {
  let local = digits;
  if (local.startsWith('55') && (local.length === 12 || local.length === 13)) local = local.slice(2);
  if (local.length === 11 && local[2] === '9') return local.slice(0, 2) + local.slice(3);
  if (local.length === 10) return local;
  return '';
}

function mentionsPhone(value, phone) {
  const wanted = phoneDigits(phone);
  if (!wanted || value == null) return false;
  if (typeof value === 'object') {
    return [value.PhoneNumber, value.PN, value.JID, value.jid, value.phone, value.number]
      .some((field) => field && mentionsPhone(field, wanted));
  }
  const digits = phoneDigits(value);
  if (!digits) return false;
  if (digits.includes(wanted) || wanted.endsWith(digits)) return true;
  const left = brazilCore(digits);
  const right = brazilCore(wanted);
  return Boolean(left && right && left === right);
}

function apiError(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const raw = payload.message || payload.reason || payload.error || '';
  if (typeof raw === 'boolean' || String(raw).trim().toLowerCase() === 'true') {
    return 'a instância recusou a criação';
  }
  return String(raw).trim();
}

export function instanceOwnerPhone(payload) {
  const status = payload?.instance || payload?.status || payload || {};
  const raw = status.owner || status.jid || payload?.owner || '';
  return String(raw).replace(/\D/g, '');
}

export function leonaPayStaffPhones({ maxPhone, alexPhone = LEONA_PAY_ALEX_PHONE, creatorPhone = '' } = {}) {
  const phones = [];
  for (const phone of [maxPhone, alexPhone]) {
    const digits = phoneDigits(phone);
    if (!digits) continue;
    if (creatorPhone && mentionsPhone(creatorPhone, digits)) continue;
    if (phones.some((current) => mentionsPhone(current, digits))) continue;
    phones.push(digits);
  }
  return phones;
}

async function connectedOwnerPhone(api) {
  if (!api || typeof api.get !== 'function') return '';
  try {
    const status = await api.get('/instance/status');
    return instanceOwnerPhone(status?.payload);
  } catch {
    return '';
  }
}

export function leonaPayApi(env = process.env) {
  return defaultClient(leonaPayGroupConfig(env));
}

export async function assertOurWhatsappInstance(api) {
  if (!api || typeof api.get !== 'function') {
    return { ok: false, reason: 'não foi possível confirmar a instância' };
  }
  const status = await api.get('/instance/status');
  const ready = whatsappInstanceReady(status?.payload);
  if (!status?.httpOk || !ready.ok) {
    return { ok: false, reason: ready.reason || 'instância do WhatsApp não é a nossa' };
  }
  return { ok: true, owner: ready.owner };
}

export function whatsappInstanceReady(payload) {
  const instance = payload?.instance && typeof payload.instance === 'object' ? payload.instance : {};
  const owner = instanceOwnerPhone(payload);
  const rawState = instance.status ?? instance.state;
  const state = typeof rawState === 'string' ? rawState.toLowerCase() : '';
  if (!owner || mentionsPhone(owner, DEFAULT_LEONA_PAY_MAX_PHONE)) {
    return { ok: false, reason: 'instância do WhatsApp não é a nossa' };
  }
  if (state && state !== 'connected') {
    return { ok: false, reason: 'WhatsApp desconectado' };
  }
  return { ok: true, owner };
}

function withGroupJid(groupJid, extra = {}) {
  return { groupJid, groupjid: groupJid, ...extra };
}

let cachedImage = '';

function readGroupPhoto() {
  return readFileSync(join(process.cwd(), 'lib', 'leona-pay-group.jpg'));
}

export function leonaPayGroupImageDataUri() {
  if (cachedImage) return cachedImage;
  const buf = readGroupPhoto();
  cachedImage = `data:image/jpeg;base64,${buf.toString('base64')}`;
  return cachedImage;
}

function defaultClient(config) {
  const headers = {
    token: config.token,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  return {
    async post(path, body) {
      const res = await fetch(`${config.url}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      const payload = await res.json().catch(() => ({}));
      return { httpOk: res.ok, status: res.status, payload };
    },
    async get(path) {
      const res = await fetch(`${config.url}${path}`, { headers });
      const payload = await res.json().catch(() => ({}));
      return { httpOk: res.ok, status: res.status, payload };
    }
  };
}

function topicBelongsToCompany(topic, { businessId, email }) {
  const text = String(topic || '');
  if (businessId && text.includes(businessId)) return true;
  const mail = String(email || '').trim().toLowerCase();
  return Boolean(mail) && text.toLowerCase().includes(mail);
}

async function findExistingGroup(client, { groupName, businessId, email }) {
  const listed = await client.post('/group/list', {
    search: groupName,
    limit: 50,
    noParticipants: true
  });
  if (!listed.httpOk) return null;
  const want = normalizeGroupTitle(groupName);
  const named = listGroups(listed.payload).filter((group) => normalizeGroupTitle(groupTitleOf(group)) === want);
  for (const group of named) {
    const jid = groupJidOf(group);
    if (!jid) continue;
    const info = await client.post('/group/info', withGroupJid(jid));
    const payload = info.payload?.group || info.payload || {};
    if (info.httpOk && topicBelongsToCompany(payload.Topic || payload.topic || '', { businessId, email })) {
      return { jid };
    }
  }
  return null;
}

function leadFromCreate(payload, phone) {
  const failed = Array.isArray(payload?.failed) ? payload.failed : [];
  if (failed.some((entry) => mentionsPhone(entry, phone))) {
    return { added: false, reason: 'WhatsApp não adicionou o cliente na criação' };
  }
  return { added: true, invited: false };
}

function leadFromUpdate(payload, phone) {
  const rows = payload?.groupUpdated || payload?.participants || [];
  const row = (Array.isArray(rows) ? rows : []).find((entry) => mentionsPhone(entry, phone));
  if (!row) return { added: false, reason: apiError(payload) || 'WhatsApp não confirmou o cliente' };
  if (Number(row.Error || 0) === 0) return { added: true, invited: false };
  const request = row.AddRequest || row.addRequest || null;
  if (Number(row.Error) === 403 && request?.Code) {
    return {
      added: false,
      invite: { code: request.Code, expiration: request.Expiration || request.expiration || null }
    };
  }
  return { added: false, reason: `WhatsApp recusou o cliente (${row.Error})` };
}

function participantOk(payload, phone) {
  const rows = payload?.groupUpdated || [];
  if (!Array.isArray(rows) || !rows.length) return true;
  const row = rows.find((entry) => mentionsPhone(entry, phone));
  if (!row) return true;
  return Number(row.Error || 0) === 0;
}

function listedParticipants(payload) {
  const group = payload?.group || payload;
  if (!group || typeof group !== 'object') return null;
  const list = group.Participants || group.participants;
  return Array.isArray(list) ? list : null;
}

function groupInfoHasPhone(payload, phone) {
  const list = listedParticipants(payload);
  return (list || []).some((row) => (
    mentionsPhone(row?.PhoneNumber || row?.PN || row?.JID || row?.jid || row, phone)
  ));
}

function rowIsAdmin(row) {
  if (!row || typeof row !== 'object') return false;
  return row.IsAdmin === true || row.IsSuperAdmin === true || row.isAdmin === true;
}

function infoTracksAdmins(payload) {
  return (listedParticipants(payload) || []).some((row) => (
    row && typeof row === 'object' && ('IsAdmin' in row || 'IsSuperAdmin' in row)
  ));
}

async function ensureStaffAdmins(api, groupJid, phones) {
  if (!phones.length) return { ok: true };
  const before = await api.post('/group/info', withGroupJid(groupJid));
  const beforeList = before.httpOk ? listedParticipants(before.payload) : null;
  if (beforeList) {
    const missing = phones.filter((phone) => !beforeList.some((row) => mentionsPhone(row, phone)));
    if (missing.length) {
      const added = await api.post('/group/updateParticipants', withGroupJid(groupJid, {
        action: 'add',
        participants: missing
      }));
      if (!added.httpOk) {
        return { ok: false, reason: apiError(added.payload) || 'não foi possível adicionar o Max' };
      }
    }
  }
  const promote = await api.post('/group/updateParticipants', withGroupJid(groupJid, {
    action: 'promote',
    participants: phones
  }));
  if (!promote.httpOk) {
    return { ok: false, reason: apiError(promote.payload) || 'não foi possível promover os admins' };
  }
  const after = await api.post('/group/info', withGroupJid(groupJid));
  const afterList = after.httpOk ? listedParticipants(after.payload) : null;
  if (afterList && infoTracksAdmins(after.payload)) {
    const missingAdmin = phones.filter((phone) => !rowIsAdmin(afterList.find((row) => mentionsPhone(row, phone))));
    if (missingAdmin.some((phone) => mentionsPhone(phone, DEFAULT_LEONA_PAY_MAX_PHONE))) {
      return { ok: false, reason: 'não foi possível colocar o Max como admin' };
    }
    if (missingAdmin.length) {
      return { ok: false, reason: 'não foi possível colocar o Alex como admin' };
    }
  } else if (phones.some((phone) => !participantOk(promote.payload, phone))) {
    const failed = phones.filter((phone) => !participantOk(promote.payload, phone));
    const reason = failed.some((phone) => mentionsPhone(phone, DEFAULT_LEONA_PAY_MAX_PHONE))
      ? 'não foi possível colocar o Max como admin'
      : 'não foi possível colocar o Alex como admin';
    return { ok: false, reason };
  }
  return { ok: true };
}

async function inviteLeadPrivately(api, { groupJid, phone, invite }) {
  let inviteLink = '';
  if (typeof api.get === 'function') {
    const link = await api.get(`/group/invitelink/${encodeURIComponent(groupJid)}`);
    inviteLink = link.payload?.inviteLink || link.payload?.invite_link || '';
    if (link.httpOk && inviteLink) {
      const text = await api.post('/send/text', {
        number: phone,
        text: leonaPayPrivateInviteText(inviteLink)
      });
      if (text.httpOk) return { invited: true, reason: null };
    }
  }
  if (invite?.code) {
    const card = await api.post('/send/group-invite', {
      number: phone,
      groupjid: groupJid,
      groupJid,
      code: invite.code,
      expiration: invite.expiration,
      text: inviteLink
        ? leonaPayPrivateInviteText(inviteLink)
        : 'Opa, sua conta no Leona Pay foi aprovada!\n\n' + LEONA_PAY_WELCOME_TEXT
    });
    if (card.httpOk) return { invited: true, reason: null };
  }
  if (!inviteLink) {
    return { invited: false, reason: 'não achei o link do grupo' };
  }
  return { invited: false, reason: 'convite não enviado' };
}

async function sendGroupWelcome(api, groupJid) {
  const sent = await api.post('/send/text', {
    number: groupJid,
    text: LEONA_PAY_WELCOME_TEXT
  });
  return sent.httpOk;
}

export async function createLeonaPayGroup(body, {
  env = process.env,
  client = null,
  image = null,
  phone = null,
  skipInstanceCheck = false
} = {}) {
  const parsed = parseApprovedBusiness(body);
  if (!parsed.ok) return parsed;
  if (!parsed.phone && phone) {
    const extra = normalizeLeadPhone(phone, 'BR');
    if (extra.ok) {
      parsed.phone = extra.phone;
      parsed.phoneError = null;
    }
  }

  const config = leonaPayGroupConfig(env);
  if (!config.url || !config.token || !config.maxPhone) {
    return { ok: false, reason: 'instância do WhatsApp sem credencial', groupName: parsed.groupName };
  }

  const api = client || defaultClient(config);
  if (!skipInstanceCheck) {
    const instance = await assertOurWhatsappInstance(api);
    if (!instance.ok) {
      return { ok: false, reason: instance.reason, step: 'instance', groupName: parsed.groupName };
    }
  }
  const creatorPhone = await connectedOwnerPhone(api);
  const staff = leonaPayStaffPhones({ maxPhone: config.maxPhone, creatorPhone });
  const alexPhone = phoneDigits(LEONA_PAY_ALEX_PHONE);
  const alexIsCreator = Boolean(creatorPhone && mentionsPhone(creatorPhone, alexPhone));
  const existing = await findExistingGroup(api, parsed);
  let groupJid = existing?.jid || null;
  let created = false;
  let lead = parsed.phone
    ? { added: false, reason: null }
    : { added: false, reason: parsed.phoneError };

  if (!groupJid) {
    const participants = staff.length ? [...staff] : [config.maxPhone];
    if (
      parsed.phone
      && !participants.some((phone) => mentionsPhone(phone, parsed.phone))
      && !(creatorPhone && mentionsPhone(creatorPhone, parsed.phone))
    ) participants.push(parsed.phone);
    const createdRes = await api.post('/group/create', {
      name: parsed.groupName,
      participants
    });
    groupJid = groupJidOf(createdRes.payload?.group || createdRes.payload);
    if (!createdRes.httpOk || !groupJid) {
      const reason = apiError(createdRes.payload) || 'não foi possível criar o grupo';
      const invalidLead = /no valid WhatsApp participants/i.test(reason) && parsed.phone;
      if (!invalidLead) {
        return { ok: false, reason, groupName: parsed.groupName, step: 'create' };
      }
      const retry = await api.post('/group/create', {
        name: parsed.groupName,
        participants: staff.length ? staff : [config.maxPhone]
      });
      groupJid = groupJidOf(retry.payload?.group || retry.payload);
      if (!retry.httpOk || !groupJid) {
        return {
          ok: false,
          reason: apiError(retry.payload) || reason,
          groupName: parsed.groupName,
          step: 'create'
        };
      }
      created = true;
      lead = { added: false, reason: 'WhatsApp não adicionou o cliente na criação' };
    } else {
      created = true;
      if (parsed.phone) {
        lead = leadFromCreate(createdRes.payload, parsed.phone);
        lead.justAdded = lead.added;
      }
    }
  }

  if (parsed.phone && lead.added) {
    const info = await api.post('/group/info', withGroupJid(groupJid));
    if (info.httpOk && !groupInfoHasPhone(info.payload, parsed.phone)) {
      lead = { added: false, justAdded: false, reason: 'WhatsApp não confirmou o cliente no grupo' };
    }
  }

  const description = await api.post('/group/updateDescription', withGroupJid(groupJid, {
    description: leonaPayGroupDescription(parsed)
  }));
  let picture = { httpOk: false, payload: {} };
  try {
    picture = await api.post('/group/updateImage', withGroupJid(groupJid, {
      image: image || leonaPayGroupImageDataUri()
    }));
  } catch (error) {
    picture = { httpOk: false, payload: { error: error.message } };
  }
  const admins = await ensureStaffAdmins(api, groupJid, staff.length ? staff : [config.maxPhone]);
  if (!admins.ok) {
    return {
      ok: false,
      reason: admins.reason,
      groupJid,
      groupName: parsed.groupName,
      step: 'admins'
    };
  }
  const alexAdmin = alexIsCreator || staff.some((phone) => mentionsPhone(phone, alexPhone));

  if (parsed.phone && !lead.added) {
    const added = await api.post('/group/updateParticipants', withGroupJid(groupJid, {
      action: 'add',
      participants: [parsed.phone]
    }));
    lead = added.httpOk
      ? leadFromUpdate(added.payload, parsed.phone)
      : { added: false, reason: apiError(added.payload) || 'não foi possível adicionar o cliente' };
    if (lead.added) lead.justAdded = true;
    if (!lead.added) {
      const info = await api.post('/group/info', withGroupJid(groupJid));
      if (info.httpOk && groupInfoHasPhone(info.payload, parsed.phone)) {
        lead = { added: true, justAdded: false, invited: false };
      }
    }
    if (!lead.added) {
      const invite = await inviteLeadPrivately(api, {
        groupJid,
        phone: parsed.phone,
        invite: lead.invite
      });
      lead = { added: false, justAdded: false, invited: invite.invited, reason: invite.reason };
    }
  }

  let welcomeSent = false;
  if (lead.added && lead.justAdded) {
    try {
      welcomeSent = await sendGroupWelcome(api, groupJid);
    } catch {
      welcomeSent = false;
    }
  }

  return {
    ok: true,
    created,
    reused: !created,
    groupJid,
    groupName: parsed.groupName,
    businessId: parsed.businessId,
    email: parsed.email,
    description: description.httpOk,
    image: picture.httpOk,
    maxAdmin: mentionsPhone(creatorPhone, config.maxPhone) || staff.some((phone) => mentionsPhone(phone, config.maxPhone)),
    alexAdmin,
    leadAdded: Boolean(lead.added),
    leadInvited: Boolean(lead.invited),
    welcomeSent,
    leadReason: lead.added ? null : (lead.reason || null)
  };
}
