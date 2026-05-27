/**
 * api/support-action.js — CRUD da fila de aprovacao de suporte.
 *
 *   POST /api/support-action  -> Suporte cria pendencia (cancel/refund)
 *   GET  /api/support-action  -> Admin lista pendencias (filtra por status)
 *
 * Auth: TOKEN_ADMIN (Bearer) — mesmo token serve pra criar e listar.
 *
 * Persistencia: tabela public.support_actions no Supabase (Afiliados Leona).
 *
 * O POST NAO executa cancel/refund, so registra. Execucao real acontece
 * em /api/support-action-decision quando o admin aprova.
 */

import { applyCors, requireAdmin, enforceAuth } from '../lib/auth.js';
import { sbInsert, sbSelect, sbConfigured } from '../lib/supabase.js';

const VALID_TYPES = new Set(['cancel_subscription', 'refund_transaction']);
const MAX_REASON_LEN = 1000;

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const auth = requireAdmin(req);
  if (enforceAuth(req, res, auth, { route: `/api/support-action:${req.method}` })) return;

  if (!sbConfigured()) {
    return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurado' });
  }

  if (req.method === 'POST') return createAction(req, res);
  if (req.method === 'GET') return listActions(req, res);
  return res.status(405).json({ error: 'Método não permitido' });
}

async function createAction(req, res) {
  const {
    type,
    target_email,
    target_account_id,
    guru_subscription_id,
    guru_transaction_id,
    guru_invoice_id,
    reason,
    snapshot
  } = req.body || {};

  if (!VALID_TYPES.has(type)) {
    return res.status(400).json({ error: `type invalido. Use: ${[...VALID_TYPES].join(', ')}` });
  }
  const emailClean = target_email ? String(target_email).trim().toLowerCase() : '';
  if (!emailClean) return res.status(400).json({ error: 'target_email obrigatorio' });

  const reasonClean = (reason || '').toString().trim().slice(0, MAX_REASON_LEN);
  if (!reasonClean) return res.status(400).json({ error: 'reason obrigatorio' });

  // Validacao especifica por tipo: cancel exige subscription_id, refund
  // exige transaction_id.
  if (type === 'cancel_subscription' && !guru_subscription_id) {
    return res.status(400).json({ error: 'guru_subscription_id obrigatorio pra cancel_subscription' });
  }
  if (type === 'refund_transaction' && !guru_transaction_id) {
    return res.status(400).json({ error: 'guru_transaction_id obrigatorio pra refund_transaction' });
  }

  try {
    const row = await sbInsert('support_actions', {
      type,
      target_email: emailClean,
      target_account_id: target_account_id || null,
      guru_subscription_id: guru_subscription_id || null,
      guru_transaction_id: guru_transaction_id || null,
      guru_invoice_id: guru_invoice_id || null,
      reason: reasonClean,
      snapshot: snapshot || {},
      status: 'pending',
      created_by_ip: clientIp(req)
    });

    return res.status(201).json({ ok: true, action: row });
  } catch (e) {
    console.error('support-action POST erro:', e);
    return res.status(500).json({ error: e.message });
  }
}

async function listActions(req, res) {
  const status = req.query?.status ? String(req.query.status).trim() : '';
  const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 100));

  const query = {
    order: 'created_at.desc',
    limit
  };
  if (status) query.eq = { status };

  try {
    const rows = await sbSelect('support_actions', query);
    return res.status(200).json({ items: rows, count: rows.length });
  } catch (e) {
    console.error('support-action GET erro:', e);
    return res.status(500).json({ error: e.message });
  }
}
