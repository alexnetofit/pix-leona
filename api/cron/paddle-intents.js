import { getTransaction, listTransactions } from '../../lib/paddle-client.js';
import {
  getPaddleBillingAccount,
  insertPaddleWebhookEvent,
  listStalePaddleBillingIntents,
  paddleFirstEnabled,
  updatePaddleBillingIntent,
  upsertPaddleBillingAccount
} from '../../lib/paddle-ledger.js';
import { timingSafeStringEqual } from '../../lib/paddle-session.js';

function authorized(req) {
  const expected = process.env.CRON_SECRET || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

async function findIntentTransaction(intent) {
  if (intent.paddle_transaction_id) {
    return getTransaction(intent.paddle_transaction_id);
  }
  const transactions = await listTransactions({
    customer_id: intent.paddle_customer_id,
    per_page: 100
  });
  return transactions.find(
    item => item.custom_data?.billing_intent_id === intent.id
  ) || null;
}

async function enqueueRecoveredCompletedTransaction(intent, transaction) {
  await updatePaddleBillingIntent(intent.id, {
    paddle_transaction_id: transaction.id
  });
  await insertPaddleWebhookEvent({
    event_id: `reconcile:${transaction.id}`,
    event_type: 'transaction.completed',
    occurred_at: transaction.updated_at || transaction.billed_at || new Date().toISOString(),
    entity_id: transaction.id,
    leona_account_id: intent.leona_account_id,
    payload: {
      event_id: `reconcile:${transaction.id}`,
      event_type: 'transaction.completed',
      occurred_at: transaction.updated_at || transaction.billed_at || new Date().toISOString(),
      data: transaction
    }
  });
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  if (!paddleFirstEnabled()) {
    return res.status(200).json({ skipped: 'paddle_first_disabled' });
  }

  const intents = await listStalePaddleBillingIntents({ limit: 100 });
  const results = [];
  for (const intent of intents) {
    try {
      if (intent.kind === 'downgrade' && intent.status === 'created') {
        const account = await getPaddleBillingAccount(intent.leona_account_id);
        const applied = account?.financial_quantity === intent.target_quantity;
        await updatePaddleBillingIntent(intent.id, {
          status: applied ? 'applied' : 'manual_review',
          ...(applied ? { applied_at: new Date().toISOString() } : {
            last_error: 'Downgrade interrompido antes da confirmação'
          })
        }, 'created');
        results.push({ intent_id: intent.id, action: applied ? 'applied' : 'manual_review' });
        continue;
      }

      const transaction = await findIntentTransaction(intent);
      if (transaction?.status === 'completed') {
        await enqueueRecoveredCompletedTransaction(intent, transaction);
        results.push({ intent_id: intent.id, action: 'webhook_recovered' });
        continue;
      }
      if (['canceled', 'past_due'].includes(transaction?.status)) {
        await updatePaddleBillingIntent(intent.id, {
          status: 'failed',
          last_error: `Transaction ${transaction.status}`
        }, intent.status);
        results.push({ intent_id: intent.id, action: 'failed' });
        continue;
      }

      const expired = intent.expires_at
        ? new Date(intent.expires_at).getTime() <= Date.now()
        : new Date(intent.created_at).getTime() <= Date.now() - 24 * 60 * 60 * 1000;
      if (intent.status === 'awaiting_payment' && expired) {
        await updatePaddleBillingIntent(intent.id, {
          status: 'expired',
          last_error: 'Checkout expirado ou abandonado'
        }, 'awaiting_payment');
        const account = await getPaddleBillingAccount(intent.leona_account_id);
        if (account?.state === 'checkout_pending') {
          await upsertPaddleBillingAccount({
            ...account,
            state: account.paddle_subscription_id ? 'active' : 'unlinked'
          });
        }
        results.push({ intent_id: intent.id, action: 'expired' });
        continue;
      }

      if (['applying', 'paid_pending_apply'].includes(intent.status)) {
        await updatePaddleBillingIntent(intent.id, {
          status: 'manual_review',
          last_error: 'Aplicação sem conclusão após timeout'
        }, intent.status);
        const account = await getPaddleBillingAccount(intent.leona_account_id);
        if (account) {
          await upsertPaddleBillingAccount({ ...account, state: 'manual_review' });
        }
        results.push({ intent_id: intent.id, action: 'manual_review' });
      }
    } catch (error) {
      results.push({
        intent_id: intent.id,
        action: 'error',
        error: String(error?.message || error)
      });
    }
  }
  return res.status(200).json({ checked: intents.length, results });
}
