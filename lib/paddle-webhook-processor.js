import {
  cancelSubscription,
  createDiscount,
  getSubscription,
  getTransaction,
  updateSubscription
} from './paddle-client.js';
import {
  appendPaddleBillingAuditLog,
  enqueuePaddleLeonaOutbox,
  getPaddleBillingAccount,
  getPaddleBillingIntent,
  getPaddleBillingIntentByTransaction,
  updatePaddleBillingIntent,
  updatePaddleWebhookEvent,
  upsertPaddleBillingAccount
} from './paddle-ledger.js';
import {
  brtYesterday,
  sumRecurringQuantity,
  totalPriceForQuantity,
  transactionTotal
} from './paddle-policy.js';

function accountIdFrom(data) {
  return String(data?.custom_data?.leona_account_id ?? data?.custom_data?.account_id ?? '');
}

function intentIdFrom(data) {
  return String(data?.custom_data?.billing_intent_id ?? '');
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

function addOneMonth(value) {
  const source = new Date(value);
  if (Number.isNaN(source.getTime())) return null;
  const day = source.getUTCDate();
  source.setUTCDate(1);
  source.setUTCMonth(source.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(
    source.getUTCFullYear(),
    source.getUTCMonth() + 1,
    0
  )).getUTCDate();
  source.setUTCDate(Math.min(day, lastDay));
  return source.toISOString();
}

function adjustmentAmount(data) {
  const candidates = [
    data?.totals?.total,
    data?.totals?.grand_total,
    data?.details?.totals?.grand_total,
    data?.amount
  ];
  for (const value of candidates) {
    const parsed = Math.abs(Number(value));
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
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

async function recurringTierDiscount(account, quantity) {
  const blueprint = recurringTierDiscountBlueprint(quantity);
  if (!blueprint) return { discount: null, account };
  const tier = quantity >= 4 ? '4_plus' : '2_3';
  const envName = tier === '4_plus'
    ? 'PADDLE_DISCOUNT_4_PLUS_ID'
    : 'PADDLE_DISCOUNT_2_3_ID';
  let id = process.env[envName] || account.metadata?.tier_discount_ids?.[tier];
  if (!id) {
    const created = await createDiscount({ ...blueprint, currency_code: 'BRL' });
    id = created.id;
    account = await upsertPaddleBillingAccount({
      ...account,
      metadata: {
        ...(account.metadata || {}),
        tier_discount_ids: {
          ...(account.metadata?.tier_discount_ids || {}),
          [tier]: id
        }
      }
    });
  }
  return { discount: { id, effective_from: 'immediately' }, account };
}

async function resolveIntent(data) {
  const intentId = intentIdFrom(data);
  if (intentId) return getPaddleBillingIntent(intentId);
  if (data?.id && String(data.id).startsWith('txn_')) {
    return getPaddleBillingIntentByTransaction(data.id);
  }
  if (data?.transaction_id) {
    return getPaddleBillingIntentByTransaction(data.transaction_id);
  }
  return null;
}

async function enqueueEntitlement(event, accountId, payload) {
  if (!payload) return;
  await enqueuePaddleLeonaOutbox({
    leona_account_id: accountId,
    source_event_id: event.event_id,
    desired_payload: payload
  });
}

function completedPaymentMethod(transaction) {
  const payment = (transaction?.payments || []).find(item =>
    ['completed', 'captured'].includes(String(item?.status || '').toLowerCase())
  );
  return String(
    payment?.method_details?.type
      ?? payment?.method_details?.card?.type
      ?? payment?.payment_method
      ?? ''
  ).toLowerCase();
}

async function validateCompletedIntent(event, data, intent, account) {
  const reasons = [];
  const payloadAccountId = accountIdFrom(data);
  if (payloadAccountId && payloadAccountId !== intent.leona_account_id) {
    reasons.push('account_id');
  }
  if (intent.paddle_transaction_id && intent.paddle_transaction_id !== data.id) {
    reasons.push('transaction_id');
  }
  if (intent.paddle_customer_id && intent.paddle_customer_id !== data.customer_id) {
    reasons.push('customer_id');
  }
  if (String(data.currency_code || '').toUpperCase() !== String(intent.currency_code).toUpperCase()) {
    reasons.push('currency');
  }
  if (transactionTotal(data) !== Number(intent.amount_cents)) {
    reasons.push('amount');
  }
  if (intent.metadata?.payment_method === 'pix' && completedPaymentMethod(data) !== 'pix') {
    reasons.push('payment_method');
  }
  if (
    intent.expires_at
    && new Date(data.billed_at || event.occurred_at).getTime()
      > new Date(intent.expires_at).getTime()
  ) {
    reasons.push('expired_intent');
  }
  const alreadyProjected = intent.status === 'paid_pending_apply'
    && account
    && Number(account.financial_quantity) === Number(intent.target_quantity);
  if (
    account
    && Number(account.financial_quantity) !== Number(intent.previous_quantity)
    && !alreadyProjected
  ) {
    reasons.push('previous_quantity');
  }
  if (
    intent.paddle_subscription_id
    && data.subscription_id
    && intent.paddle_subscription_id !== data.subscription_id
  ) {
    reasons.push('subscription_id');
  }
  if (intent.paddle_subscription_id && intent.metadata?.billing_period_end) {
    const subscription = await getSubscription(intent.paddle_subscription_id);
    const currentEnd = subscription.current_billing_period?.ends_at || null;
    const acceptedRenewalAdvance = intent.kind === 'renew_pix'
      && intent.status === 'paid_pending_apply'
      && currentEnd === addOneMonth(intent.metadata.billing_period_end);
    if (currentEnd !== intent.metadata.billing_period_end && !acceptedRenewalAdvance) {
      reasons.push('billing_cycle');
    }
  }
  if (
    !intent.paddle_subscription_id
    && ['upgrade_pix', 'renew_pix'].includes(intent.kind)
    && account?.paid_through !== intent.effective_at
    && !(
      intent.kind === 'renew_pix'
      && intent.status === 'paid_pending_apply'
      && account?.paid_through === addOneMonth(intent.effective_at)
    )
  ) {
    reasons.push('prepaid_cycle');
  }
  if (reasons.length === 0) return true;

  await updatePaddleBillingIntent(intent.id, {
    status: 'manual_review',
    last_error: `PIX/transaction snapshot divergente: ${reasons.join(',')}`
  });
  if (account) {
    await upsertPaddleBillingAccount({
      ...account,
      state: 'manual_review',
      metadata: {
        ...(account.metadata || {}),
        manual_review_reason: 'completed_transaction_snapshot_mismatch',
        mismatch_fields: reasons
      }
    });
  }
  await appendPaddleBillingAuditLog({
    leona_account_id: intent.leona_account_id,
    actor_type: 'webhook',
    action: 'completed_transaction_manual_review',
    source_event_id: event.event_id,
    metadata: { intent_id: intent.id, transaction_id: data.id, mismatch_fields: reasons }
  });
  return false;
}

async function persistSubscription(event, data, intent = null) {
  const payloadAccountId = accountIdFrom(data);
  const accountId = intent?.leona_account_id || payloadAccountId;
  if (!accountId) return { ignored: 'missing_account_id' };
  const account = await getPaddleBillingAccount(accountId);
  if (!account) return { ignored: 'unknown_account' };
  if (payloadAccountId && intent?.leona_account_id && payloadAccountId !== intent.leona_account_id) {
    await upsertPaddleBillingAccount({
      ...account,
      state: 'manual_review',
      metadata: {
        ...(account.metadata || {}),
        manual_review_reason: 'subscription_intent_account_conflict',
        payload_account_id: payloadAccountId
      }
    });
    return { accountId, action: 'manual_review' };
  }
  const paddleIdentityConflict = (
    account.paddle_customer_id
    && data.customer_id
    && account.paddle_customer_id !== data.customer_id
  ) || (
    account.paddle_subscription_id
    && data.id
    && account.paddle_subscription_id !== data.id
  );
  if (paddleIdentityConflict) {
    await upsertPaddleBillingAccount({
      ...account,
      state: 'manual_review',
      metadata: {
        ...(account.metadata || {}),
        manual_review_reason: 'subscription_paddle_identity_conflict',
        incoming_customer_id: data.customer_id || null,
        incoming_subscription_id: data.id || null
      }
    });
    return { accountId, action: 'manual_review' };
  }

  const quantity = sumRecurringQuantity(data.items);
  const periodEnd = data.current_billing_period?.ends_at || data.next_billed_at || null;
  const previousEntitlement = account.entitled_quantity || 0;
  const paymentPending = intent?.status === 'awaiting_payment'
    || (intent?.kind === 'upgrade_card' && intent?.status === 'applying');
  const detectedDowngrade = quantity < previousEntitlement;
  const pendingQuantity = account.pending_downgrade_quantity
    ?? (detectedDowngrade ? quantity : null);
  const pendingEffectiveAt = account.pending_downgrade_effective_at
    ?? (detectedDowngrade ? periodEnd : null);
  const downgradeMatured = pendingQuantity != null
    && pendingEffectiveAt
    && new Date(pendingEffectiveAt).getTime() <= Date.now();
  const isDeferredDowngrade = pendingQuantity != null && !downgradeMatured;
  const entitledQuantity = paymentPending || isDeferredDowngrade
    ? previousEntitlement
    : quantity;
  const state = data.status === 'trialing' ? 'active' : data.status;

  await upsertPaddleBillingAccount({
    ...account,
    paddle_customer_id: data.customer_id || account.paddle_customer_id,
    paddle_subscription_id: data.id,
    financial_quantity: quantity,
    entitled_quantity: entitledQuantity,
    pending_downgrade_quantity: isDeferredDowngrade ? pendingQuantity : null,
    pending_downgrade_effective_at: isDeferredDowngrade ? pendingEffectiveAt : null,
    paid_through: periodEnd || account.paid_through,
    state: ['active', 'past_due', 'paused', 'canceled'].includes(state) ? state : account.state,
    last_paddle_event_at: event.occurred_at
  });

  if (intent && ['applying', 'paid_pending_apply'].includes(intent.status)) {
    await updatePaddleBillingIntent(intent.id, {
      status: 'applied',
      applied_at: new Date().toISOString(),
      paddle_subscription_id: data.id
    }, intent.status);
  }

  if (!paymentPending && ['active', 'trialing', 'resumed'].includes(String(data.status))) {
    await enqueueEntitlement(event, accountId, {
      status: 'active',
      starter_instances: entitledQuantity,
      ...(periodEnd ? { due_date: dateOnly(periodEnd) } : {})
    });
  } else if (data.status === 'canceled') {
    await enqueueEntitlement(event, accountId, {
      status: 'inactive',
      starter_instances: 0,
      due_date: brtYesterday()
    });
  } else if (data.status === 'paused') {
    await enqueueEntitlement(event, accountId, {
      status: 'inactive',
      starter_instances: 0,
      due_date: brtYesterday()
    });
  }
  return { accountId, quantity, entitledQuantity };
}

async function processCompletedTransaction(event, data) {
  let intent = await resolveIntent(data);
  const accountId = intent?.leona_account_id || accountIdFrom(data);
  if (!intent || !accountId) return { ignored: 'unmanaged_transaction' };
  const accountSnapshot = await getPaddleBillingAccount(accountId);
  if (intent.status === 'applied' && accountSnapshot) {
    await enqueueEntitlement(event, accountId, {
      status: accountSnapshot.state === 'active' ? 'active' : accountSnapshot.state,
      starter_instances: accountSnapshot.entitled_quantity,
      ...(accountSnapshot.paid_through
        ? { due_date: dateOnly(accountSnapshot.paid_through) }
        : {})
    });
    return { accountId, action: 'applied_intent_replayed' };
  }
  if (!await validateCompletedIntent(event, data, intent, accountSnapshot)) {
    return { accountId, action: 'manual_review' };
  }

  const previousStatus = intent.status;
  if (['awaiting_payment', 'applying'].includes(previousStatus)) {
    await updatePaddleBillingIntent(intent.id, {
      status: 'paid_pending_apply',
      paid_at: data.billed_at || data.updated_at || event.occurred_at,
      paddle_subscription_id: data.subscription_id || intent.paddle_subscription_id,
      metadata: {
        ...(intent.metadata || {}),
        transaction_status: data.status,
        origin: data.origin || null
      }
    }, previousStatus);
    intent = { ...intent, status: 'paid_pending_apply' };
  } else {
    await updatePaddleBillingIntent(intent.id, {
      paid_at: data.billed_at || data.updated_at || event.occurred_at,
      paddle_subscription_id: data.subscription_id || intent.paddle_subscription_id,
      metadata: {
        ...(intent.metadata || {}),
        transaction_status: data.status,
        origin: data.origin || null
      }
    });
  }

  if (intent.kind === 'subscribe_pix_prepaid') {
    const account = await getPaddleBillingAccount(accountId);
    const paidThrough = addOneMonth(data.billed_at || event.occurred_at);
    await upsertPaddleBillingAccount({
      ...account,
      leona_account_id: accountId,
      financial_quantity: intent.target_quantity,
      entitled_quantity: intent.target_quantity,
      paid_through: paidThrough,
      state: 'active',
      metadata: {
        ...(account?.metadata || {}),
        prepaid_started_at: data.billed_at || event.occurred_at
      },
      last_paddle_event_at: event.occurred_at
    });
    await updatePaddleBillingIntent(intent.id, {
      status: 'applied',
      applied_at: new Date().toISOString()
    }, 'paid_pending_apply');
    await enqueueEntitlement(event, accountId, {
      status: 'active',
      starter_instances: intent.target_quantity,
      due_date: dateOnly(paidThrough)
    });
    return { accountId, action: 'pix_prepaid_activated' };
  }

  if (intent.kind === 'upgrade_pix') {
    if (!intent.paddle_subscription_id) {
      const account = await getPaddleBillingAccount(accountId);
      await upsertPaddleBillingAccount({
        ...account,
        financial_quantity: intent.target_quantity,
        entitled_quantity: intent.target_quantity,
        pending_downgrade_quantity: null,
        pending_downgrade_effective_at: null,
        state: 'active',
        last_paddle_event_at: event.occurred_at
      });
      await updatePaddleBillingIntent(intent.id, {
        status: 'applied',
        applied_at: new Date().toISOString()
      }, 'paid_pending_apply');
      await enqueueEntitlement(event, accountId, {
        status: 'active',
        starter_instances: intent.target_quantity,
        due_date: dateOnly(account.paid_through)
      });
      return { accountId, action: 'prepaid_pix_upgrade_applied' };
    }
    const subscription = await getSubscription(intent.paddle_subscription_id);
    const recurring = (subscription.items || []).filter(
      item => item?.price?.billing_cycle != null
    );
    if (recurring.length !== 1) throw new Error('Assinatura PIX com itens recorrentes ambíguos');
    let account = await getPaddleBillingAccount(accountId);
    const tier = await recurringTierDiscount(account, intent.target_quantity);
    account = tier.account;
    const updated = await updateSubscription(subscription.id, {
      items: [{ price_id: recurring[0].price.id, quantity: intent.target_quantity }],
      discount: tier.discount,
      proration_billing_mode: 'do_not_bill',
      custom_data: {
        ...(subscription.custom_data || {}),
        leona_account_id: accountId,
        billing_intent_id: intent.id
      }
    });
    await upsertPaddleBillingAccount({
      ...account,
      financial_quantity: intent.target_quantity,
      entitled_quantity: intent.target_quantity,
      pending_downgrade_quantity: null,
      paddle_subscription_id: updated.id,
      state: updated.status === 'trialing' ? 'active' : updated.status,
      last_paddle_event_at: event.occurred_at
    });
    await updatePaddleBillingIntent(intent.id, {
      status: 'applied',
      applied_at: new Date().toISOString()
    }, 'paid_pending_apply');
    await enqueueEntitlement(event, accountId, {
      status: 'active',
      starter_instances: intent.target_quantity,
      ...(subscription.current_billing_period?.ends_at
        ? { due_date: dateOnly(subscription.current_billing_period.ends_at) }
        : {})
    });
    return { accountId, action: 'pix_upgrade_applied' };
  }

  if (intent.kind === 'renew_pix') {
    if (!intent.paddle_subscription_id) {
      const account = await getPaddleBillingAccount(accountId);
      const expectedAdvancedAt = addOneMonth(intent.effective_at);
      const nextPaidThrough = account.paid_through === expectedAdvancedAt
        ? account.paid_through
        : addOneMonth(account.paid_through || event.occurred_at);
      await upsertPaddleBillingAccount({
        ...account,
        paid_through: nextPaidThrough,
        state: 'active',
        metadata: {
          ...(account.metadata || {}),
          prepaid_last_renewed_at: event.occurred_at
        },
        last_paddle_event_at: event.occurred_at
      });
      await updatePaddleBillingIntent(intent.id, {
        status: 'applied',
        applied_at: new Date().toISOString()
      }, 'paid_pending_apply');
      await enqueueEntitlement(event, accountId, {
        status: 'active',
        starter_instances: intent.target_quantity,
        due_date: dateOnly(nextPaidThrough)
      });
      return { accountId, action: 'prepaid_pix_renewal_applied' };
    }
    const subscription = await getSubscription(intent.paddle_subscription_id);
    const currentEnd = subscription.current_billing_period?.ends_at || subscription.next_billed_at;
    const expectedPreviousEnd = intent.metadata?.billing_period_end;
    const expectedAdvancedEnd = addOneMonth(expectedPreviousEnd);
    const alreadyAdvanced = expectedAdvancedEnd && currentEnd === expectedAdvancedEnd;
    const nextBilledAt = alreadyAdvanced ? currentEnd : addOneMonth(currentEnd);
    if (!nextBilledAt) throw new Error('Assinatura PIX sem vencimento válido');
    const updated = alreadyAdvanced
      ? subscription
      : await updateSubscription(subscription.id, {
          next_billed_at: nextBilledAt,
          proration_billing_mode: 'do_not_bill',
          custom_data: {
            ...(subscription.custom_data || {}),
            leona_account_id: accountId,
            billing_intent_id: intent.id
          }
        });
    const account = await getPaddleBillingAccount(accountId);
    await upsertPaddleBillingAccount({
      ...account,
      paid_through: nextBilledAt,
      state: updated.status === 'trialing' ? 'active' : updated.status,
      last_paddle_event_at: event.occurred_at
    });
    await updatePaddleBillingIntent(intent.id, {
      status: 'applied',
      applied_at: new Date().toISOString()
    }, 'paid_pending_apply');
    await enqueueEntitlement(event, accountId, {
      status: 'active',
      starter_instances: intent.target_quantity,
      due_date: dateOnly(nextBilledAt)
    });
    return { accountId, action: 'pix_renewal_applied' };
  }

  if (data.subscription_id) {
    const subscription = await getSubscription(data.subscription_id);
    return persistSubscription(event, subscription, intent);
  }
  return { accountId, action: 'awaiting_subscription_event' };
}

async function processAdjustment(event, data) {
  if (String(data.status).toLowerCase() !== 'approved') {
    return { ignored: 'adjustment_not_approved' };
  }
  const transactionId = data.transaction_id;
  if (!transactionId) return { ignored: 'missing_transaction_id' };
  const transaction = await getTransaction(transactionId);
  const intent = await getPaddleBillingIntentByTransaction(transactionId);
  const transactionAccountId = accountIdFrom(transaction);
  const accountId = intent?.leona_account_id || transactionAccountId;
  if (!accountId) return { ignored: 'unmanaged_adjustment' };
  if (
    transactionAccountId
    && intent?.leona_account_id
    && transactionAccountId !== intent.leona_account_id
  ) {
    const conflictedAccount = await getPaddleBillingAccount(intent.leona_account_id);
    if (conflictedAccount) {
      await upsertPaddleBillingAccount({
        ...conflictedAccount,
        state: 'manual_review'
      });
    }
    await appendPaddleBillingAuditLog({
      leona_account_id: intent.leona_account_id,
      actor_type: 'webhook',
      action: 'adjustment_account_conflict',
      source_event_id: event.event_id,
      metadata: { transaction_id: transactionId, transaction_account_id: transactionAccountId }
    });
    return { accountId: intent.leona_account_id, action: 'manual_review' };
  }
  const account = await getPaddleBillingAccount(accountId);
  if (!account) return { ignored: 'unknown_account' };
  const adjustmentIdentityConflict = (
    account.paddle_customer_id
    && transaction.customer_id
    && account.paddle_customer_id !== transaction.customer_id
  ) || (
    account.paddle_subscription_id
    && transaction.subscription_id
    && account.paddle_subscription_id !== transaction.subscription_id
  );
  if (adjustmentIdentityConflict) {
    await upsertPaddleBillingAccount({
      ...account,
      state: 'manual_review',
      metadata: {
        ...(account.metadata || {}),
        manual_review_reason: 'adjustment_paddle_identity_conflict',
        transaction_id: transactionId
      }
    });
    await appendPaddleBillingAuditLog({
      leona_account_id: accountId,
      actor_type: 'webhook',
      action: 'adjustment_paddle_identity_conflict',
      source_event_id: event.event_id,
      metadata: { transaction_id: transactionId }
    });
    return { accountId, action: 'manual_review' };
  }

  const action = String(data.action || data.type || '').toLowerCase();
  if (action.includes('chargeback') && action.includes('reverse')) {
    await appendPaddleBillingAuditLog({
      leona_account_id: accountId,
      actor_type: 'webhook',
      action: 'chargeback_reversal_requires_reconciliation',
      source_event_id: event.event_id,
      metadata: { adjustment_id: data.id, transaction_id: transactionId }
    });
    return { accountId, action: 'chargeback_reversal_manual_review' };
  }
  const isChargeback = action.includes('chargeback');
  const amount = adjustmentAmount(data);
  const total = transactionTotal(transaction);
  const isFullRefund = action.includes('refund')
    && (
      String(data.type || '').toLowerCase() === 'full'
      || (amount != null && total != null && amount >= total)
    );
  if (!isChargeback && !isFullRefund) {
    await appendPaddleBillingAuditLog({
      leona_account_id: accountId,
      actor_type: 'webhook',
      action: 'partial_adjustment_recorded',
      source_event_id: event.event_id,
      metadata: { adjustment_id: data.id, transaction_id: transactionId, amount, total }
    });
    return { accountId, action: 'partial_adjustment_no_entitlement_change' };
  }

  await upsertPaddleBillingAccount({
    ...account,
    entitled_quantity: 0,
    paid_through: new Date(`${brtYesterday()}T23:59:59-03:00`).toISOString(),
    state: 'suspended',
    last_paddle_event_at: event.occurred_at
  });
  if (intent) {
    await updatePaddleBillingIntent(intent.id, {
      status: isChargeback ? 'disputed' : 'refunded',
      paddle_adjustment_id: data.id
    });
  }
  await enqueueEntitlement(event, accountId, {
    status: 'inactive',
    starter_instances: 0,
    due_date: brtYesterday()
  });
  if (account?.paddle_subscription_id) {
    try {
      await cancelSubscription(account.paddle_subscription_id, 'immediately');
    } catch (error) {
      await appendPaddleBillingAuditLog({
        leona_account_id: accountId,
        actor_type: 'webhook',
        action: 'subscription_cancel_after_adjustment_failed',
        source_event_id: event.event_id,
        metadata: {
          subscription_id: account.paddle_subscription_id,
          error: String(error?.message || error)
        }
      });
    }
  }
  await appendPaddleBillingAuditLog({
    leona_account_id: accountId,
    actor_type: 'webhook',
    action: isChargeback ? 'chargeback_entitlement_revoked' : 'full_refund_entitlement_revoked',
    source_event_id: event.event_id,
    metadata: { adjustment_id: data.id, transaction_id: transactionId, amount, total }
  });
  return { accountId, action: isChargeback ? 'chargeback_revoked' : 'full_refund_revoked' };
}

export async function processPaddleWebhookEvent(event) {
  const payload = event.payload;
  const type = payload.event_type;
  const data = payload.data || {};
  const entityKey = `${type.split('.')[0]}:${data.id || event.entity_id || 'unknown'}`;
  const directAccountId = accountIdFrom(data) || event.leona_account_id || null;
  if (directAccountId) {
    const current = await getPaddleBillingAccount(directAccountId);
    const cursor = current?.metadata?.event_cursors?.[entityKey];
    if (cursor && new Date(event.occurred_at).getTime() <= new Date(cursor).getTime()) {
      const stale = { ignored: 'stale_or_duplicate_entity_event' };
      await updatePaddleWebhookEvent(event.event_id, {
        status: 'ignored',
        leona_account_id: directAccountId,
        processed_at: new Date().toISOString(),
        last_error: null
      }, 'processing');
      return stale;
    }
  }
  let result;

  if (type === 'transaction.completed') {
    result = await processCompletedTransaction(event, data);
  } else if (type === 'transaction.payment_failed') {
    const intent = await resolveIntent(data);
    if (intent && ['awaiting_payment', 'applying'].includes(intent.status)) {
      await updatePaddleBillingIntent(intent.id, {
        status: 'failed',
        last_error: 'transaction.payment_failed'
      }, intent.status);
      const account = await getPaddleBillingAccount(intent.leona_account_id);
      if (account?.state === 'checkout_pending') {
        await upsertPaddleBillingAccount({
          ...account,
          state: account.paddle_subscription_id ? 'active' : 'unlinked'
        });
      }
    }
    result = { accountId: intent?.leona_account_id, action: 'payment_failed' };
  } else if (type.startsWith('subscription.')) {
    result = await persistSubscription(event, data, await resolveIntent(data));
  } else if (type.startsWith('adjustment.')) {
    result = await processAdjustment(event, data);
  } else {
    result = { ignored: 'unsupported_event_type' };
  }

  if (result.accountId) {
    const account = await getPaddleBillingAccount(result.accountId);
    if (account) {
      await upsertPaddleBillingAccount({
        ...account,
        metadata: {
          ...(account.metadata || {}),
          event_cursors: {
            ...(account.metadata?.event_cursors || {}),
            [entityKey]: event.occurred_at
          }
        },
        last_paddle_event_at: event.occurred_at
      });
    }
  }

  await updatePaddleWebhookEvent(event.event_id, {
    status: result.ignored ? 'ignored' : 'processed',
    leona_account_id: result.accountId || event.leona_account_id || null,
    processed_at: new Date().toISOString(),
    last_error: null
  }, 'processing');
  return result;
}
