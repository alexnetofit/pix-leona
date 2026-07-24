import {
  claimPaddleLeonaOutbox,
  getPaddleBillingAccount,
  updatePaddleLeonaOutbox
} from '../../lib/paddle-ledger.js';
import { updateLeonaBillingProfile } from '../../lib/leona.js';
import { timingSafeStringEqual } from '../../lib/paddle-session.js';

function authorized(req) {
  const expected = process.env.CRON_SECRET || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
}

function nextAttempt(attempts) {
  const delayMinutes = Math.min(2 ** Math.max(attempts - 1, 0), 360);
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  const token = process.env.LEONA_BILLING_TOKEN;
  if (!token) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });

  const entries = await claimPaddleLeonaOutbox({ limit: 20 });
  const results = [];
  for (const entry of entries) {
    const account = await getPaddleBillingAccount(entry.leona_account_id);
    if (
      account
      && Number(entry.entitlement_version) < Number(account.entitlement_version)
    ) {
      await updatePaddleLeonaOutbox(entry.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        last_error: 'Ignorado: versão de entitlement obsoleta'
      }, 'processing');
      results.push({ id: entry.id, ok: true, stale: true });
      continue;
    }
    const response = await updateLeonaBillingProfile(
      entry.leona_account_id,
      entry.desired_payload,
      token
    );
    if (response.ok) {
      await updatePaddleLeonaOutbox(entry.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        last_error: null
      }, 'processing');
      results.push({ id: entry.id, ok: true });
      continue;
    }

    const terminal = entry.attempts >= 10;
    const error = response.error || `Leona HTTP ${response.status}`;
    await updatePaddleLeonaOutbox(entry.id, {
      status: terminal ? 'dead_letter' : 'failed',
      next_attempt_at: nextAttempt(entry.attempts),
      last_error: String(error).slice(0, 1000)
    }, 'processing');
    results.push({ id: entry.id, ok: false, terminal, error });
  }
  return res.status(200).json({ claimed: entries.length, results });
}
