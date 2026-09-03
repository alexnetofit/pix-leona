import { applyCors } from '../lib/auth.js';
import { getLeonaLifetimeRevenue } from '../lib/leona.js';
import { resolveTrilhaRedeemEligibility } from '../lib/trilha-eligibility.js';
import { resolveTrilhaAccess } from '../lib/trilha-access.js';
import {
  attachPontohubTracking,
  presentTrilhaOrders,
  purchasedPrizeIdsFromCheckouts
} from '../lib/trilha-account-orders.js';
import { listTrilhaAccountCheckouts } from '../lib/trilha-fulfill.js';
import {
  buildTrilhaPayload,
  pickBrlLifetimeRevenue,
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
    const resolvedAccountId = String(profile.account_id ?? accountId);

    const [redeemEligibility, lifetime] = await Promise.all([
      resolveTrilhaRedeemEligibility({
        accountId: resolvedAccountId,
        email: profileEmail,
        guruToken
      }),
      demo ? Promise.resolve(null) : getLeonaLifetimeRevenue(resolvedAccountId, leonaToken)
    ]);

    const apiRevenue = pickBrlLifetimeRevenue(lifetime);
    const profileRevenue = profile.total_revenue ?? profile.lifetime_revenue ?? profile.revenue ?? null;
    const { value: revenueValue, source: revenueSource } = resolveTrilhaRevenue(
      resolvedAccountId,
      apiRevenue ?? profileRevenue
    );

    let checkouts = [];
    try {
      checkouts = await listTrilhaAccountCheckouts(resolvedAccountId);
    } catch (error) {
      console.error('trilha orders:', error);
    }
    const purchasedPrizeIds = purchasedPrizeIdsFromCheckouts(checkouts);
    let orders = presentTrilhaOrders(checkouts);
    try {
      orders = await attachPontohubTracking(orders);
    } catch (error) {
      console.error('trilha tracking:', error);
    }

    return res.status(200).json(buildTrilhaPayload({
      accountId: resolvedAccountId,
      profile,
      revenueValue,
      revenueSource,
      redeemEligibility,
      demo,
      purchasedPrizeIds,
      orders,
      revenueByCurrency: lifetime?.revenue_by_currency || null,
      revenueComputedAt: lifetime?.computed_at || null
    }));
  } catch (error) {
    console.error('trilha error:', error);
    return res.status(500).json({ error: error.message || 'Erro interno' });
  }
}

