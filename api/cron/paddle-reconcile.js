import { getSubscription } from '../../lib/paddle-client.js';
import {
  enqueuePaddleLeonaOutbox,
  listPaddleBillingAccounts,
  paddleFirstEnabled,
  upsertPaddleBillingAccount
} from '../../lib/paddle-ledger.js';
import { brtYesterday, sumRecurringQuantity } from '../../lib/paddle-policy.js';
import { timingSafeStringEqual } from '../../lib/paddle-session.js';

function authorized(req) {
  const expected = process.env.CRON_SECRET || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  if (!paddleFirstEnabled()) {
    return res.status(200).json({ skipped: 'paddle_first_disabled' });
  }

  const accounts = await listPaddleBillingAccounts({ limit: 100 });
  const results = [];
  for (const account of accounts) {
    try {
      if (!account.paddle_subscription_id) {
        const expired = account.paid_through
          && new Date(account.paid_through).getTime() <= Date.now();
        const downgradeMatured = account.pending_downgrade_quantity != null
          && account.pending_downgrade_effective_at
          && new Date(account.pending_downgrade_effective_at).getTime() <= Date.now();
        if (expired || downgradeMatured) {
          const entitledQuantity = expired ? 0 : account.pending_downgrade_quantity;
          await enqueuePaddleLeonaOutbox({
            leona_account_id: account.leona_account_id,
            desired_payload: expired
              ? { status: 'inactive', starter_instances: 0, due_date: brtYesterday() }
              : {
                  status: 'active',
                  starter_instances: entitledQuantity,
                  due_date: String(account.paid_through).slice(0, 10)
                }
          });
          await upsertPaddleBillingAccount({
            ...account,
            entitled_quantity: entitledQuantity,
            pending_downgrade_quantity: null,
            pending_downgrade_effective_at: null,
            state: expired ? 'suspended' : 'active',
            last_reconciled_at: new Date().toISOString()
          });
        } else {
          await upsertPaddleBillingAccount({
            ...account,
            last_reconciled_at: new Date().toISOString()
          });
        }
        results.push({ account_id: account.leona_account_id, ok: true });
        continue;
      }
      const subscription = await getSubscription(account.paddle_subscription_id);
      const financialQuantity = sumRecurringQuantity(subscription.items);
      const periodEnd = subscription.current_billing_period?.ends_at || null;
      const downgradeMatured = account.pending_downgrade_quantity != null
        && account.pending_downgrade_effective_at
        && new Date(account.pending_downgrade_effective_at).getTime() <= Date.now();
      const revoked = ['canceled', 'paused'].includes(subscription.status);
      const projectPaused = subscription.status === 'paused' && account.entitled_quantity !== 0;
      const shouldProject = projectPaused || downgradeMatured;
      const entitledQuantity = revoked
        ? 0
        : (downgradeMatured ? financialQuantity : account.entitled_quantity);

      if (shouldProject) {
        await enqueuePaddleLeonaOutbox({
          leona_account_id: account.leona_account_id,
          desired_payload: projectPaused
            ? { status: 'inactive', starter_instances: 0, due_date: brtYesterday() }
            : {
                status: 'active',
                starter_instances: financialQuantity,
                due_date: String(periodEnd).slice(0, 10)
              }
        });
      }
      await upsertPaddleBillingAccount({
        ...account,
        financial_quantity: financialQuantity,
        entitled_quantity: entitledQuantity,
        pending_downgrade_quantity: downgradeMatured
          ? null
          : account.pending_downgrade_quantity,
        pending_downgrade_effective_at: downgradeMatured
          ? null
          : account.pending_downgrade_effective_at,
        paid_through: periodEnd || account.paid_through,
        state: revoked
          ? (subscription.status === 'canceled' ? 'canceled' : 'paused')
          : (subscription.status === 'trialing' ? 'active' : subscription.status),
        last_reconciled_at: new Date().toISOString()
      });
      results.push({ account_id: account.leona_account_id, ok: true });
    } catch (error) {
      results.push({
        account_id: account.leona_account_id,
        ok: false,
        error: String(error?.message || error)
      });
    }
  }
  return res.status(200).json({ checked: accounts.length, results });
}
