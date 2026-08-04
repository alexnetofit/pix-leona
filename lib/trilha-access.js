import { assertAccountAccess } from './leona.js';

export const TRILHA_DEMO_ACCOUNT_ID = '1234';
export const TRILHA_DEMO_EMAIL = 'teste123@gmail.com';

export const TRILHA_DEMO_PROFILE = {
  account_id: 1234,
  subscription_type: 'custom',
  user: {
    name: 'Conta Demo',
    email: TRILHA_DEMO_EMAIL,
    phone: null
  },
  plan_summary: '1 Starter',
  starter_instances: 1,
  pro_instances: 0,
  subscription_status: 'active',
  rewardful_referral: null,
  guru_account_id: null
};

export function isTrilhaDemoAccess(accountId, email) {
  return String(accountId || '').trim() === TRILHA_DEMO_ACCOUNT_ID
    && String(email || '').trim().toLowerCase() === TRILHA_DEMO_EMAIL;
}

export async function resolveTrilhaAccess({ accountId, email, leonaToken }) {
  const accountIdRaw = String(accountId || '').trim();
  const emailNorm = String(email || '').trim().toLowerCase();

  if (!accountIdRaw) {
    return { ok: false, status: 400, body: { error: 'Informe ?id=<account_id> da conta Leona' } };
  }
  if (!emailNorm) {
    return { ok: false, status: 400, body: { error: 'Informe ?email= do titular da conta Leona' } };
  }

  if (isTrilhaDemoAccess(accountIdRaw, emailNorm)) {
    return {
      ok: true,
      profile: TRILHA_DEMO_PROFILE,
      profileEmail: emailNorm,
      demo: true
    };
  }

  const access = await assertAccountAccess({
    accountId: accountIdRaw,
    queryEmail: emailNorm,
    leonaToken,
    route: '/api/trilha'
  });

  if (!access.ok) {
    return { ok: false, status: access.status, body: access.body };
  }

  return {
    ok: true,
    profile: access.profile,
    profileEmail: access.profileEmail,
    demo: false
  };
}
