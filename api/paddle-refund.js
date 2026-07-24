import { createRefundAdjustment, getTransaction } from '../lib/paddle-client.js';
import {
  appendPaddleBillingAuditLog,
  getPaddleBillingIntentByTransaction
} from '../lib/paddle-ledger.js';
import { refundDecision, transactionTotal } from '../lib/paddle-policy.js';
import { timingSafeStringEqual } from '../lib/paddle-session.js';

function authorized(req) {
  const expected = process.env.TOKEN_ADMIN || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const transactionId = String(req.body?.transaction_id || '');
    const reason = String(req.body?.reason || '').trim();
    if (!transactionId || !reason) {
      return res.status(400).json({ error: 'transaction_id e reason são obrigatórios' });
    }
    const transaction = await getTransaction(transactionId);
    const requestedAmount = req.body?.amount_cents ?? transactionTotal(transaction);
    const normalDecision = refundDecision({
      transaction,
      requestedAmount,
      approved: true
    });
    const override = req.body?.override;
    const overrideApproved = normalDecision.eligibility.reason === 'refund_window_expired'
      && override?.approved === true
      && String(override?.approved_by || '').trim()
      && String(override?.reason || '').trim();
    if (!normalDecision.approved && !overrideApproved) {
      return res.status(409).json({
        error: normalDecision.eligibility.reason === 'refund_window_expired'
          ? 'Reembolso fora da janela de 7 dias exige aprovação explícita e auditada'
          : 'Reembolso não permitido',
        decision: normalDecision
      });
    }

    const intent = await getPaddleBillingIntentByTransaction(transactionId);
    const accountId =
      transaction.custom_data?.leona_account_id ||
      transaction.custom_data?.account_id ||
      intent?.leona_account_id ||
      null;
    const transactionItemIds = new Set((transaction.items || []).map(item => item.id));
    let items;
    if (normalDecision.kind === 'full') {
      items = (transaction.items || []).map(item => ({ item_id: item.id, type: 'full' }));
    } else {
      items = Array.isArray(req.body?.items) ? req.body.items : [];
      const validPartialItems = items.length > 0 && items.every(item =>
        transactionItemIds.has(item.item_id)
        && item.type === 'partial'
        && Number.isInteger(Number(item.amount))
        && Number(item.amount) > 0
      );
      const itemAmount = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      if (!validPartialItems || itemAmount !== Number(requestedAmount)) {
        return res.status(400).json({
          error: 'Itens parciais devem pertencer à transação e somar exatamente amount_cents'
        });
      }
    }
    if (!items.length) {
      return res.status(400).json({ error: 'Itens do reembolso não encontrados' });
    }

    await appendPaddleBillingAuditLog({
      leona_account_id: accountId,
      actor_type: 'support',
      actor_id: String(override?.approved_by || req.body?.requested_by || 'admin'),
      action: overrideApproved ? 'refund_override_approved' : 'refund_within_window_approved',
      before_state: { transaction_status: transaction.status },
      after_state: {
        requested_amount: Number(requestedAmount),
        kind: normalDecision.kind
      },
      metadata: {
        transaction_id: transactionId,
        reason,
        eligibility: normalDecision.eligibility,
        override_reason: overrideApproved ? override.reason : null
      }
    });

    const adjustment = await createRefundAdjustment({
      transactionId,
      reason,
      items,
      customData: {
        leona_account_id: accountId,
        billing_intent_id: intent?.id || null,
        approved_outside_window: Boolean(overrideApproved)
      }
    });
    return res.status(200).json({
      adjustment_id: adjustment.id,
      status: adjustment.status,
      decision: {
        kind: normalDecision.kind,
        within_window: normalDecision.eligibility.eligible,
        override: Boolean(overrideApproved)
      }
    });
  } catch (error) {
    console.error('[paddle-refund]', error);
    const status = Number(error?.status);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: status >= 400 && status < 500
        ? 'A Paddle recusou o reembolso'
        : 'Falha ao solicitar reembolso'
    });
  }
}
