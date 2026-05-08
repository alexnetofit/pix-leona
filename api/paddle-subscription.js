import { findLeonaAccountByEmail, updateLeonaBillingProfile, getLeonaBillingProfile } from '../lib/leona.js';
import { findGuruActiveSubscriptionsByEmail, cancelGuruSubscription } from '../lib/guru.js';

const PADDLE_BASE = 'https://api.paddle.com';

function paddleHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

/**
 * Tenta resolver o email do customer da subscription, usado para localizar
 * a conta Leona quando o frontend não envia account_id explicitamente.
 */
async function fetchSubscriptionEmail(subscriptionId, paddleToken) {
  const headers = paddleHeaders(paddleToken);
  try {
    const subRes = await fetch(`${PADDLE_BASE}/subscriptions/${subscriptionId}`, { headers });
    if (!subRes.ok) return null;
    const subBody = await subRes.json();
    const customerId = subBody.data?.customer_id;
    if (!customerId) return null;

    const cusRes = await fetch(`${PADDLE_BASE}/customers/${customerId}`, { headers });
    if (!cusRes.ok) return null;
    const cusBody = await cusRes.json();
    return (cusBody.data?.email || '').toLowerCase().trim() || null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve o accountId Leona a partir de várias dicas: o caller pode mandar
 * um accountId direto, um email, ou nenhum dos dois (cai no lookup pelo
 * customer Paddle da subscription).
 */
async function resolveLeonaAccountId({ accountId, email, subscriptionId }, paddleToken, leonaToken) {
  if (accountId) return accountId;
  let useEmail = email;
  if (!useEmail && subscriptionId) {
    useEmail = await fetchSubscriptionEmail(subscriptionId, paddleToken);
  }
  if (!useEmail) return null;
  const match = await findLeonaAccountByEmail(useEmail, leonaToken);
  return match?.account_id || null;
}

/**
 * Soma a quantidade de instâncias dos itens da subscription.
 */
function sumInstances(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((acc, it) => acc + (Number(it.quantity) || 0), 0);
}

/**
 * Tabela de tiers da Leona Flow.
 *
 * Paddle Billing não tem tiered pricing nativo num price único, então a gente
 * mantém o unit_price em R$127 e aplica um non-catalog discount do tipo
 * `flat_per_seat` (centavos por seat) que renova junto com a subscription
 * (recur=true, sem teto). A tabela:
 *
 *   1    conexão  → R$127/ea (sem desconto)
 *   2-3  conexões → R$ 99/ea (desconto R$28 por seat)
 *   4+   conexões → R$ 79/ea (desconto R$48 por seat)
 *
 * Mudou regra de tier? Mexer aqui (preço unit_price em centavos):
 */
const TIER_BASE_UNIT_CENTS = 12700;
function tierUnitCents(qty) {
  const q = Number(qty) || 0;
  if (q >= 4) return 7900;
  if (q >= 2) return 9900;
  return TIER_BASE_UNIT_CENTS;
}
function tierDiscount(qty) {
  const q = Number(qty) || 0;
  if (q < 2) return null;
  const perSeatCents = TIER_BASE_UNIT_CENTS - tierUnitCents(q);
  if (perSeatCents <= 0) return null;
  // Currency_code do discount herda do currency_code da transaction
  // (já passamos 'BRL' no txBody). Paddle rejeita se vier explicitamente aqui.
  return {
    type: 'flat_per_seat',
    amount: String(perSeatCents),
    description: q >= 4
      ? 'Desconto por volume (4+ conexões)'
      : 'Desconto por volume (2-3 conexões)',
    recur: true,
    maximum_recurring_intervals: null
  };
}
function fmtBRL(centavos) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format((Number(centavos) || 0) / 100);
}
function buildTierSummary(qty) {
  const q = Number(qty) || 0;
  const unit = tierUnitCents(q);
  const total = unit * q;
  const baseTotal = TIER_BASE_UNIT_CENTS * q;
  const savings = baseTotal - total;
  return {
    quantity: q,
    unit_amount: String(unit),
    total_amount: String(total),
    base_unit_amount: String(TIER_BASE_UNIT_CENTS),
    base_total_amount: String(baseTotal),
    savings_amount: String(savings),
    formatted_unit: fmtBRL(unit),
    formatted_total: fmtBRL(total),
    formatted_base_unit: fmtBRL(TIER_BASE_UNIT_CENTS),
    formatted_savings: fmtBRL(savings),
    discount: tierDiscount(q)
  };
}

// ----------------------------------------------------------------
// Migração Guru → Paddle: cálculo pro-rata "delta_only".
//
// Regra (confirmada com produto):
//   - Só aceita upgrade (M > N). Downgrade/manter aguarda renovação.
//   - Cobra hoje só os SEATS A MAIS, prorratados pelos dias restantes
//     até a data de renovação Guru. Os N seats atuais já foram pagos
//     na Guru pra esse ciclo.
//   - Mínimo R$ 5,00 (abaixo disso vira ruído operacional).
//
// Após o pagamento, o webhook ancora a subscription Paddle no
// `anchor_at` (data Guru) com `do_not_bill`, e attacha o tier
// discount recorrente — ou seja: 1 única assinatura, 1ª cobrança
// menor, próxima na data Guru no valor cheio.
// ----------------------------------------------------------------
const MIN_PRORATA_CENTS = 500; // R$ 5,00

function daysUntil(endIso, now = new Date()) {
  const endMs = new Date(endIso).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(endMs) || endMs <= nowMs) return 0;
  return Math.max(1, Math.ceil((endMs - nowMs) / (1000 * 60 * 60 * 24)));
}

