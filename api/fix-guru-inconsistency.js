/**
 * fix-guru-inconsistency.js — auto-correção do "Cenário 3" da página /assinatura.
 *
 * Quando a Leona aparece como vencida mas a Guru ainda está ativa,
 * a data Guru está divergente. Esta rota:
 *
 *   1. Cancela a subscription Guru (imediato, sem cobrança futura).
 *   2. Limpa o guru_account_id da conta Leona, soltando o vínculo.
 *
 * Quando o cliente pagar um novo plano, o webhook-guru re-vincula
 * a nova subscription à mesma conta Leona automaticamente
 * (api/webhook-guru.js linhas 99-106).
 *
 * Recebe: { email, account_id, guru_subscription_id }
 * Retorna: { ok, guru_cancelled, leona_unlinked, ... }
 */

import { cancelGuruSubscription } from '../lib/guru.js';
import { updateLeonaBillingProfile } from '../lib/leona.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const guruToken = process.env.GURU_TOKEN;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!guruToken || !leonaToken) {
    return res.status(500).json({ error: 'GURU_TOKEN ou LEONA_BILLING_TOKEN não configurado' });
  }

  const { email, account_id, guru_subscription_id } = req.body || {};

  if (!account_id) {
    return res.status(400).json({ error: 'account_id é obrigatório' });
  }
  if (!guru_subscription_id) {
    return res.status(400).json({ error: 'guru_subscription_id é obrigatório' });
  }

  const result = {
    ok: true,
    email: email || null,
    account_id,
    guru_subscription_id,
    guru_cancelled: null,
    leona_unlinked: null
  };

  // 1. Cancela a sub Guru (imediato).
  try {
    const cancelRes = await cancelGuruSubscription(guru_subscription_id, guruToken, {
      cancel_at_cycle_end: false,
      comment: 'Inconsistencia Leona-Guru: data Guru divergente, sub cancelada para o cliente renovar'
    });
    result.guru_cancelled = {
      ok: cancelRes.ok,
      status: cancelRes.status || null,
      error: cancelRes.ok ? null : (cancelRes.body?.message || cancelRes.error || 'erro desconhecido')
    };
    if (!cancelRes.ok) result.ok = false;
  } catch (e) {
    result.guru_cancelled = { ok: false, error: e.message };
    result.ok = false;
  }

  // 2. Limpa o vínculo na Leona (independente do resultado da Guru —
  //    se a Guru já foi cancelada antes ou está num estado estranho,
  //    ainda assim queremos soltar o vínculo Leona pro próximo pagamento).
  try {
    let unlinkRes = await updateLeonaBillingProfile(
      account_id,
      { guru_account_id: null },
      leonaToken
    );
    // Fallback: alguns backends rejeitam null e exigem string vazia.
    if (!unlinkRes.ok) {
      unlinkRes = await updateLeonaBillingProfile(
        account_id,
        { guru_account_id: '' },
        leonaToken
      );
    }
    result.leona_unlinked = {
      ok: unlinkRes.ok,
      status: unlinkRes.status || null,
      error: unlinkRes.ok ? null : (unlinkRes.body?.error || unlinkRes.error || 'erro desconhecido')
    };
    if (!unlinkRes.ok) result.ok = false;
  } catch (e) {
    result.leona_unlinked = { ok: false, error: e.message };
    result.ok = false;
  }

  console.log('fix-guru-inconsistency:', JSON.stringify(result));

  return res.status(200).json(result);
}
