import { applyCors } from '../lib/auth.js';
import { resolveTrilhaRedeemEligibility } from '../lib/trilha-eligibility.js';
import { resolveTrilhaAccess } from '../lib/trilha-access.js';
import {
  buildTrilhaPayload,
  resolveTrilhaRevenue
} from '../lib/trilha-prizes.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Metodo nao permitido' });

  res.setHeader('Cache-Control', 'no-store');

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN nao configurado' });

  const guruToken = process.env.GURU_TOKEN || null;
  const accountId = (req.query?.id || req.query?.account_id || '').trim();
  const email = (req.query?.email || '').trim();

  try {
    const access = await resolveTrilhaAccess({ accountId, email, leonaToken });
    if (!access.ok) {
      return res.status(access.status).json(access.body);
    }

    const { profile, profileEmail, demo } = access;
    const redeemEligibility = await resolveTrilhaRedeemEligibility({
      accountId: profile.account_id ?? accountId,
      email: profileEmail,
      guruToken
    });

    const profileRevenue = profile.total_revenue ?? profile.lifetime_revenue ?? profile.revenue ?? null;
    const { value: revenueValue, source: revenueSource } = resolveTrilhaRevenue(accountId, profileRevenue);

    return res.status(200).json(buildTrilhaPayload({
      accountId: String(profile.account_id ?? accountId),
      profile,
      revenueValue,
      revenueSource,
      redeemEligibility,
      demo
    }));
  } catch (error) {
    console.error('trilha error:', error);
    return res.status(500).json({ error: error.message || 'Erro interno' });
  }
}
