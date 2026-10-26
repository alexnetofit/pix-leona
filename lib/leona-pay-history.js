import { timingSafeStringEqual } from './paddle-session.js';
import { leonaPayGroupName } from './leona-pay-group.js';
import {
  LEONA_PAY_QUEUE_ACTION,
  withinLeonaPaySendWindow
} from './leona-pay-group-queue.js';

const ADDRESS_KEYS = ['street', 'number', 'complement', 'district', 'neighborhood', 'city', 'state', 'zipCode', 'zip', 'cep'];

export function historyTokenMatches(provided, expected) {
  const token = String(provided || '');
  const secret = String(expected || '');
  if (token.length < 20 || secret.length < 20) return false;
  return timingSafeStringEqual(token, secret);
}

export function formatBrasilia(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function text(value) {
  return String(value || '').trim();
}

function formatAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();
  if (typeof address !== 'object') return '';
  return ADDRESS_KEYS
    .map((key) => text(address[key]))
    .filter(Boolean)
    .join(', ');
}

function identityOf(row, payload) {
  const business = payload.business && typeof payload.business === 'object' ? payload.business : {};
  const owner = payload.owner && typeof payload.owner === 'object' ? payload.owner : {};
  const name = text(owner.name);
  return {
    name,
    email: text(owner.email || row.email).toLowerCase(),
    phone: text(owner.phone),
    company: {
      id: text(business.id || row.account_id),
      tradeName: text(business.tradeName),
      legalName: text(business.legalName),
      country: text(business.country),
      taxId: text(business.taxId),
      createdAt: text(business.createdAt),
      address: formatAddress(business.address)
    },
    groupName: text(payload.groupName) || leonaPayGroupName(name)
  };
}

function outcomeOf(details, action) {
  const result = details.result && typeof details.result === 'object' ? details.result : {};
  const error = text(details.lastError || result.reason);
  if (action === LEONA_PAY_QUEUE_ACTION.processing || details.status === 'processing') {
    return { outcome: 'creating', label: 'Criando agora', reason: 'O grupo está sendo aberto neste momento.' };
  }
  if (action === LEONA_PAY_QUEUE_ACTION.pending || details.status === 'pending') {
    return {
      outcome: 'queued',
      label: 'Na fila',
      reason: error ? `Vai tentar de novo. ${error}` : 'Aguardando a vez.'
    };
  }
  if (action === LEONA_PAY_QUEUE_ACTION.failed || details.status === 'failed' || result.ok === false) {
    return { outcome: 'failed', label: 'Não deu certo', reason: error || 'Não foi possível criar o grupo.' };
  }
  if (!result.groupJid) {
    return { outcome: 'failed', label: 'Não deu certo', reason: error || 'A criação não devolveu o grupo.' };
  }
  if (result.leadAdded) {
    const reused = result.reused ? 'O grupo já existia e foi reaproveitado. ' : '';
    return { outcome: 'ok', label: 'Deu certo', reason: `${reused}O cliente entrou no grupo.`.trim() };
  }
  if (result.leadInvited) {
    return {
      outcome: 'partial',
      label: 'Grupo criado, convite enviado',
      reason: 'O WhatsApp não deixou adicionar o cliente. O convite foi no privado.'
    };
  }
  return {
    outcome: 'partial',
    label: 'Grupo criado, cliente não entrou',
    reason: text(result.leadReason) || 'O WhatsApp não adicionou o cliente.'
  };
}

export function historyFromQueueRow(row) {
  const details = row?.details && typeof row.details === 'object' ? row.details : {};
  const payload = details.payload && typeof details.payload === 'object' ? details.payload : {};
  const result = details.result && typeof details.result === 'object' ? details.result : {};
  const identity = identityOf(row, payload);
  const explained = outcomeOf(details, row.action);
  return {
    id: row.id || null,
    at: row.created_at || null,
    when: formatBrasilia(row.created_at),
    attempts: Number(details.attempts || 0),
    groupJid: text(result.groupJid || details.groupJid),
    groupName: text(result.groupName) || identity.groupName,
    welcomeSent: Boolean(result.welcomeSent),
    maxAdmin: result.maxAdmin !== false,
    descriptionSaved: result.description !== false,
    imageSaved: result.image !== false,
    ...identity,
    ...explained
  };
}

