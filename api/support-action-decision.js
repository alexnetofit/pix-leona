/**
 * api/support-action-decision.js — Admin aprova ou rejeita pendencia.
 *
 *   POST /api/support-action-decision
 *     body: { id: uuid, decision: 'approve' | 'reject', note?: string }
 *
 * Auth: TOKEN_ADMIN (Bearer).
 *
 * Fluxo:
 *   reject  -> marca como 'rejected', nao executa nada
 *   approve -> marca como 'approved', executa cancel/refund Guru,
 *              vira 'executed' (sucesso) ou 'failed' (erro Guru).
 *
 * Idempotente por status: rejeita 409 se a row nao estiver 'pending'.
 */

import { applyCors, requireAdmin, enforceAuth } from '../lib/auth.js';
import { sbSelect, sbUpdate, sbConfigured } from '../lib/supabase.js';
import { cancelGuruSubscription, refundGuruTransaction, isPaidAtWithinRefundWindow, GURU_REFUND_WINDOW_DAYS } from '../lib/guru.js';

const VALID_DECISIONS = new Set(['approve', 'reject']);

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const auth = requireAdmin(req);
  if (enforceAuth(req, res, auth, { route: '/api/support-action-decision' })) return;

  if (!sbConfigured()) {
    return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurado' });
  }

  const { id, decision, note } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id obrigatorio' });
  if (!VALID_DECISIONS.has(decision)) {
    return res.status(400).json({ error: `decision invalido. Use: ${[...VALID_DECISIONS].join(', ')}` });
  }

  // Carrega a row pra checar status atual e pegar dados pra execucao
  let row;
  try {
    const rows = await sbSelect('support_actions', { eq: { id }, limit: 1 });
    row = rows[0];
  } catch (e) {
    console.error('support-action-decision: erro carregando row:', e);
    return res.status(500).json({ error: e.message });
  }
  if (!row) return res.status(404).json({ error: 'pendencia nao encontrada' });
  if (row.status !== 'pending') {
    return res.status(409).json({
      error: `pendencia ja foi ${row.status}, nao pode ser modificada`,
      current_status: row.status
    });
  }

  const ip = clientIp(req);
  const noteClean = (note || '').toString().trim().slice(0, 1000) || null;

  // ---- REJECT: simples, so atualiza status ----
  if (decision === 'reject') {
    try {
      const updated = await sbUpdate('support_actions', { id }, {
        status: 'rejected',
        decided_at: new Date().toISOString(),
        decided_by_ip: ip,
        decision_note: noteClean
      });
      return res.status(200).json({ ok: true, action: updated });
    } catch (e) {
      console.error('support-action-decision reject erro:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ---- APPROVE: marca approved, executa Guru, finaliza status ----

  // Marca approved primeiro pra evitar dupla execucao (race em cliques rapidos)
  let approved;
  try {
    approved = await sbUpdate('support_actions', { id }, {
      status: 'approved',
      decided_at: new Date().toISOString(),
      decided_by_ip: ip,
      decision_note: noteClean
    });
  } catch (e) {
    console.error('support-action-decision approve erro (mark):', e);
    return res.status(500).json({ error: e.message });
  }

  // Executa a acao na Guru
  const guruToken = process.env.GURU_TOKEN;
  if (!guruToken) {
    await sbUpdate('support_actions', { id }, {
      status: 'failed',
      executed_at: new Date().toISOString(),
      execution_result: { error: 'GURU_TOKEN nao configurado' }
    }).catch(() => {});
    return res.status(500).json({ error: 'GURU_TOKEN não configurado' });
  }

  let result;
  try {
    if (row.type === 'cancel_subscription') {
      result = await cancelGuruSubscription(row.guru_subscription_id, guruToken, {
        cancel_at_cycle_end: false,
        comment: row.reason || 'Cancelamento aprovado via /admin'
      });
    } else if (row.type === 'refund_transaction') {
      const snap = row.snapshot || {};
      const paidAt = snap.paid_at || snap.confirmed_at || null;
      if (!isPaidAtWithinRefundWindow(paidAt)) {
        const failed = await sbUpdate('support_actions', { id }, {
          status: 'failed',
          executed_at: new Date().toISOString(),
          execution_result: {
            error: `Reembolso fora do prazo de ${GURU_REFUND_WINDOW_DAYS} dias apos pagamento`
          }
        });
        return res.status(400).json({
          ok: false,
          error: `Reembolso permitido apenas ate ${GURU_REFUND_WINDOW_DAYS} dias apos o pagamento`,
          action: failed
        });
      }
      result = await refundGuruTransaction(row.guru_transaction_id, guruToken, {
        comment: row.reason || 'Reembolso aprovado via /admin'
      });
    } else {
      result = { ok: false, error: `type desconhecido: ${row.type}` };
    }
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  // Persiste resultado da execucao
  const finalStatus = result?.ok ? 'executed' : 'failed';
  try {
    const final = await sbUpdate('support_actions', { id }, {
      status: finalStatus,
      executed_at: new Date().toISOString(),
      execution_result: result || {}
    });
    return res.status(result?.ok ? 200 : 502).json({
      ok: !!result?.ok,
      action: final,
      execution_result: result
    });
  } catch (e) {
    console.error('support-action-decision: erro salvando exec result:', e);
    // Mesmo se falhar de salvar, devolve o estado real da execucao Guru
    return res.status(500).json({
      error: e.message,
      execution_result: result,
      action: approved
    });
  }
}