function calcMigrationProrata({ current_qty, target_qty, anchor_at, now = new Date() }) {
  const N = Math.max(0, Number(current_qty) || 0);
  const M = Math.max(0, Number(target_qty) || 0);
  if (M <= N) {
    return {
      ok: false,
      reason: 'not_upgrade',
      error: 'Migração disponível apenas para upgrade (mais conexões). Para manter ou reduzir, aguarde sua renovação na Guru e contrate na Paddle nesse momento.'
    };
  }
  const days = daysUntil(anchor_at, now);
  if (days <= 0) {
    return {
      ok: false,
      reason: 'expired_anchor',
      error: 'Sua renovação na Guru já chegou. Use o fluxo de renovação direto na Paddle (sem migração).'
    };
  }
  const unitTargetCents = tierUnitCents(M);
  const extraSeats = M - N;
  let prorataCents = Math.round((extraSeats * unitTargetCents * days) / 30);
  let bumped = false;
  if (prorataCents < MIN_PRORATA_CENTS) {
    prorataCents = MIN_PRORATA_CENTS;
    bumped = true;
  }
  const fullMonthlyCents = unitTargetCents * M;
  const baseTotalCents = TIER_BASE_UNIT_CENTS * M;
  const oneTimeDiscountCents = baseTotalCents - prorataCents;
  return {
    ok: true,
    current_qty: N,
    target_qty: M,
    extra_seats: extraSeats,
    days_remaining: days,
    unit_target_cents: unitTargetCents,
    prorata_cents: prorataCents,
    full_monthly_cents: fullMonthlyCents,
    base_total_cents: baseTotalCents,
    one_time_discount_cents: oneTimeDiscountCents,
    minimum_applied: bumped,
    formatted_prorata: fmtBRL(prorataCents),
    formatted_full_monthly: fmtBRL(fullMonthlyCents),
    formatted_unit_target: fmtBRL(unitTargetCents),
    anchor_at
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const paddleToken = process.env.PADDLE_API_KEY;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!paddleToken) return res.status(500).json({ error: 'PADDLE_API_KEY não configurado' });

  const {
    action,
    subscription_id,
    items,
    proration_billing_mode,
    effective_from,
    transaction_id,
    refund_type,
    refund_reason,
    account_id,
    email,
    sync_leona = true,
    price_id,
    quantity,
    name,
    current_qty,
    target_qty,
    anchor_at
  } = req.body || {};

  const headers = paddleHeaders(paddleToken);

  try {
    // ----------------------------------------------------------------
    // pricing_preview — usado pelo simulador ao vivo na tela de renovação.
    // Recebe { price_id, quantity } e devolve totals já com tier aplicado.
    // ----------------------------------------------------------------
    // ----------------------------------------------------------------
    // cancel_guru — cancela todas as subs Guru ativas associadas ao email
    // (ou ao email do billing_profile do account_id). Usado pelo card de
    // double-billing no /paddle e pode ser chamado manualmente pelo
    // suporte quando o cancelamento automático no webhook não rolou.
    // ----------------------------------------------------------------
    if (action === 'cancel_guru') {
      const guruToken = process.env.GURU_TOKEN;
      if (!guruToken) return res.status(503).json({ error: 'GURU_TOKEN não configurado' });

      let lookupEmail = email;
      if (!lookupEmail && account_id && leonaToken) {
        const profile = await getLeonaBillingProfile(account_id, leonaToken);
        lookupEmail = profile?.user?.email || null;
      }
      if (!lookupEmail) {
        return res.status(400).json({ error: 'email ou account_id (com LEONA_BILLING_TOKEN) é obrigatório' });
      }

      const subs = await findGuruActiveSubscriptionsByEmail(lookupEmail, guruToken);
      if (subs.length === 0) {
        return res.status(200).json({ email: lookupEmail, cancelled: [], skipped: true });
      }

      const cancelled = [];
      const failed = [];
      for (const s of subs) {
        const r = await cancelGuruSubscription(s.id, guruToken);
        if (r.ok) cancelled.push({ id: s.id, offer_name: s.offer_name });
        else failed.push({ id: s.id, error: r.body?.message || r.error || `HTTP ${r.status}` });
      }

      return res.status(200).json({ email: lookupEmail, cancelled, failed });
    }

    if (action === 'pricing_preview') {
      if (!price_id || !quantity) {
        return res.status(400).json({ error: 'price_id e quantity são obrigatórios' });
      }
      const r = await fetch(`${PADDLE_BASE}/pricing-preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: [{ price_id, quantity: Number(quantity) }],
          currency_code: 'BRL',
          address: { country_code: 'BR' }
        })
      });
      const data = await r.json();
      if (r.ok) {
        // Augmenta com nosso tier (Paddle não tem tiered pricing nativo num price único)
        data.tier = buildTierSummary(Number(quantity));
      }
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    // ----------------------------------------------------------------
    // create_renewal_checkout — gera link de checkout hosted da Paddle.
    // Reaproveita customer existente quando possível, e injeta o
    // leona_account_id em custom_data para o webhook reativar a conta
    // certinha após o pagamento.
    // ----------------------------------------------------------------
    if (action === 'create_renewal_checkout') {
      if (!price_id || !quantity || !email) {
        return res.status(400).json({ error: 'price_id, quantity e email são obrigatórios' });
      }

      // Garante que existe um customer Paddle (ctm_*) para esse email.
      // Se nao existir, cria. Precisamos do customer_id na URL final pra
      // o Paddle.Checkout.open pular a tela de "Insira seus dados".
      let customerId = null;
      try {
        const cusRes = await fetch(
          `${PADDLE_BASE}/customers?email=${encodeURIComponent(email)}`,
          { headers }
        );
        if (cusRes.ok) {
          const cusBody = await cusRes.json();
          const match = (cusBody.data || []).find(
            c => c.email?.toLowerCase() === email.toLowerCase()
          );
          customerId = match?.id || null;
        }
      } catch (_) {}

      if (!customerId) {
        try {
          const createRes = await fetch(`${PADDLE_BASE}/customers`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ email, ...(name ? { name } : {}) })
          });
          if (createRes.ok) {
            const created = await createRes.json();
            customerId = created.data?.id || null;
          }
        } catch (e) {
          console.warn('paddle-subscription: falha ao criar customer:', e.message);
        }
      }

      const qtyInt = Number(quantity);
      const discount = tierDiscount(qtyInt);
      const unitCents = tierUnitCents(qtyInt);

      const txBody = {
        items: [{ price_id, quantity: qtyInt }],
        collection_mode: 'automatic',
        currency_code: 'BRL',
        custom_data: {
          leona_account_id: account_id != null ? String(account_id) : null,
          source: 'leona-renewal-page',
          quantity: qtyInt,
          tier_label: `${qtyInt} ${qtyInt === 1 ? 'conexão' : 'conexões'} (R$ ${(unitCents / 100).toFixed(2).replace('.', ',')}/ea)`
        },
        ...(discount ? { discount } : {}),
        ...(customerId
          ? { customer_id: customerId }
          : { customer: { email, ...(name ? { name } : {}) } })
      };

      const r = await fetch(`${PADDLE_BASE}/transactions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(txBody)
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      // Construimos a URL apontando pro nosso /checkout (inline checkout
      // proprio com layout Leona) ao inves de usar o default payment link
      // (/recovery, que abre o overlay padrao da Paddle - mais feio).
      // O /recovery continua existindo pra emails de cobranca falhada da
      // Paddle, mas o fluxo de auto-atendimento usa /checkout.
      const txnId = data.data?.id || null;
      const finalCustomerId = data.data?.customer_id || customerId || null;

      let checkoutUrl = null;
      if (txnId) {
        const qs = new URLSearchParams();
        qs.set('_ptxn', txnId);
        if (account_id != null) qs.set('aid', String(account_id));
        if (finalCustomerId) qs.set('cid', finalCustomerId);
        checkoutUrl = `https://client.leonaflow.com/checkout?${qs.toString()}`;
      }

      return res.status(200).json({
        checkout_url: checkoutUrl,
        transaction_id: txnId,
        customer_id: finalCustomerId
      });
    }

    // ----------------------------------------------------------------
    // migration_preview — usado pelo simulador da tela "Migrar para
    // Paddle" pra mostrar pro-rata e data preservada antes do checkout.
    // ----------------------------------------------------------------
    if (action === 'migration_preview') {
      if (current_qty == null || target_qty == null || !anchor_at) {
        return res.status(400).json({ error: 'current_qty, target_qty e anchor_at são obrigatórios' });
      }
      const calc = calcMigrationProrata({ current_qty, target_qty, anchor_at });
      if (!calc.ok) return res.status(400).json({ error: calc.error, reason: calc.reason });
      return res.status(200).json({
        ...calc,
        tier: buildTierSummary(Number(target_qty))
      });
    }

    // ----------------------------------------------------------------
    // create_migration_checkout — gera link de checkout pra migrar de
    // Guru pra Paddle preservando a data de renovação.
    //
    // Mecânica:
    //  1. Pré-cria um "tier discount" recorrente na Paddle (saved
    //     discount) — webhook attacha à subscription depois do pagamento.
    //  2. Cria a transaction Paddle com o price recorrente normal +
    //     um discount inline `flat` (recur:false) calibrado pra
    //     primeira cobrança ser apenas o pro-rata calculado.
    //  3. custom_data carrega { migration:true, anchor_at,
    //     tier_discount_id, target_qty, ... } — webhook usa pra:
    //       - PATCH next_billed_at = anchor_at (do_not_bill)
    //       - PATCH discount = tier_discount_id (effective next_billing_period)
    //       - cancelar Guru
    //       - sync Leona com starter_instances=target_qty + due_date
    // ----------------------------------------------------------------
    if (action === 'create_migration_checkout') {
      if (!price_id || !email || target_qty == null || current_qty == null || !anchor_at) {
        return res.status(400).json({
          error: 'price_id, email, current_qty, target_qty e anchor_at são obrigatórios'
        });
      }
      const calc = calcMigrationProrata({ current_qty, target_qty, anchor_at });
      if (!calc.ok) return res.status(400).json({ error: calc.error, reason: calc.reason });

      // 1. Resolver/criar customer (mesma lógica de create_renewal_checkout)
      let customerId = null;
      try {
        const cusRes = await fetch(
          `${PADDLE_BASE}/customers?email=${encodeURIComponent(email)}`,
          { headers }
        );
        if (cusRes.ok) {
          const cusBody = await cusRes.json();
          const match = (cusBody.data || []).find(
            c => c.email?.toLowerCase() === email.toLowerCase()
          );
          customerId = match?.id || null;
        }
      } catch (_) {}

      if (!customerId) {
        try {
          const createRes = await fetch(`${PADDLE_BASE}/customers`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ email, ...(name ? { name } : {}) })
          });
          if (createRes.ok) {
            const created = await createRes.json();
            customerId = created.data?.id || null;
          }
        } catch (e) {
          console.warn('paddle-subscription: falha ao criar customer (migration):', e.message);
        }
      }

      // 2. Pré-criar tier discount recorrente (saved discount).
      //    PATCH /subscriptions só aceita discount por id, não inline.
      //    Pra qty < 2 não tem desconto: deixa null.
      let tierDiscountId = null;
      const tierBlueprint = tierDiscount(calc.target_qty);
      if (tierBlueprint) {
        try {
          const discRes = await fetch(`${PADDLE_BASE}/discounts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              ...tierBlueprint,
              currency_code: 'BRL'
            })
          });
          if (discRes.ok) {
            const discBody = await discRes.json();
            tierDiscountId = discBody.data?.id || null;
          } else {
            const errText = await discRes.text();
            console.warn('paddle-subscription: falha ao criar tier discount:', errText);
          }
        } catch (e) {
          console.warn('paddle-subscription: erro ao criar tier discount:', e.message);
        }
      }

      // 3. Criar transaction com inline discount one-time. O `recur:false`
      //    garante que o desconto se aplica só na primeira cobrança —
      //    a próxima (em anchor_at) será o valor cheio com o tier
      //    discount que o webhook attacha à subscription.
      const customData = {
        leona_account_id: account_id != null ? String(account_id) : null,
        source: 'leona-migration-page',
        migration: true,
        current_qty: calc.current_qty,
        target_qty: calc.target_qty,
        anchor_at: calc.anchor_at,
        prorata_cents: calc.prorata_cents,
        days_remaining: calc.days_remaining,
        tier_discount_id: tierDiscountId,
        tier_label: `${calc.target_qty} ${calc.target_qty === 1 ? 'conexão' : 'conexões'} (R$ ${(calc.unit_target_cents / 100).toFixed(2).replace('.', ',')}/ea)`
      };

      const txBody = {
        items: [{ price_id, quantity: calc.target_qty }],
        collection_mode: 'automatic',
        currency_code: 'BRL',
        custom_data: customData,
        discount: {
          type: 'flat',
          amount: String(calc.one_time_discount_cents),
          description: `Pro-rata migração Guru→Paddle (${calc.days_remaining} ${calc.days_remaining === 1 ? 'dia' : 'dias'} até ${calc.anchor_at})`,
          recur: false
        },
        ...(customerId
          ? { customer_id: customerId }
          : { customer: { email, ...(name ? { name } : {}) } })
      };

      const r = await fetch(`${PADDLE_BASE}/transactions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(txBody)
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      const txnId = data.data?.id || null;
      const finalCustomerId = data.data?.customer_id || customerId || null;

      let checkoutUrl = null;
      if (txnId) {
        const qs = new URLSearchParams();
        qs.set('_ptxn', txnId);
        if (account_id != null) qs.set('aid', String(account_id));
        if (finalCustomerId) qs.set('cid', finalCustomerId);
        checkoutUrl = `https://client.leonaflow.com/checkout?${qs.toString()}`;
      }

      return res.status(200).json({
        checkout_url: checkoutUrl,
        transaction_id: txnId,
        customer_id: finalCustomerId,
        tier_discount_id: tierDiscountId,
        quote: calc
      });
    }

    if (action === 'preview') {
      if (!subscription_id || !items) {
        return res.status(400).json({ error: 'subscription_id e items são obrigatórios' });
      }
      const totalQty = sumInstances(items);
      const tierDisc = tierDiscount(totalQty);
      const body = {
        items,
        proration_billing_mode: proration_billing_mode || 'prorated_immediately',
        // Paddle aceita `discount: null` pra limpar discount existente quando
        // o cliente faz downgrade pra um tier sem desconto (qty=1)
        discount: tierDisc || null
      };
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/preview`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (r.ok) {
        data.tier = buildTierSummary(totalQty);
      }
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'update') {
      if (!subscription_id || !items) {
        return res.status(400).json({ error: 'subscription_id e items são obrigatórios' });
      }
      const totalQty = sumInstances(items);
      const tierDisc = tierDiscount(totalQty);
      const body = {
        items,
        proration_billing_mode: proration_billing_mode || 'prorated_immediately',
        discount: tierDisc || null
      };
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      let leonaSync = null;
      if (sync_leona && leonaToken) {
        const accId = await resolveLeonaAccountId(
          { accountId: account_id, email, subscriptionId: subscription_id },
          paddleToken,
          leonaToken
        );
        if (accId) {
          const subItems = data.data?.items || [];
          const newQty = sumInstances(subItems);
          const result = await updateLeonaBillingProfile(accId, {
            starter_instances: newQty,
            status: 'active'
          }, leonaToken);
          leonaSync = { account_id: accId, starter_instances: newQty, ok: result.ok, error: result.body?.error };
        } else {
          leonaSync = { ok: false, error: 'conta Leona não encontrada' };
        }
      }

      return res.status(200).json({ ...data, leona_sync: leonaSync });
    }

    if (action === 'get') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}`, { headers });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'cancel') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const eff = effective_from === 'immediately' ? 'immediately' : 'next_billing_period';
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/cancel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ effective_from: eff })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      let leonaSync = null;
      if (sync_leona && leonaToken && eff === 'immediately') {
        const accId = await resolveLeonaAccountId(
          { accountId: account_id, email, subscriptionId: subscription_id },
          paddleToken,
          leonaToken
        );
        if (accId) {
          const result = await updateLeonaBillingProfile(accId, {
            status: 'canceled',
            starter_instances: 0
          }, leonaToken);
          leonaSync = { account_id: accId, ok: result.ok, error: result.body?.error };
        }
      }

      return res.status(200).json({ ...data, leona_sync: leonaSync });
    }

    if (action === 'pause') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const eff = effective_from === 'immediately' ? 'immediately' : 'next_billing_period';
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/pause`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ effective_from: eff })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      let leonaSync = null;
      if (sync_leona && leonaToken && eff === 'immediately') {
        const accId = await resolveLeonaAccountId(
          { accountId: account_id, email, subscriptionId: subscription_id },
          paddleToken,
          leonaToken
        );
        if (accId) {
          const result = await updateLeonaBillingProfile(accId, {
            status: 'inactive'
          }, leonaToken);
          leonaSync = { account_id: accId, ok: result.ok, error: result.body?.error };
        }
      }

      return res.status(200).json({ ...data, leona_sync: leonaSync });
    }

    if (action === 'resume') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}/resume`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ effective_from: 'immediately' })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);

      let leonaSync = null;
      if (sync_leona && leonaToken) {
        const accId = await resolveLeonaAccountId(
          { accountId: account_id, email, subscriptionId: subscription_id },
          paddleToken,
          leonaToken
        );
        if (accId) {
          const subItems = data.data?.items || [];
          const newQty = sumInstances(subItems);
          const result = await updateLeonaBillingProfile(accId, {
            status: 'active',
            ...(newQty > 0 ? { starter_instances: newQty } : {})
          }, leonaToken);
          leonaSync = { account_id: accId, ok: result.ok, error: result.body?.error };
        }
      }

      return res.status(200).json({ ...data, leona_sync: leonaSync });
    }

    if (action === 'list_transactions') {
      if (!subscription_id) return res.status(400).json({ error: 'subscription_id é obrigatório' });
      const r = await fetch(
        `${PADDLE_BASE}/transactions?subscription_id=${encodeURIComponent(subscription_id)}&per_page=50&order_by=billed_at[DESC]`,
        { headers }
      );
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'get_transaction') {
      if (!transaction_id) return res.status(400).json({ error: 'transaction_id é obrigatório' });
      const r = await fetch(
        `${PADDLE_BASE}/transactions/${transaction_id}?include=adjustments`,
        { headers }
      );
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    if (action === 'refund') {
      if (!transaction_id) return res.status(400).json({ error: 'transaction_id é obrigatório' });

      const txRes = await fetch(`${PADDLE_BASE}/transactions/${transaction_id}`, { headers });
      const txBody = await txRes.json();
      if (!txRes.ok) return res.status(txRes.status).json(txBody);

      const txItems = (txBody.data?.items || []).filter(it => it.id);
      if (txItems.length === 0) {
        return res.status(400).json({ error: 'Transação sem itens reembolsáveis' });
      }

      const itemsBody = txItems.map(it => ({
        item_id: it.id,
        type: refund_type === 'partial' ? 'partial' : 'full'
      }));

      const r = await fetch(`${PADDLE_BASE}/adjustments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'refund',
          transaction_id,
          reason: refund_reason || 'Reembolso solicitado pelo cliente',
          items: itemsBody
        })
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    return res.status(400).json({
      error: 'action inválida. Use: pricing_preview, create_renewal_checkout, migration_preview, create_migration_checkout, preview, update, get, cancel, pause, resume, list_transactions, get_transaction, refund, cancel_guru'
    });

  } catch (error) {
    console.error('paddle-subscription error:', error);
    return res.status(500).json({ error: error.message });
  }
}
