/**
 * lib/chat-tools.js
 *
 * Implementacao das "tools" que a IA do /chat (suporte interno) pode chamar.
 * Cada tool e uma funcao async que recebe params validados e retorna um JSON
 * pequeno e legivel — NAO retorne respostas enormes da API direto, sempre
 * resuma os campos relevantes pra economizar tokens.
 *
 * Convencao: toda tool retorna { ok, data, error? }. Em caso de erro,
 * `ok: false` e `error` populado. A IA usa isso pra decidir o proximo passo.
 */

import {
  getLeonaBillingProfile,
  findLeonaAccountByEmail
} from './leona.js';
import {
  findGuruContactByEmail,
  findGuruSubscriptionsByEmail,
  findGuruActiveSubscriptionsByEmail,
  cancelGuruSubscription as guruCancelSub
} from './guru.js';

const PADDLE_BASE = 'https://api.paddle.com';
const STRIPE_BASE = 'https://api.stripe.com/v1';

// ===================================================================
// HELPERS
// ===================================================================

function paddleHeaders() {
  return {
    'Authorization': `Bearer ${process.env.PADDLE_API_KEY || ''}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

function stripeHeaders() {
  const key = process.env.STRIPE_SECRET || '';
  const auth = Buffer.from(`${key}:`).toString('base64');
  return {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
}

function ok(data) { return { ok: true, data }; }
function fail(error) { return { ok: false, error: String(error) }; }

function fmtCents(amount, currency = 'BRL') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return { amount_cents: n, formatted: `${currency} ${(n / 100).toFixed(2)}` };
}

// ===================================================================
// LEONA
// ===================================================================

async function lookupLeonaByEmail(email) {
  const token = process.env.LEONA_BILLING_TOKEN;
  if (!token) return fail('LEONA_BILLING_TOKEN nao configurado');

  const found = await findLeonaAccountByEmail(email, token);
  if (!found) return ok({ found: false, hint: 'Use lookup_leona_by_account_id se houver multiplas contas pro mesmo email.' });

  const p = found.profile || {};
  return ok({
    found: true,
    account_id: found.account_id,
    user: p.user || null,
    subscription_status: p.subscription_status,
    current_period_end: p.current_period_end,
    starter_instances: p.starter_instances,
    pro_instances: p.pro_instances,
    guru_account_id: p.guru_account_id,
    plan_kind: p.plan_kind || null
  });
}

async function lookupLeonaByAccountId(account_id) {
  const token = process.env.LEONA_BILLING_TOKEN;
  if (!token) return fail('LEONA_BILLING_TOKEN nao configurado');

  const p = await getLeonaBillingProfile(account_id, token);
  if (!p) return ok({ found: false });
  return ok({
    found: true,
    account_id: p.account_id,
    user: p.user || null,
    subscription_status: p.subscription_status,
    current_period_end: p.current_period_end,
    starter_instances: p.starter_instances,
    pro_instances: p.pro_instances,
    guru_account_id: p.guru_account_id,
    plan_kind: p.plan_kind || null
  });
}

// ===================================================================
// PADDLE
// ===================================================================

async function searchPaddleByEmail(email) {
  if (!process.env.PADDLE_API_KEY) return fail('PADDLE_API_KEY nao configurado');

  const r = await fetch(`${PADDLE_BASE}/customers?email=${encodeURIComponent(email)}`, {
    headers: paddleHeaders()
  });
  if (!r.ok) return fail(`Paddle ${r.status}: ${await r.text()}`);
  const body = await r.json();
  const customers = (body.data || []).map(c => ({
    id: c.id,
    email: c.email,
    name: c.name,
    status: c.status,
    created_at: c.created_at
  }));

  if (customers.length === 0) return ok({ found: false, customers: [] });

  // pega subscriptions do primeiro match
  const cust = customers[0];
  const subsRes = await fetch(`${PADDLE_BASE}/subscriptions?customer_id=${cust.id}&per_page=20`, {
    headers: paddleHeaders()
  });
  const subsBody = subsRes.ok ? await subsRes.json() : { data: [] };
  const subs = (subsBody.data || []).map(s => ({
    id: s.id,
    status: s.status,
    started_at: s.started_at,
    next_billed_at: s.next_billed_at,
    canceled_at: s.canceled_at,
    currency_code: s.currency_code,
    items: (s.items || []).map(it => ({
      product_id: it.price?.product_id,
      price_id: it.price?.id,
      quantity: it.quantity,
      unit_price_cents: it.price?.unit_price?.amount,
      product_name: it.product?.name || it.price?.description
    })),
    discount: s.discount || null,
    scheduled_change: s.scheduled_change || null
  }));

  return ok({ found: true, customers, subscriptions: subs });
}

async function getPaddleSubscription(subscription_id) {
  if (!process.env.PADDLE_API_KEY) return fail('PADDLE_API_KEY nao configurado');

  const r = await fetch(`${PADDLE_BASE}/subscriptions/${subscription_id}`, {
    headers: paddleHeaders()
  });
  if (!r.ok) return fail(`Paddle ${r.status}`);
  const s = (await r.json()).data;

  // ultimas transacoes
  const txRes = await fetch(`${PADDLE_BASE}/transactions?subscription_id=${subscription_id}&per_page=10&order_by=billed_at[DESC]`, {
    headers: paddleHeaders()
  });
  const txs = txRes.ok ? ((await txRes.json()).data || []) : [];

  return ok({
    subscription: {
      id: s.id, status: s.status, currency_code: s.currency_code,
      started_at: s.started_at, next_billed_at: s.next_billed_at,
      canceled_at: s.canceled_at, paused_at: s.paused_at,
      items: (s.items || []).map(it => ({
        price_id: it.price?.id, quantity: it.quantity,
        product_name: it.product?.name || it.price?.description,
        unit_price_cents: it.price?.unit_price?.amount
      })),
      management_urls: s.management_urls || null,
      discount: s.discount || null,
      scheduled_change: s.scheduled_change || null
    },
    last_transactions: txs.map(t => ({
      id: t.id, status: t.status, billed_at: t.billed_at,
      currency: t.currency_code,
      total: fmtCents(t.details?.totals?.total, t.currency_code),
      grand_total: fmtCents(t.details?.totals?.grand_total, t.currency_code),
      origin: t.origin
    }))
  });
}

async function getPaddleTransaction(transaction_id) {
  if (!process.env.PADDLE_API_KEY) return fail('PADDLE_API_KEY nao configurado');

  const r = await fetch(`${PADDLE_BASE}/transactions/${transaction_id}?include=customer,subscription`, {
    headers: paddleHeaders()
  });
  if (!r.ok) return fail(`Paddle ${r.status}`);
  const t = (await r.json()).data;

  return ok({
    id: t.id, status: t.status, origin: t.origin,
    invoice_id: t.invoice_id, invoice_number: t.invoice_number,
    billed_at: t.billed_at, created_at: t.created_at,
    currency_code: t.currency_code,
    customer_id: t.customer_id, subscription_id: t.subscription_id,
    custom_data: t.custom_data || null,
    totals: {
      total: fmtCents(t.details?.totals?.total, t.currency_code),
      grand_total: fmtCents(t.details?.totals?.grand_total, t.currency_code),
      fee: fmtCents(t.details?.totals?.fee, t.currency_code),
      earnings: fmtCents(t.details?.totals?.earnings, t.currency_code)
    },
    items: (t.items || []).map(it => ({
      quantity: it.quantity,
      price_id: it.price?.id,
      product_id: it.price?.product_id,
      price_name: it.price?.name || it.price?.description
    })),
    payments: (t.payments || []).map(p => ({
      status: p.status,
      amount: fmtCents(p.amount, t.currency_code),
      method: p.method_details?.type || null,
      card_last4: p.method_details?.card?.last4 || null,
      error_code: p.error_code || null
    }))
  });
}

// ===================================================================
// GURU
// ===================================================================

async function searchGuruByEmail(email, only_active = false) {
  const token = process.env.GURU_TOKEN;
  if (!token) return fail('GURU_TOKEN nao configurado');

  try {
    const contact = await findGuruContactByEmail(email, token).catch(() => null);
    const subs = only_active
      ? await findGuruActiveSubscriptionsByEmail(email, token)
      : await findGuruSubscriptionsByEmail(email, token);

    return ok({
      contact: contact || null,
      subscriptions: (subs || []).map(s => ({
        id: s.id,
        status: s.status,
        offer_name: s.offer_name || s.offer?.name || null,
        product_name: s.product_name || s.product?.name || null,
        last_status: s.last_status || null,
        next_cycle_at: s.next_cycle_at || null,
        started_at: s.started_at || s.created_at || null,
        canceled_at: s.canceled_at || null,
        charge_amount_cents: s.charge_amount_cents || null
      })),
      active_count: (subs || []).filter(s => s.status === 'active').length
    });
  } catch (e) {
    return fail(e.message);
  }
}

// ===================================================================
// STRIPE
// ===================================================================

async function searchStripeByEmail(email) {
  if (!process.env.STRIPE_SECRET) return fail('STRIPE_SECRET nao configurado');

  const r = await fetch(`${STRIPE_BASE}/customers/search?query=${encodeURIComponent(`email:"${email}"`)}`, {
    headers: stripeHeaders()
  });
  if (!r.ok) return fail(`Stripe ${r.status}`);
  const body = await r.json();
  const customers = body.data || [];
  if (customers.length === 0) return ok({ found: false });

  const cust = customers[0];
  // assinaturas
  const subsRes = await fetch(`${STRIPE_BASE}/subscriptions?customer=${cust.id}&status=all&limit=10`, {
    headers: stripeHeaders()
  });
  const subsBody = subsRes.ok ? await subsRes.json() : { data: [] };
  const subs = (subsBody.data || []).map(s => ({
    id: s.id,
    status: s.status,
    current_period_end: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
    cancel_at_period_end: s.cancel_at_period_end,
    canceled_at: s.canceled_at ? new Date(s.canceled_at * 1000).toISOString() : null,
    items: (s.items?.data || []).map(it => ({
      quantity: it.quantity,
      price_id: it.price?.id,
      product_id: it.price?.product,
      unit_amount_cents: it.price?.unit_amount,
      currency: it.price?.currency
    }))
  }));

  return ok({
    found: true,
    customer: { id: cust.id, email: cust.email, name: cust.name, created: cust.created },
    subscriptions: subs,
    active_count: subs.filter(s => s.status === 'active' || s.status === 'trialing').length
  });
}

// ===================================================================
// AGGREGATE — visao geral de UM cliente em todos os gateways
// ===================================================================

async function lookupCustomer({ email, account_id }) {
  let resolvedEmail = email && email.trim().toLowerCase();
  let leonaResult = null;

  if (account_id) {
    leonaResult = await lookupLeonaByAccountId(account_id);
    if (leonaResult?.ok && leonaResult.data?.found) {
      const u = leonaResult.data.user;
      if (u?.email) resolvedEmail = String(u.email).toLowerCase();
    }
  } else if (resolvedEmail) {
    leonaResult = await lookupLeonaByEmail(resolvedEmail);
  } else {
    return fail('Informe email ou account_id');
  }

  if (!resolvedEmail) {
    return ok({
      resolved_email: null,
      leona: leonaResult?.data || null,
      paddle: null, guru: null, stripe: null,
      note: 'Email nao resolvido — busca em Paddle/Guru/Stripe pulada'
    });
  }

  const [paddle, guru, stripe] = await Promise.all([
    searchPaddleByEmail(resolvedEmail).catch(e => fail(e.message)),
    searchGuruByEmail(resolvedEmail, false).catch(e => fail(e.message)),
    searchStripeByEmail(resolvedEmail).catch(e => fail(e.message))
  ]);

  // analise de inconsistencias rapida
  const insights = [];
  const leonaBp = leonaResult?.data;
  const leonaActive = leonaBp?.subscription_status === 'active'
    && leonaBp?.current_period_end
    && new Date(leonaBp.current_period_end) > new Date();

  const paddleActiveSubs = (paddle?.data?.subscriptions || []).filter(s => s.status === 'active' || s.status === 'trialing');
  const guruActiveSubs = (guru?.data?.subscriptions || []).filter(s => s.status === 'active');
  const stripeActiveSubs = (stripe?.data?.subscriptions || []).filter(s => s.status === 'active' || s.status === 'trialing');

  const totalActiveGateways = [paddleActiveSubs.length, guruActiveSubs.length, stripeActiveSubs.length].filter(c => c > 0).length;
  if (totalActiveGateways > 1) {
    insights.push(`COBRANCA DUPLICADA: cliente tem assinaturas ativas em ${totalActiveGateways} gateways simultaneamente.`);
  }
  if (leonaActive && totalActiveGateways === 0) {
    insights.push('INCONSISTENCIA: Leona ativo mas nenhum gateway tem assinatura recorrente. Cliente pode ter sido pago manualmente ou via PIX.');
  }
  if (!leonaActive && totalActiveGateways > 0) {
    insights.push('INCONSISTENCIA: Leona vencido/inativo, mas existe assinatura ativa em gateway. Webhook pode ter falhado.');
  }
  if (leonaActive && paddleActiveSubs.length > 0) {
    const paddleQty = paddleActiveSubs.reduce((sum, s) => sum + (s.items?.[0]?.quantity || 0), 0);
    const leonaQty = (leonaBp?.starter_instances || 0) + (leonaBp?.pro_instances || 0);
    if (paddleQty !== leonaQty) {
      insights.push(`QUANTIDADE DIVERGENTE: Leona tem ${leonaQty} conexoes, Paddle ${paddleQty}.`);
    }
  }

  return ok({
    resolved_email: resolvedEmail,
    leona: leonaResult?.data || null,
    paddle: paddle?.data || null,
    guru: guru?.data || null,
    stripe: stripe?.data || null,
    insights
  });
}

// ===================================================================
// ACOES (somente quando o suporte pede explicitamente)
// ===================================================================

async function cancelGuruSubscription({ subscription_id }) {
  const token = process.env.GURU_TOKEN;
  if (!token) return fail('GURU_TOKEN nao configurado');
  if (!subscription_id) return fail('subscription_id obrigatorio');

  try {
    const result = await guruCancelSub(subscription_id, token);
    return ok({ subscription_id, cancelled: true, result });
  } catch (e) {
    return fail(`Falha ao cancelar Guru: ${e.message}`);
  }
}

async function createPaddleRenewalCheckout({ account_id, email, quantity, price_id }) {
  if (!process.env.PADDLE_API_KEY) return fail('PADDLE_API_KEY nao configurado');
  if (!email) return fail('email obrigatorio');
  if (!quantity) return fail('quantity obrigatorio');
  const finalPriceId = price_id || process.env.PADDLE_STARTER_PRICE_ID;
  if (!finalPriceId) return fail('price_id obrigatorio (ou configure PADDLE_STARTER_PRICE_ID)');

  // garantir customer
  let customerId = null;
  try {
    const cusRes = await fetch(`${PADDLE_BASE}/customers?email=${encodeURIComponent(email)}`, { headers: paddleHeaders() });
    if (cusRes.ok) {
      const body = await cusRes.json();
      const match = (body.data || []).find(c => c.email?.toLowerCase() === email.toLowerCase());
      customerId = match?.id || null;
    }
  } catch (_) {}

  if (!customerId) {
    const createRes = await fetch(`${PADDLE_BASE}/customers`, {
      method: 'POST', headers: paddleHeaders(), body: JSON.stringify({ email })
    });
    if (createRes.ok) customerId = (await createRes.json()).data?.id || null;
  }

  // mesma logica de tier discount do paddle-subscription.js (dup intencional pra evitar import circular)
  const qtyInt = Number(quantity);
  const TIER_BASE = 12700;
  let unitCents = TIER_BASE;
  if (qtyInt >= 4) unitCents = 7900;
  else if (qtyInt >= 2) unitCents = 9900;
  let discount = null;
  if (qtyInt >= 2) {
    const perSeat = TIER_BASE - unitCents;
    if (perSeat > 0) {
      discount = {
        type: 'flat_per_seat',
        amount: String(perSeat),
        description: qtyInt >= 4 ? 'Desconto por volume (4+ conexoes)' : 'Desconto por volume (2-3 conexoes)',
        recur: true,
        maximum_recurring_intervals: null
      };
    }
  }

  const txBody = {
    items: [{ price_id: finalPriceId, quantity: qtyInt }],
    collection_mode: 'automatic',
    currency_code: 'BRL',
    custom_data: {
      leona_account_id: account_id != null ? String(account_id) : null,
      source: 'support-chat',
      quantity: qtyInt
    },
    ...(discount ? { discount } : {}),
    ...(customerId ? { customer_id: customerId } : { customer: { email } })
  };

  const r = await fetch(`${PADDLE_BASE}/transactions`, {
    method: 'POST', headers: paddleHeaders(), body: JSON.stringify(txBody)
  });
  const data = await r.json();
  if (!r.ok) return fail(`Paddle: ${JSON.stringify(data?.error || data)}`);

  const txnId = data.data?.id;
  const finalCustomerId = data.data?.customer_id || customerId || null;
  const qs = new URLSearchParams();
  qs.set('_ptxn', txnId);
  if (account_id != null) qs.set('aid', String(account_id));
  if (finalCustomerId) qs.set('cid', finalCustomerId);
  const checkoutUrl = `https://client.leonaflow.com/checkout?${qs.toString()}`;

  return ok({
    transaction_id: txnId,
    customer_id: finalCustomerId,
    checkout_url: checkoutUrl,
    quantity: qtyInt,
    unit_price_cents: unitCents,
    total_cents: unitCents * qtyInt,
    has_discount: !!discount,
    note: 'Envie checkout_url pro cliente. O link ja vem com customer pre-vinculado.'
  });
}

// ===================================================================
// REGISTRY: schemas das tools no formato OpenAI tool-calling
// ===================================================================

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'lookup_customer',
      description: 'Busca todos os dados de um cliente em Leona, Paddle, Guru e Stripe simultaneamente. Use SEMPRE como primeira ferramenta quando o suporte mencionar um email ou account_id. Retorna insights automaticos sobre inconsistencias (cobranca duplicada, divergencia de quantidade, etc).',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email do cliente' },
          account_id: { type: 'integer', description: 'Account ID do Leona (alternativa ao email)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_leona_by_email',
      description: 'Busca billing_profile do Leona por email (so Leona, sem outros gateways).',
      parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_leona_by_account_id',
      description: 'Busca billing_profile do Leona por account_id direto. Use quando o suporte ja sabe o account_id.',
      parameters: { type: 'object', properties: { account_id: { type: 'integer' } }, required: ['account_id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_paddle_by_email',
      description: 'Busca customer e subscriptions na Paddle por email.',
      parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_paddle_subscription',
      description: 'Detalhes completos de uma subscription Paddle especifica + ultimas 10 transacoes.',
      parameters: { type: 'object', properties: { subscription_id: { type: 'string' } }, required: ['subscription_id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_paddle_transaction',
      description: 'Detalhes de uma transacao Paddle especifica (txn_xxx). Use pra investigar cobrancas com erro, refund, etc.',
      parameters: { type: 'object', properties: { transaction_id: { type: 'string' } }, required: ['transaction_id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_guru_by_email',
      description: 'Busca contato e subscriptions na Digital Manager Guru por email.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          only_active: { type: 'boolean', description: 'Se true, retorna apenas subs ativas. Default false.' }
        },
        required: ['email']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_stripe_by_email',
      description: 'Busca customer e subscriptions na Stripe por email. Stripe e o gateway legado — todos os clientes lah ja deveriam estar com cobranca cancelada.',
      parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_guru_subscription',
      description: 'ACAO: Cancela uma subscription Guru. Use APENAS quando o suporte pedir explicitamente ("cancele a Guru", "remove essa sub", etc). Confirme o subscription_id antes de chamar. Resposta inclui confirmacao.',
      parameters: { type: 'object', properties: { subscription_id: { type: 'string' } }, required: ['subscription_id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_paddle_renewal_checkout',
      description: 'ACAO: Cria uma transacao Paddle e retorna a URL do checkout pra mandar pro cliente. Use APENAS quando o suporte pedir explicitamente. Inclui automaticamente desconto de tier (R$99 pra 2-3, R$79 pra 4+).',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email do cliente' },
          account_id: { type: 'integer', description: 'Account ID Leona (recomendado, vai no checkout pra preservar contexto)' },
          quantity: { type: 'integer', description: 'Numero de conexoes' },
          price_id: { type: 'string', description: 'Price ID Paddle (opcional, usa PADDLE_STARTER_PRICE_ID por default)' }
        },
        required: ['email', 'quantity']
      }
    }
  }
];

// Mapeia name -> implementacao
export const TOOL_IMPLEMENTATIONS = {
  lookup_customer: lookupCustomer,
  lookup_leona_by_email: ({ email }) => lookupLeonaByEmail(email),
  lookup_leona_by_account_id: ({ account_id }) => lookupLeonaByAccountId(account_id),
  search_paddle_by_email: ({ email }) => searchPaddleByEmail(email),
  get_paddle_subscription: ({ subscription_id }) => getPaddleSubscription(subscription_id),
  get_paddle_transaction: ({ transaction_id }) => getPaddleTransaction(transaction_id),
  search_guru_by_email: ({ email, only_active }) => searchGuruByEmail(email, !!only_active),
  search_stripe_by_email: ({ email }) => searchStripeByEmail(email),
  cancel_guru_subscription: cancelGuruSubscription,
  create_paddle_renewal_checkout: createPaddleRenewalCheckout
};

export async function executeTool(name, args) {
  const fn = TOOL_IMPLEMENTATIONS[name];
  if (!fn) return fail(`Tool desconhecida: ${name}`);
  try {
    const result = await fn(args || {});
    return result;
  } catch (e) {
    return fail(`Erro executando ${name}: ${e.message}`);
  }
}
