/**
 * POST /api/trilha-100k-group — puxa o WhatsApp informado para o grupo da Cúpula dos 100k.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { getLeonaLifetimeRevenue } from '../lib/leona.js';
import { resolveTrilhaAccess } from '../lib/trilha-access.js';
import {
  addPhoneToTrilha100kGroup,
  normalizeWhatsappNumber,
  TRILHA_100K_MILESTONE,
  trilha100kHelpUrl,
  trilha100kGroupConfig
} from '../lib/trilha-100k-group.js';
import { pickBrlLifetimeRevenue, resolveTrilhaRevenue } from '../lib/trilha-prizes.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });

  const body = req.body || {};
  const access = await resolveTrilhaAccess({
    accountId: body.account_id || body.id,
    email: body.email,
    leonaToken
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const resolvedAccountId = String(access.profile.account_id ?? body.account_id);
  const profileEmail = access.profileEmail;
  const helpUrl = trilha100kHelpUrl(profileEmail, trilha100kGroupConfig().helpPhone);

  const parsed = normalizeWhatsappNumber(body.whatsapp || body.phone || body.numero);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error, help_url: helpUrl });
  }

  try {
    const lifetime = access.demo
      ? null
      : await getLeonaLifetimeRevenue(resolvedAccountId, leonaToken);
    const apiRevenue = pickBrlLifetimeRevenue(lifetime);
    const profileRevenue = access.profile.total_revenue
      ?? access.profile.lifetime_revenue
      ?? access.profile.revenue
      ?? null;
    const { value: revenueValue } = resolveTrilhaRevenue(
      resolvedAccountId,
      apiRevenue ?? profileRevenue,
      profileEmail
    );

    if (revenueValue < TRILHA_100K_MILESTONE) {
      return res.status(403).json({
        error: 'Ainda não atingiu R$ 100 mil de faturamento',
        help_url: helpUrl
      });
    }

    const result = await addPhoneToTrilha100kGroup(parsed.phone);
    logAssinaturaEvent(req, {
      action: result.ok ? 'trilha_100k_group_joined' : 'trilha_100k_group_failed',
      provider: 'uazapi',
      email: profileEmail,
      account_id: resolvedAccountId,
      details: { phone: parsed.phone, already: Boolean(result.already), reason: result.reason || null }
    });

    if (!result.ok) {
      return res.status(502).json({
        error: result.reason || 'Não foi possível entrar no grupo',
        help_url: helpUrl
      });
    }

    return res.status(200).json({
      ok: true,
      already: Boolean(result.already),
      phone: parsed.phone
    });
  } catch (error) {
    console.error('trilha-100k-group:', error);
    return res.status(500).json({
      error: error.message || 'Erro interno',
      help_url: helpUrl
    });
  }
}
