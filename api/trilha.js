import { applyCors } from '../lib/auth.js';
import { getLeonaBillingProfile } from '../lib/leona.js';
import { resolveTrilhaRedeemEligibility } from '../lib/trilha-eligibility.js';
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
  if (!accountId) {
    return res.status(400).json({ error: 'Informe ?id=<account_id> da conta Leona' });
  }

  try {
    const profile = await getLeonaBillingProfile(accountId, leonaToken);
    if (!profile) {
      return res.status(404).json({ error: `Conta ${accountId} nao encontrada` });
    }

    const email = profile?.user?.email || null;
    const redeemEligibility = await resolveTrilhaRedeemEligibility({
      accountId,
      email,
      guruToken
    });

    const profileRevenue = profile.total_revenue ?? profile.lifetime_revenue ?? profile.revenue ?? null;
    const { value: revenueValue, source: revenueSource } = resolveTrilhaRevenue(accountId, profileRevenue);

    return res.status(200).json(buildTrilhaPayload({
      accountId,
      profile,
      revenueValue,
      revenueSource,
      redeemEligibility
    }));
  } catch (error) {
    console.error('trilha error:', error);
    return res.status(500).json({ error: error.message || 'Erro interno' });
  }
}
