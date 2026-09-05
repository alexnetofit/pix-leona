import {
  cancelSubscription,
  createCustomer,
  createCustomerPortalSession,
  createDiscount,
  createTransaction,
  getCustomer,
  getSubscription,
  listCustomersByEmail,
  listSubscriptionsByCustomer,
  listTransactions,
  pickUpdatePaymentMethodUrl,
  previewSubscriptionUpdate,
  updateCustomer,
  updateSubscription
} from './paddle-client.js';
import {
  appendPaddleBillingAuditLog,
  createPaddleBillingIntent,
  getPaddleBillingAccount,
  updatePaddleBillingIntent,
  upsertPaddleBillingAccount
} from './paddle-ledger.js';
import {
  buildIntentFingerprint,
  classifyQuantityChange,
  sumRecurringQuantity,
  totalPriceForQuantity
} from './paddle-policy.js';
import { createPaddleCheckoutToken } from './paddle-session.js';

const MANAGED_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused']);

export class PaddleBillingError extends Error {
  constructor(message, code = 'PADDLE_BILLING_ERROR', status = 400, details = null) {
    super(message);
    this.name = 'PaddleBillingError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function profileEmail(profile) {
  return String(profile?.user?.email ?? profile?.email ?? '').trim().toLowerCase();
}

function profileQuantity(profile) {
  const value = Number(
    profile?.starter_instances ?? profile?.instances ?? profile?.subscription_instances ?? 0
  );
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function entityAccountId(entity) {
  return String(entity?.custom_data?.leona_account_id ?? entity?.custom_data?.account_id ?? '');
}

function intentIdFromTransaction(transaction) {
  return String(transaction?.custom_data?.billing_intent_id ?? '');
}

function subscriptionEnd(subscription) {
  return subscription?.current_billing_period?.ends_at ?? null;
}

function recurringItems(subscription, targetQuantity) {
  const current = Array.isArray(subscription?.items) ? subscription.items : [];
  const recurring = current.filter(item => item?.price?.billing_cycle != null);
  if (recurring.length === 0) {
    throw new PaddleBillingError(
      'Assinatura Paddle não possui item recorrente gerenciável',
      'SUBSCRIPTION_ITEM_NOT_FOUND',
      409
    );
  }
  if (recurring.length > 1) {
    throw new PaddleBillingError(
      'Assinatura Paddle possui múltiplos itens recorrentes e exige revisão',
      'AMBIGUOUS_SUBSCRIPTION_ITEMS',
      409
    );
  }
  return [{ price_id: recurring[0].price.id, quantity: targetQuantity }];
}

function recurringTierDiscountBlueprint(quantity) {
  const total = totalPriceForQuantity(quantity);
  const baseTotal = 12700 * quantity;
  if (total == null || total >= baseTotal) return null;
  return {
    type: 'flat_per_seat',
    amount: String((baseTotal - total) / quantity),
    description: `Plano Leona ${quantity} instâncias`,
    recur: true,
    maximum_recurring_intervals: null
  };
}

async function recurringTierDiscount(context, quantity) {
  const blueprint = recurringTierDiscountBlueprint(quantity);
  if (!blueprint) return null;
  const tier = quantity >= 4 ? '4_plus' : '2_3';
  const envName = tier === '4_plus'
    ? 'PADDLE_DISCOUNT_4_PLUS_ID'
    : 'PADDLE_DISCOUNT_2_3_ID';
  let id = process.env[envName] || context.account.metadata?.tier_discount_ids?.[tier];
  if (!id) {
    const discount = await createDiscount({ ...blueprint, currency_code: 'BRL' });
    id = discount.id;
    context.account = await upsertPaddleBillingAccount({
      ...context.account,
      metadata: {
        ...(context.account.metadata || {}),
        tier_discount_ids: {
          ...(context.account.metadata?.tier_discount_ids || {}),
          [tier]: id
        }
      }
    });
  }
  return { id, effective_from: 'immediately' };
}

function previewAmount(preview) {
  const candidates = [
    preview?.immediate_transaction?.details?.totals?.grand_total,
    preview?.immediate_transaction?.details?.totals?.total,
    preview?.details?.totals?.grand_total
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function prepaidUpgradeAmount(account, targetQuantity) {
  const end = new Date(account.paid_through).getTime();
  const now = Date.now();
  const remainingDays = (end - now) / 86_400_000;
  if (!Number.isFinite(remainingDays) || remainingDays <= 0 || remainingDays > 35) {
    throw new PaddleBillingError(
      'Ciclo PIX pré-pago exige revisão antes do upgrade',
      'PREPAID_CYCLE_REVIEW_REQUIRED',
      409
    );
  }
  const difference = totalPriceForQuantity(targetQuantity)
    - totalPriceForQuantity(account.financial_quantity);
  return Math.max(1, Math.ceil(difference * Math.min(remainingDays / 30, 1)));
}

async function markManualReview(account, reason, details = {}) {
  await upsertPaddleBillingAccount({
    leona_account_id: account.leona_account_id,
    canonical_email: account.canonical_email,
    paddle_customer_id: account.paddle_customer_id || null,
    paddle_subscription_id: account.paddle_subscription_id || null,
    financial_quantity: account.financial_quantity || 0,
    entitled_quantity: account.entitled_quantity || 0,
    state: 'manual_review',
    metadata: { ...(account.metadata || {}), manual_review_reason: reason, ...details }
  });
}

export async function resolvePaddleBillingAccount(leonaAccountId, profile) {
  const accountId = String(leonaAccountId || '').trim();
  const canonicalEmail = profileEmail(profile);
  if (!accountId || !canonicalEmail) {
    throw new PaddleBillingError('Conta Leona sem account_id ou e-mail canônico', 'INVALID_PROFILE');
  }

  const existing = await getPaddleBillingAccount(accountId);
  let customer = null;

  if (existing?.paddle_customer_id) {
    try {
      customer = await getCustomer(existing.paddle_customer_id);
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }

  if (!customer) {
    const candidates = await listCustomersByEmail(canonicalEmail);
    const linked = candidates.filter(item => entityAccountId(item) === accountId);
    const unlinked = candidates.filter(item => !entityAccountId(item));
    if (linked.length > 1 || (linked.length === 0 && unlinked.length > 0)) {
      const provisional = existing || {
        leona_account_id: accountId,
        canonical_email: canonicalEmail
      };
      await markManualReview(provisional, linked.length > 1
        ? 'ambiguous_customer'
        : 'email_only_customer_requires_migration', {
        candidate_customer_ids: [...linked, ...unlinked].map(item => item.id)
      });
      throw new PaddleBillingError(
        linked.length > 1
          ? 'Há mais de um cliente Paddle vinculado a esta conta'
          : 'Cliente Paddle encontrado apenas por e-mail; migração manual obrigatória',
        linked.length > 1 ? 'AMBIGUOUS_CUSTOMER' : 'CUSTOMER_MIGRATION_REQUIRED',
        409
      );
    }
    customer = linked[0] || null;
  }

  if (!customer) {
    customer = await createCustomer({
      email: canonicalEmail,
      customData: { leona_account_id: accountId }
    });
  } else {
    const linkedAccountId = entityAccountId(customer);
    if (linkedAccountId && linkedAccountId !== accountId) {
      await markManualReview({
        ...(existing || {}),
        leona_account_id: accountId,
        canonical_email: canonicalEmail,
        paddle_customer_id: customer.id
      }, 'customer_account_conflict', { linked_account_id: linkedAccountId });
      throw new PaddleBillingError(
        'Customer Paddle já está vinculado a outra conta Leona',
        'CUSTOMER_ACCOUNT_CONFLICT',
        409
      );
    }
  }
  if (
    String(customer.email || '').toLowerCase() !== canonicalEmail ||
    entityAccountId(customer) !== accountId
  ) {
    customer = await updateCustomer(customer.id, {
      email: canonicalEmail,
      custom_data: { ...(customer.custom_data || {}), leona_account_id: accountId }
    });
  }

  const subscriptions = (await listSubscriptionsByCustomer(customer.id))
    .filter(item => MANAGED_SUBSCRIPTION_STATUSES.has(String(item.status || '').toLowerCase()));
  if (subscriptions.length > 1) {
    const provisional = {
      ...(existing || {}),
      leona_account_id: accountId,
      canonical_email: canonicalEmail,
      paddle_customer_id: customer.id
    };
    await markManualReview(provisional, 'multiple_managed_subscriptions', {
      subscription_ids: subscriptions.map(item => item.id)
    });
    throw new PaddleBillingError(
      'A conta possui múltiplas assinaturas Paddle ativas',
      'MULTIPLE_SUBSCRIPTIONS',
      409
    );
  }

  let subscription = subscriptions[0] || null;
  if (subscription) {
    const linkedAccountId = entityAccountId(subscription);
    if (linkedAccountId && linkedAccountId !== accountId) {
      await markManualReview({
        ...(existing || {}),
        leona_account_id: accountId,
        canonical_email: canonicalEmail,
        paddle_customer_id: customer.id,
        paddle_subscription_id: subscription.id
      }, 'subscription_account_conflict', { linked_account_id: linkedAccountId });
      throw new PaddleBillingError(
        'Assinatura Paddle já está vinculada a outra conta Leona',
        'SUBSCRIPTION_ACCOUNT_CONFLICT',
        409
      );
    }
  }
  if (subscription && !entityAccountId(subscription)) {
    subscription = await updateSubscription(subscription.id, {
      custom_data: {
        ...(subscription.custom_data || {}),
        leona_account_id: accountId
      }
    });
  }

  const financialQuantity = subscription
    ? sumRecurringQuantity(subscription.items)
    : (existing?.financial_quantity ?? 0);
  const entitledQuantity = existing?.entitled_quantity ?? profileQuantity(profile);
  const rawState = subscription?.status || existing?.state || 'unlinked';
  const state = rawState === 'trialing' ? 'active' : rawState;
  const account = await upsertPaddleBillingAccount({
    leona_account_id: accountId,
    canonical_email: canonicalEmail,
    paddle_customer_id: customer.id,
    paddle_subscription_id: subscription?.id || null,
    financial_quantity: financialQuantity,
    entitled_quantity: entitledQuantity,
    pending_downgrade_quantity: existing?.pending_downgrade_quantity ?? null,
    pending_downgrade_effective_at: existing?.pending_downgrade_effective_at ?? null,
    paid_through: subscriptionEnd(subscription) || existing?.paid_through || null,
    state: ['active', 'past_due', 'paused'].includes(state) ? state : 'unlinked',
    metadata: existing?.metadata || {}
  });

  return { account, customer, subscription };
}

export async function getPaddleBillingOverview(leonaAccountId, profile) {
  const context = await resolvePaddleBillingAccount(leonaAccountId, profile);
  const { account, customer, subscription } = context;
  return {
    account_id: account.leona_account_id,
    email: account.canonical_email,
    paddle_customer_id: customer.id,
    paddle_subscription_id: subscription?.id || null,
    subscription_status: subscription?.status || null,
    financial_quantity: account.financial_quantity,
    entitled_quantity: account.entitled_quantity,
    pending_downgrade_quantity: account.pending_downgrade_quantity,
    pending_downgrade_effective_at: account.pending_downgrade_effective_at,
    current_billing_period: subscription?.current_billing_period || null,
    next_billed_at: subscription?.next_billed_at || null,
    scheduled_change: subscription?.scheduled_change || null
  };
}

export async function previewPaddleQuantityChange(leonaAccountId, profile, targetQuantity) {
  const target = Number(targetQuantity);
  if (!Number.isInteger(target) || target < 1) {
    throw new PaddleBillingError('Quantidade deve ser um inteiro positivo', 'INVALID_QUANTITY');
  }
  const context = await resolvePaddleBillingAccount(leonaAccountId, profile);
  const current = context.subscription
    ? sumRecurringQuantity(context.subscription.items)
    : (context.account.financial_quantity || 0);
  const change = classifyQuantityChange(current, target);

  if (change === 'upgrade' && context.subscription) {
    const preview = await previewSubscriptionUpdate(context.subscription.id, {
      items: recurringItems(context.subscription, target),
      discount: await recurringTierDiscount(context, target),
      proration_billing_mode: 'prorated_immediately'
    });
    return {
      change,
      current_quantity: current,
      target_quantity: target,
      amount_cents: previewAmount(preview),
      currency_code: preview?.immediate_transaction?.currency_code || 'BRL',
      effective_at: new Date().toISOString()
    };
  }

  const prepaidActive = !context.subscription
    && context.account.paid_through
    && new Date(context.account.paid_through).getTime() > Date.now()
    && current > 0;
  if (prepaidActive) {
    return {
      change,
      current_quantity: current,
      target_quantity: target,
      amount_cents: change === 'upgrade'
        ? prepaidUpgradeAmount(context.account, target)
        : (change === 'unchanged' ? totalPriceForQuantity(target) : 0),
      currency_code: 'BRL',
      effective_at: change === 'downgrade'
        ? context.account.paid_through
        : new Date().toISOString()
    };
  }

  return {
    change: current === 0 ? 'subscribe' : change,
    current_quantity: current,
    target_quantity: target,
    amount_cents: totalPriceForQuantity(target),
    currency_code: 'BRL',
    effective_at: change === 'downgrade'
      ? subscriptionEnd(context.subscription)
      : new Date().toISOString()
  };
}

async function createIntent(context, kind, target, amount, effectiveAt) {
  const current = context.subscription
    ? sumRecurringQuantity(context.subscription.items)
    : (context.account.financial_quantity || 0);
  try {
    return await createPaddleBillingIntent({
      leona_account_id: context.account.leona_account_id,
      kind,
      status: kind === 'downgrade' ? 'created' : 'awaiting_payment',
      previous_quantity: current,
      target_quantity: target,
      amount_cents: amount,
      effective_at: effectiveAt,
      expires_at: kind.includes('pix')
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : null,
      paddle_customer_id: context.customer.id,
      paddle_subscription_id: context.subscription?.id || null,
      metadata: {
        billing_period_end: subscriptionEnd(context.subscription)
      },
      request_fingerprint: buildIntentFingerprint({
        account: context.account.leona_account_id,
        kind,
        current,
        target,
        cycle: subscriptionEnd(context.subscription)
      })
    });
  } catch (error) {
    if (error?.code === 'PADDLE_OPERATION_IN_PROGRESS') {
      throw new PaddleBillingError(
        'Já existe outra operação de cobrança em andamento',
        'OPERATION_IN_PROGRESS',
        409,
        { intent_id: error.openIntent?.id }
      );
    }
    throw error;
  }
}

function checkoutUrl(checkoutToken) {
  const base = process.env.PADDLE_CHECKOUT_BASE_URL || 'https://client.leonaflow.com/checkout';
  const url = new URL(base);
  url.searchParams.set('token', checkoutToken);
  return url.toString();
}

async function createOneTimePix(context, intent, amount, target) {
  const priceId = process.env.PADDLE_PIX_PRICE_ID;
  if (!priceId) {
    throw new PaddleBillingError('PADDLE_PIX_PRICE_ID não configurado', 'PIX_NOT_CONFIGURED', 503);
  }
  const baseTotal = 12700 * target;
  if (amount <= 0 || amount > baseTotal) {
    throw new PaddleBillingError('Valor PIX fora da faixa configurada', 'INVALID_PIX_AMOUNT', 409);
  }
  const body = {
    items: [{ price_id: priceId, quantity: target }],
    customer_id: context.customer.id,
    collection_mode: 'automatic',
    currency_code: 'BRL',
    custom_data: {
      leona_account_id: context.account.leona_account_id,
      billing_intent_id: intent.id,
      paddle_subscription_id: context.subscription?.id || null,
      payment_purpose: intent.kind
    },
    checkout: { url: process.env.PADDLE_CHECKOUT_BASE_URL || 'https://client.leonaflow.com/checkout' }
  };
  if (amount < baseTotal) {
    body.discount = {
      description: `Ajuste Leona ${intent.id}`,
      type: 'flat',
      amount: String(baseTotal - amount),
      recur: false
    };
  }
  let transaction = null;
  if (intent.paddle_transaction_id) {
    transaction = { id: intent.paddle_transaction_id, status: 'ready' };
  } else if (intent._reused) {
    transaction = (await listTransactions({
      customer_id: context.customer.id,
      per_page: 100
    })).find(item => intentIdFromTransaction(item) === intent.id) || null;
  }
  transaction ||= await createTransaction(body);
  await updatePaddleBillingIntent(intent.id, {
    paddle_transaction_id: transaction.id,
    metadata: {
      ...(intent.metadata || {}),
      payment_method: 'pix',
      transaction_status: transaction.status
    }
  }, 'awaiting_payment');
  const token = createPaddleCheckoutToken({
    accountId: context.account.leona_account_id,
    customerId: context.customer.id,
    transactionId: transaction.id,
    intentId: intent.id
  });
  return {
    mode: 'checkout',
    payment_method: 'pix',
    intent_id: intent.id,
    transaction_id: transaction.id,
    checkout_url: checkoutUrl(token)
  };
}

async function createRecurringCheckout(context, intent, target) {
  const priceId = process.env.PADDLE_STARTER_PRICE_ID;
  if (!priceId) {
    throw new PaddleBillingError(
      'PADDLE_STARTER_PRICE_ID não configurado',
      'CARD_CHECKOUT_NOT_CONFIGURED',
      503
    );
  }
  const total = totalPriceForQuantity(target);
  const baseTotal = 12700 * target;
  const body = {
    items: [{ price_id: priceId, quantity: target }],
    customer_id: context.customer.id,
    collection_mode: 'automatic',
    currency_code: 'BRL',
    custom_data: {
      leona_account_id: context.account.leona_account_id,
      billing_intent_id: intent.id,
      payment_purpose: intent.kind
    },
    checkout: { url: process.env.PADDLE_CHECKOUT_BASE_URL || 'https://client.leonaflow.com/checkout' }
  };
  if (total < baseTotal) {
    body.discount = {
      description: `Plano Leona ${target} instâncias`,
      type: 'flat_per_seat',
      amount: String((baseTotal - total) / target),
      recur: true,
      maximum_recurring_intervals: null
    };
  }
  let transaction = null;
  if (intent.paddle_transaction_id) {
    transaction = { id: intent.paddle_transaction_id, status: 'ready' };
  } else if (intent._reused) {
    transaction = (await listTransactions({
      customer_id: context.customer.id,
      per_page: 100
    })).find(item => intentIdFromTransaction(item) === intent.id) || null;
  }
  transaction ||= await createTransaction(body);
  await updatePaddleBillingIntent(intent.id, {
    paddle_transaction_id: transaction.id,
    metadata: {
      ...(intent.metadata || {}),
      payment_method: 'card',
      transaction_status: transaction.status
    }
  }, 'awaiting_payment');
  await upsertPaddleBillingAccount({
    ...context.account,
    state: 'checkout_pending'
  });
  const token = createPaddleCheckoutToken({
    accountId: context.account.leona_account_id,
    customerId: context.customer.id,
    transactionId: transaction.id,
    intentId: intent.id
  });
  return {
    mode: 'checkout',
    payment_method: 'card',
    intent_id: intent.id,
    transaction_id: transaction.id,
    checkout_url: checkoutUrl(token)
  };
}

export async function executePaddleQuantityChange({
  leonaAccountId,
  profile,
  targetQuantity,
  paymentMethod = 'card'
}) {
  const target = Number(targetQuantity);
  if (!Number.isInteger(target) || target < 1) {
    throw new PaddleBillingError('Quantidade deve ser um inteiro positivo', 'INVALID_QUANTITY');
  }
  if (!['card', 'pix'].includes(paymentMethod)) {
    throw new PaddleBillingError('Forma de pagamento inválida', 'INVALID_PAYMENT_METHOD');
  }

  const context = await resolvePaddleBillingAccount(leonaAccountId, profile);
  const prepaidActive = !context.subscription
    && context.account.paid_through
    && new Date(context.account.paid_through).getTime() > Date.now()
    && context.account.financial_quantity > 0;
  const current = context.subscription
    ? sumRecurringQuantity(context.subscription.items)
    : (prepaidActive ? context.account.financial_quantity : 0);
  const change = classifyQuantityChange(current, target);

  if (!context.subscription && !prepaidActive) {
    const amount = totalPriceForQuantity(target);
    const kind = paymentMethod === 'pix' ? 'subscribe_pix_prepaid' : 'subscribe_card';
    const intent = await createIntent(context, kind, target, amount, new Date().toISOString());
    return paymentMethod === 'pix'
      ? createOneTimePix(context, intent, amount, target)
      : createRecurringCheckout(context, intent, target);
  }

  if (prepaidActive) {
    if (change === 'downgrade') {
      const intent = await createIntent(
        context,
        'downgrade',
        target,
        0,
        context.account.paid_through
      );
      await updatePaddleBillingIntent(intent.id, {
        status: 'applied',
        applied_at: new Date().toISOString()
      }, 'created');
      await upsertPaddleBillingAccount({
        ...context.account,
        financial_quantity: target,
        pending_downgrade_quantity: target,
        pending_downgrade_effective_at: context.account.paid_through
      });
      return {
        mode: 'applied',
        change: 'downgrade',
        intent_id: intent.id,
        financial_quantity: target,
        entitled_quantity: context.account.entitled_quantity,
        effective_at: context.account.paid_through
      };
    }
    if (paymentMethod !== 'pix') {
      throw new PaddleBillingError(
        'Conta PIX pré-paga ativa deve concluir o ciclo antes de migrar para cartão',
        'PREPAID_CARD_MIGRATION_DEFERRED',
        409
      );
    }
    const kind = change === 'upgrade' ? 'upgrade_pix' : 'renew_pix';
    const amount = change === 'upgrade'
      ? prepaidUpgradeAmount(context.account, target)
      : totalPriceForQuantity(target);
    const intent = await createIntent(
      context,
      kind,
      target,
      amount,
      context.account.paid_through
    );
    return createOneTimePix(context, intent, amount, target);
  }

  if (change === 'unchanged') {
    if (paymentMethod === 'pix') {
      const amount = totalPriceForQuantity(target);
      const effectiveAt = subscriptionEnd(context.subscription);
      const intent = await createIntent(
        context,
        'renew_pix',
        target,
        amount,
        effectiveAt
      );
      return createOneTimePix(context, intent, amount, target);
    }
    throw new PaddleBillingError('A assinatura já possui essa quantidade', 'NO_CHANGE', 409);
  }

  if (change === 'downgrade') {
    const effectiveAt = subscriptionEnd(context.subscription);
    if (!effectiveAt) {
      throw new PaddleBillingError(
        'Assinatura sem fim de período para agendar downgrade',
        'MISSING_BILLING_PERIOD',
        409
      );
    }
    const intent = await createIntent(
      context,
      'downgrade',
      target,
      totalPriceForQuantity(target),
      effectiveAt
    );
    const subscription = await updateSubscription(context.subscription.id, {
      items: recurringItems(context.subscription, target),
      discount: await recurringTierDiscount(context, target),
      proration_billing_mode: 'do_not_bill',
      custom_data: {
        ...(context.subscription.custom_data || {}),
        leona_account_id: context.account.leona_account_id,
        billing_intent_id: intent.id
      }
    });
    await updatePaddleBillingIntent(intent.id, {
      status: 'applied',
      applied_at: new Date().toISOString()
    }, 'created');
    await upsertPaddleBillingAccount({
      ...context.account,
      paddle_subscription_id: subscription.id,
      financial_quantity: target,
      entitled_quantity: context.account.entitled_quantity,
      pending_downgrade_quantity: target,
      pending_downgrade_effective_at: effectiveAt,
      paid_through: effectiveAt,
      state: subscription.status
    });
    await appendPaddleBillingAuditLog({
      leona_account_id: context.account.leona_account_id,
      actor_type: 'customer',
      action: 'downgrade_scheduled',
      before_state: { quantity: current },
      after_state: { quantity: target, entitlement_until: effectiveAt },
      metadata: { intent_id: intent.id }
    });
    return {
      mode: 'applied',
      change: 'downgrade',
      intent_id: intent.id,
      financial_quantity: target,
      entitled_quantity: context.account.entitled_quantity,
      effective_at: effectiveAt
    };
  }

  const quote = await previewPaddleQuantityChange(leonaAccountId, profile, target);
  const kind = paymentMethod === 'pix' ? 'upgrade_pix' : 'upgrade_card';
  const intent = await createIntent(
    context,
    kind,
    target,
    quote.amount_cents,
    new Date().toISOString()
  );
  if (intent._reused && ['applying', 'paid_pending_apply'].includes(intent.status)) {
    return {
      mode: 'processing',
      change: 'upgrade',
      intent_id: intent.id,
      amount_cents: intent.amount_cents,
      subscription_id: intent.paddle_subscription_id
    };
  }
  if (paymentMethod === 'pix') {
    return createOneTimePix(context, intent, quote.amount_cents, target);
  }

  await updatePaddleBillingIntent(intent.id, { status: 'applying' }, 'awaiting_payment');
  const subscription = await updateSubscription(context.subscription.id, {
    items: recurringItems(context.subscription, target),
    discount: await recurringTierDiscount(context, target),
    proration_billing_mode: 'prorated_immediately',
    on_payment_failure: 'prevent_change',
    custom_data: {
      ...(context.subscription.custom_data || {}),
      leona_account_id: context.account.leona_account_id,
      billing_intent_id: intent.id
    }
  });
  await appendPaddleBillingAuditLog({
    leona_account_id: context.account.leona_account_id,
    actor_type: 'customer',
    action: 'card_upgrade_requested',
    before_state: { quantity: current },
    after_state: { quantity: target },
    metadata: { intent_id: intent.id, subscription_id: subscription.id }
  });
  return {
    mode: 'processing',
    change: 'upgrade',
    intent_id: intent.id,
    amount_cents: quote.amount_cents,
    subscription_id: subscription.id
  };
}

export async function refreshPaddleSubscription(account) {
  if (!account?.paddle_subscription_id) return null;
  return getSubscription(account.paddle_subscription_id);
}

export async function createPaddleUpdatePaymentUrl(leonaAccountId, profile) {
  const context = await resolvePaddleBillingAccount(leonaAccountId, profile);
  if (!context.subscription) {
    throw new PaddleBillingError('Nenhuma assinatura Paddle ativa', 'SUBSCRIPTION_NOT_FOUND', 404);
  }
  const portal = await createCustomerPortalSession(context.customer.id, {
    subscriptionIds: [context.subscription.id]
  });
  const url = pickUpdatePaymentMethodUrl(portal, context.subscription.id);
  if (!url) {
    throw new PaddleBillingError(
      'Paddle não gerou o link de troca de cartão',
      'PORTAL_URL_MISSING',
      502
    );
  }
  await appendPaddleBillingAuditLog({
    leona_account_id: context.account.leona_account_id,
    actor_type: 'customer',
    action: 'update_payment_method_requested',
    before_state: { subscription_id: context.subscription.id },
    after_state: { subscription_id: context.subscription.id },
    metadata: { customer_id: context.customer.id }
  });
  return {
    update_payment_method: url,
    subscription_id: context.subscription.id
  };
}

export async function cancelPaddleSubscriptionAtPeriodEnd(leonaAccountId, profile) {
  const context = await resolvePaddleBillingAccount(leonaAccountId, profile);
  if (!context.subscription) {
    throw new PaddleBillingError('Nenhuma assinatura Paddle ativa', 'SUBSCRIPTION_NOT_FOUND', 404);
  }
  const subscription = await cancelSubscription(
    context.subscription.id,
    'next_billing_period'
  );
  await appendPaddleBillingAuditLog({
    leona_account_id: context.account.leona_account_id,
    actor_type: 'customer',
    action: 'cancellation_scheduled',
    before_state: { scheduled_change: context.subscription.scheduled_change || null },
    after_state: { scheduled_change: subscription.scheduled_change || null },
    metadata: { subscription_id: subscription.id }
  });
  return {
    subscription_id: subscription.id,
    status: subscription.status,
    scheduled_change: subscription.scheduled_change,
    access_until: subscriptionEnd(subscription)
  };
}
