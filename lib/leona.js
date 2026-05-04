/**
 * lib/leona.js - Helpers compartilhados para chamar a API de integração do Leona.
 *
 * Usado por api/paddle-subscription.js e api/webhook-paddle.js para que a
 * lógica de lookup por email (com tratamento de 409) e atualização de
 * billing_profile fique num único lugar.
 */

export const LEONA_BASE = 'https://apiaws.leonasolutions.io/api/v1/integration';

export function leonaHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

export async function findLeonaAccountByEmail(email, leonaToken) {
  if (!email || !leonaToken) return null;
  const headers = leonaHeaders(leonaToken);

  try {
    const r = await fetch(
      `${LEONA_BASE}/accounts/billing_profile?email=${encodeURIComponent(email.trim().toLowerCase())}`,
      { headers }
    );

    if (r.ok) {
      const profile = await r.json();
      return { account_id: profile.account_id, profile };
    }

    if (r.status === 409) {
      const conflict = await r.json().catch(() => ({}));
      const ids = Array.isArray(conflict.account_ids) ? conflict.account_ids : [];
      if (ids.length === 0) return null;

      const profiles = await Promise.all(ids.map(async (id) => {
        try {
          const pr = await fetch(`${LEONA_BASE}/accounts/${id}/billing_profile`, { headers });
          if (pr.ok) return await pr.json();
        } catch (_) {}
        return null;
      }));

      const valid = profiles.filter(Boolean);
      const active = valid.filter(p =>
        p.subscription_status === 'active' &&
        p.current_period_end &&
        new Date(p.current_period_end) > new Date()
      );

      if (active.length === 1) return { account_id: active[0].account_id, profile: active[0] };
      return null;
    }
  } catch (e) {
    console.error('findLeonaAccountByEmail: erro:', e.message);
  }
  return null;
}

export async function updateLeonaBillingProfile(accountId, payload, leonaToken) {
  if (!accountId || !leonaToken) return { ok: false, error: 'sem accountId/token' };

  const headers = leonaHeaders(leonaToken);
  try {
    const r = await fetch(`${LEONA_BASE}/accounts/${accountId}/billing_profile`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getLeonaBillingProfile(accountId, leonaToken) {
  if (!accountId || !leonaToken) return null;
  try {
    const r = await fetch(`${LEONA_BASE}/accounts/${accountId}/billing_profile`, {
      headers: leonaHeaders(leonaToken)
    });
    if (r.ok) return await r.json();
  } catch (e) {
    console.error('getLeonaBillingProfile: erro:', e.message);
  }
  return null;
}
