/**
 * Log de acessos/ações da /assinatura (Guru + Pagou).
 * Nunca lança: falha de log não pode quebrar checkout.
 */
import { sbConfigured, sbDeleteWhere, sbInsert, sbSelectWhere } from './supabase.js';

const MAX_DETAIL = 4000;
const RETENTION_MS = 48 * 60 * 60 * 1000;

function retentionCutoffIso() {
  return new Date(Date.now() - RETENTION_MS).toISOString();
}

export async function purgeAssinaturaLogs() {
  if (!sbConfigured()) return;
  await sbDeleteWhere('assinatura_access_logs', { lt: { created_at: retentionCutoffIso() } });
}

function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'] || req?.headers?.['x-real-ip'] || '';
  const first = String(forwarded).split(',')[0].trim();
  return first || req?.socket?.remoteAddress || null;
}

function clipDetails(details) {
  if (details == null) return {};
  if (typeof details !== 'object') return { value: String(details).slice(0, 500) };
  try {
    const raw = JSON.stringify(details);
    if (raw.length <= MAX_DETAIL) return details;
    return { truncated: true, preview: raw.slice(0, MAX_DETAIL) };
  } catch {
    return {};
  }
}

export async function logAssinaturaEvent(req, event = {}) {
  if (!sbConfigured()) return null;
  const action = String(event.action || '').trim().slice(0, 80);
  if (!action) return null;
  const provider = String(event.provider || 'guru').trim().toLowerCase().slice(0, 32);
  try {
    purgeAssinaturaLogs().catch(() => {});
    return await sbInsert('assinatura_access_logs', {
      action,
      provider: provider || 'guru',
      email: event.email ? String(event.email).trim().toLowerCase().slice(0, 320) : null,
      account_id: event.account_id != null ? String(event.account_id).trim().slice(0, 80) : null,
      details: clipDetails(event.details),
      ip: clientIp(req),
      user_agent: String(req?.headers?.['user-agent'] || '').slice(0, 400) || null
    });
  } catch (err) {
    console.error('assinatura-log: falha ao gravar', err.message);
    return null;
  }
}

export async function listAssinaturaLogs({ email, account_id, provider, limit = 150 } = {}) {
  await purgeAssinaturaLogs().catch(() => {});
  const query = {
    select: 'id,created_at,action,provider,email,account_id,details,ip,user_agent',
    order: 'created_at.desc',
    limit: Math.min(Math.max(Number(limit) || 150, 1), 400),
    gte: { created_at: retentionCutoffIso() }
  };
  if (email) query.ilike = { ...(query.ilike || {}), email: `%${email}%` };
  if (account_id) query.eq = { ...(query.eq || {}), account_id: String(account_id) };
  if (provider) query.eq = { ...(query.eq || {}), provider: String(provider) };
  return sbSelectWhere('assinatura_access_logs', query);
}