function historyFromWebhook(row) {
  const details = row?.details && typeof row.details === 'object' ? row.details : {};
  const group = details.group && typeof details.group === 'object' ? details.group : null;
  const payload = details.body && typeof details.body === 'object' ? details.body : {};
  if (!group || group.queued || payload.event !== 'business.approved') return null;
  const identity = identityOf(row, payload);
  if (group.ok && group.jid) {
    const leadAdded = Boolean(group.leadAdded);
    return {
      id: row.id || null,
      at: row.created_at || null,
      when: formatBrasilia(row.created_at),
      attempts: 1,
      groupJid: text(group.jid),
      groupName: text(group.name) || identity.groupName,
      welcomeSent: false,
      maxAdmin: group.maxAdmin !== false,
      descriptionSaved: group.description !== false,
      imageSaved: group.image !== false,
      ...identity,
      outcome: leadAdded ? 'ok' : (group.leadInvited ? 'partial' : 'partial'),
      label: leadAdded ? 'Deu certo' : (group.leadInvited ? 'Grupo criado, convite enviado' : 'Grupo criado, cliente não entrou'),
      reason: leadAdded
        ? 'O cliente entrou no grupo.'
        : (group.leadInvited
          ? 'O WhatsApp não deixou adicionar o cliente. O convite foi no privado.'
          : (text(group.leadReason) || 'O WhatsApp não adicionou o cliente.'))
    };
  }
  if (group.ok === false || group.reason) {
    return {
      id: row.id || null,
      at: row.created_at || null,
      when: formatBrasilia(row.created_at),
      attempts: 1,
      groupJid: '',
      groupName: identity.groupName,
      welcomeSent: false,
      maxAdmin: false,
      descriptionSaved: false,
      imageSaved: false,
      ...identity,
      outcome: 'failed',
      label: 'Não deu certo',
      reason: text(group.reason) || 'Não foi possível criar o grupo.'
    };
  }
  return null;
}

function sameAccount(left, right) {
  if (left.company.id && right.company.id && left.company.id === right.company.id) return true;
  return Boolean(left.email && right.email && left.email === right.email);
}

export function nextQueueLabel({ now, windowOpen, nextEligibleAt }) {
  if (!windowOpen) return 'Parado até 6h';
  const at = Date.parse(nextEligibleAt || '');
  if (!Number.isFinite(at) || at <= now.getTime()) return 'O próximo pode sair agora';
  return `Próximo depois das ${formatBrasilia(nextEligibleAt)}`;
}

export function buildLeonaPayBoard({ queueRows = [], webhookRows = [], now = new Date() } = {}) {
  const state = queueRows.find((row) => row.action === LEONA_PAY_QUEUE_ACTION.state) || null;
  const fromQueue = queueRows
    .filter((row) => row.action && row.action !== LEONA_PAY_QUEUE_ACTION.state && String(row.action).startsWith('leona_pay_group_'))
    .map(historyFromQueueRow);
  const seen = fromQueue.slice();
  const fromWebhook = [];
  for (const row of webhookRows) {
    const item = historyFromWebhook(row);
    if (!item) continue;
    if (seen.some((current) => sameAccount(current, item))) continue;
    fromWebhook.push(item);
    seen.push(item);
  }
  const history = [...fromQueue, ...fromWebhook].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const waiting = fromQueue
    .filter((item) => item.outcome === 'queued' || item.outcome === 'creating')
    .sort((a, b) => {
      if (a.outcome !== b.outcome) return a.outcome === 'creating' ? -1 : 1;
      return String(a.at).localeCompare(String(b.at));
    });
  let place = 0;
  const queue = waiting.map((item) => {
    if (item.outcome === 'creating') return { ...item, position: 0 };
    place += 1;
    return { ...item, position: place };
  });
  const counts = {
    queued: history.filter((item) => item.outcome === 'queued').length,
    creating: history.filter((item) => item.outcome === 'creating').length,
    ok: history.filter((item) => item.outcome === 'ok').length,
    partial: history.filter((item) => item.outcome === 'partial').length,
    failed: history.filter((item) => item.outcome === 'failed').length
  };
  const windowOpen = withinLeonaPaySendWindow(now);
  const nextEligibleAt = state?.details?.nextEligibleAt || null;
  return {
    updatedAt: formatBrasilia(now),
    windowOpen,
    windowLabel: 'Das 6h à meia-noite, horário de Brasília',
    nextEligibleAt,
    nextLabel: nextQueueLabel({ now, windowOpen, nextEligibleAt }),
    counts,
    queue,
    history
  };
}
