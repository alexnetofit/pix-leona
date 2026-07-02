import { applyCors } from '../lib/auth.js';
import { updateLeonaBillingProfile, assertAccountAccess } from '../lib/leona.js';

const GURU_BASE = 'https://digitalmanager.guru/api/v2';

const GURU_HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'n8n'
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Guru gera a fatura de upgrade de forma ASSINCRONA logo apos o PUT /plans.
// Se lermos o current_invoice imediatamente, ele ainda aponta pra fatura
// anterior (do ciclo, ja paga) — e o app acabava mostrando o link dela.
// Aqui fazemos polling ate aparecer uma fatura em aberto (nao paga).
async function fetchFreshInvoice(subscription_id, headers, { tries = 6, delayMs = 800 } = {}) {
  let lastSubData = null;
  for (let i = 0; i < tries; i++) {
    const subRes = await fetch(`${GURU_BASE}/subscriptions/${subscription_id}`, { headers });
    if (subRes.ok) {
      const subData = await subRes.json();
      lastSubData = subData;
      const ci = subData.current_invoice;
      if (ci && ci.status !== 'paid') {
        return { subData, invoice: ci };
      }
    }
    if (i < tries - 1) await sleep(delayMs);
  }
  return { subData: lastSubData, invoice: null };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const guruToken = process.env.GURU_TOKEN;
  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });

  const { subscription_id, offer_id, sync_leona } = req.body || {};
  if (!subscription_id || !offer_id) {
    return res.status(400).json({ error: 'subscription_id e offer_id são obrigatórios' });
  }

  // Anti-IDOR: se vier sync_leona, validamos acesso antes de fazer
  // QUALQUER coisa (inclusive o upgrade Guru), pra evitar que atacante
  // dispare upgrade pra conta alheia.
  let validatedSyncLeona = null;
  if (sync_leona && sync_leona.account_id && Number.isFinite(Number(sync_leona.starter_instances))) {
    const leonaToken = process.env.LEONA_BILLING_TOKEN;
    if (!leonaToken) {
      return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });
    }
    const access = await assertAccountAccess({
      accountId: sync_leona.account_id,
      queryEmail: sync_leona.email,
      leonaToken,
      route: '/api/guru-upgrade'
    });
    if (!access.ok) return res.status(access.status).json(access.body);
    validatedSyncLeona = {
      account_id: String(sync_leona.account_id).trim(),
      starter_instances: Number(sync_leona.starter_instances),
      leonaToken
    };
  }

  const headers = GURU_HEADERS(guruToken);

  try {
    const upgradeRes = await fetch(`${GURU_BASE}/subscriptions/${subscription_id}/plans`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ offer_id })
    });

    const upgradeData = await upgradeRes.json().catch(() => ({}));

    if (!upgradeRes.ok) {
      return res.status(upgradeRes.status).json({
        success: false,
        error: upgradeData.message || upgradeData.error || `Erro ${upgradeRes.status} ao alterar plano`,
        details: upgradeData
      });
    }

    const { subData, invoice: ci } = await fetchFreshInvoice(subscription_id, headers);

    let invoice = null;
    let currentOfferId = null;
    if (subData) {
      currentOfferId = subData.current_offer?.id || subData.offer?.id || null;
      // So devolvemos link de pagamento se a fatura estiver EM ABERTO. Nunca
      // devolvemos uma fatura ja paga (evita mostrar o link da fatura antiga
      // do ciclo enquanto a Guru ainda nao gerou a fatura de upgrade).
      if (ci && ci.status !== 'paid') {
        invoice = {
          id: ci.id,
          status: ci.status,
          value: ci.value,
          type: ci.type,
          cycle: ci.cycle,
          charge_at: ci.charge_at,
          period_start: ci.period_start,
          period_end: ci.period_end,
          payment_url: ci.payment_url || null
        };
      }
    }

    let leonaSync = null;
    if (validatedSyncLeona) {
      const result = await updateLeonaBillingProfile(
        validatedSyncLeona.account_id,
        { starter_instances: validatedSyncLeona.starter_instances },
        validatedSyncLeona.leonaToken
      );
      leonaSync = {
        ok: result.ok,
        account_id: validatedSyncLeona.account_id,
        starter_instances: validatedSyncLeona.starter_instances,
        error: result.ok ? null : (result.body?.error || result.error || `HTTP ${result.status || '?'}`)
      };
    }

    return res.status(200).json({
      success: true,
      subscription: upgradeData,
      invoice,
      current_offer_id: currentOfferId,
      leona_sync: leonaSync
    });

  } catch (error) {
    console.error('guru-upgrade error:', error);
    return res.status(500).json({ error: error.message });
  }
}
