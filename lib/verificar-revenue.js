import {
  LEONA_BASE,
  getLeonaBillingProfile,
  getLeonaLifetimeRevenue,
  leonaHeaders
} from './leona.js';
import { formatBrl, pickBrlLifetimeRevenue } from './trilha-prizes.js';

export function normalizeVerificarEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isVerificarEmail(value) {
  const email = normalizeVerificarEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function revenueBrlFromLifetime(lifetime) {
  const brl = pickBrlLifetimeRevenue(lifetime);
  if (typeof brl === 'number' && Number.isFinite(brl)) return brl;
  const fallback = Number(lifetime?.revenue_brl);
  return Number.isFinite(fallback) ? fallback : 0;
}

export function presentVerificarAccount(profile, lifetime) {
  const value = revenueBrlFromLifetime(lifetime);
  return {
    account_id: profile?.account_id ?? null,
    name: profile?.user?.name || null,
    email: profile?.user?.email || null,
    status: profile?.subscription_status || null,
    plan: profile?.plan_summary || null,
    revenue_brl: value,
    revenue_formatted: formatBrl(value),
    revenue_by_currency: lifetime?.revenue_by_currency || null
  };
}

export function presentVerificarResult(email, accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const total = rows.reduce((sum, row) => sum + (Number(row.revenue_brl) || 0), 0);
  return {
    email: normalizeVerificarEmail(email),
    found: rows.length > 0,
    total_brl: total,
    total_formatted: formatBrl(total),
    accounts: rows
  };
}

export async function listLeonaProfilesByEmail(email, leonaToken) {
  const emailClean = normalizeVerificarEmail(email);
  if (!emailClean || !leonaToken) return { ok: false, status: 400, profiles: [] };

  const headers = leonaHeaders(leonaToken);
  try {
    const r = await fetch(
      `${LEONA_BASE}/accounts/billing_profile?email=${encodeURIComponent(emailClean)}`,
      { headers }
    );

    if (r.ok) {
      const profile = await r.json();
      return { ok: true, status: 200, profiles: profile?.account_id ? [profile] : [] };
    }

    if (r.status === 404) return { ok: true, status: 404, profiles: [] };

    if (r.status === 409) {
      const conflict = await r.json().catch(() => ({}));
      const ids = Array.isArray(conflict.account_ids) ? conflict.account_ids : [];
      const profiles = await Promise.all(
        ids.map((id) => getLeonaBillingProfile(id, leonaToken))
      );
      return { ok: true, status: 409, profiles: profiles.filter((row) => row?.account_id) };
    }

    return { ok: false, status: r.status, profiles: [] };
  } catch (error) {
    console.error('listLeonaProfilesByEmail:', error.message);
    return { ok: false, status: 502, profiles: [] };
  }
}

export async function lookupVerificarRevenue(email, leonaToken) {
  const emailClean = normalizeVerificarEmail(email);
  const listed = await listLeonaProfilesByEmail(emailClean, leonaToken);
  if (!listed.ok) {
    return { ok: false, status: listed.status === 400 ? 400 : 502, body: { error: 'Falha ao consultar o Leona' } };
  }

  const accounts = await Promise.all(
    listed.profiles.map(async (profile) => {
      const lifetime = await getLeonaLifetimeRevenue(profile.account_id, leonaToken);
      return presentVerificarAccount(profile, lifetime);
    })
  );

  return {
    ok: true,
    status: accounts.length ? 200 : 404,
    body: presentVerificarResult(emailClean, accounts)
  };
}
