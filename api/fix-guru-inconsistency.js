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
import { updateLeonaBillingProfile, assertAccountAccess } from '../lib/leona.js';
import { applyCors } from '../lib/auth.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
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

  // Anti-IDOR: ID numerico legado exige email + match. UUID passa direto.
  const access = await assertAccountAccess({
    accountId: account_id,
    queryEmail: email,
    leonaToken,
    route: '/api/fix-guru-inconsistency'
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const result = {
    ok: true,
    email: email || null,
    account_id,
    guru_subscription_id,
    guru_cancelled: null,
    leona_unlinked: null
  };

  // 0. Trava de seguranca: antes de cancelar, busca a sub na Guru e
  //    valida que o cancelamento faz sentido. Protege contra:
  //    - clientes recem-comprados (race condition do webhook)
  //    - subs com ciclo atual valido (pagamento em curso, nao e divergencia)
  //    - subs ja inativas/canceladas (nada a cancelar)
  //
  //    Esses casos foram mapeados depois do incidente da cliente
  //    claricinhademelo2@gmail.com (2026-05-09): a sub foi paga, o webhook
  //    falhou em ativar a Leona, e o front cancelou a sub achando que era
  //    "data divergente" — efetivamente jogando fora um pagamento aprovado.
  let guruSubData = null;
  try {
    const r = await fetch(
      `https://digitalmanager.guru/api/v2/subscriptions/${encodeURIComponent(guru_subscription_id)}`,
      {
        headers: {
          'Authorization': `Bearer ${guruToken}`,
          'Accept': 'application/json',
          'User-Agent': 'n8n'
        }
      }
    );
    if (r.ok) {
      guruSubData = await r.json();
    } else {
      console.error(`fix-guru-inconsistency: nao foi possivel buscar sub Guru ${guru_subscription_id} (status ${r.status})`);
      return res.status(503).json({
        error: `nao foi possivel validar a sub Guru antes de cancelar (Guru retornou ${r.status})`
      });
    }
  } catch (e) {
    console.error(`fix-guru-inconsistency: erro buscando sub Guru ${guru_subscription_id}: ${e.message}`);
    return res.status(503).json({
      error: `nao foi possivel validar a sub Guru antes de cancelar: ${e.message}`
    });
  }

  if (guruSubData.last_status !== 'active') {
    console.log(`fix-guru-inconsistency: sub ${guru_subscription_id} nao esta ativa (status=${guruSubData.last_status}), abortando cancelamento`);
    return res.status(409).json({
      error: `sub Guru nao esta ativa (status=${guruSubData.last_status}) — nada a cancelar`,
      guru_status: guruSubData.last_status
    });
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const cycleEnd = guruSubData.cycle_end_date || null;
  if (cycleEnd && cycleEnd >= todayStr) {
    console.log(`fix-guru-inconsistency: sub ${guru_subscription_id} com ciclo valido (cycle_end=${cycleEnd}, hoje=${todayStr}), abortando cancelamento`);
    return res.status(409).json({
      error: `ciclo Guru ainda valido (cycle_end=${cycleEnd}, hoje=${todayStr}) — nao e data divergente, cancelamento abortado`,
      guru_cycle_end: cycleEnd,
      today: todayStr
    });
  }

  const startedAt = typeof guruSubData.started_at === 'number' ? guruSubData.started_at : null;
  if (startedAt) {
    const ageSeconds = Math.floor(Date.now() / 1000 - startedAt);
    if (ageSeconds < 600) {
      console.log(`fix-guru-inconsistency: sub ${guru_subscription_id} recem-criada (${ageSeconds}s atras), abortando cancelamento`);
      return res.status(409).json({
        error: `sub Guru recem-criada (${ageSeconds}s atras) — webhook ainda pode estar processando, cancelamento abortado`,
        guru_started_at: startedAt,
        age_seconds: ageSeconds
      });
    }
  }

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
