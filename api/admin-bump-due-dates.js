/**
 * admin-bump-due-dates.js — script retroativo (one-shot).
 *
 * Aplica a invariante Leona = Guru + 1 dia em todas as contas existentes.
 *
 * Itera todas as subscriptions Guru ATIVAS do produto Leona, identifica
 * a conta Leona vinculada (via guru_account_id) e bumpa o due_date pra
 * cycle_end_date da Guru + 1 dia.
 *
 * Idempotente: se a conta Leona ja esta com due_date >= alvo, pula.
 *
 * Seguranca:
 *   - Header obrigatorio: x-admin-secret = env ADMIN_BUMP_SECRET
 *   - Default dry_run=true: apenas relatorio, nao escreve.
 *   - Para executar de verdade: body { "dry_run": false }
 *
 * Retorna JSON com:
 *   - total_subs_scanned
 *   - total_eligible
 *   - skipped: { no_email, no_leona_match, no_guru_link, already_bumped, error }
 *   - total_updated (so quando dry_run=false)
 *   - actions: lista detalhada por conta
 */

import { GURU_BASE, LEONA_GURU_PRODUCT_ID, guruHeaders } from '../lib/guru.js';
import { LEONA_BASE, leonaHeaders, updateLeonaBillingProfile } from '../lib/leona.js';

/**
 * Busca todos os billing_profiles Leona vinculados a um email,
 * incluindo contas inativas/vencidas (diferente do helper padrao,
 * que so retorna a conta ativa).
 *
 * Necessario aqui porque o retroativo precisa atualizar contas que
 * podem ja estar com a data antiga vencida.
 */
async function fetchAllLeonaProfilesByEmail(email, token) {
  if (!email || !token) return [];
  const headers = leonaHeaders(token);
  const url = `${LEONA_BASE}/accounts/billing_profile?email=${encodeURIComponent(email.trim().toLowerCase())}`;

  try {
    const r = await fetch(url, { headers });
    if (r.ok) {
      const profile = await r.json();
      return [profile];
    }
    if (r.status === 409) {
      const conflict = await r.json().catch(() => ({}));
      const ids = Array.isArray(conflict.account_ids) ? conflict.account_ids : [];
      if (ids.length === 0) return [];
      const profiles = await Promise.all(ids.map(async (id) => {
        try {
          const pr = await fetch(`${LEONA_BASE}/accounts/${id}/billing_profile`, { headers });
          if (pr.ok) return await pr.json();
        } catch (_) {}
        return null;
      }));
      return profiles.filter(Boolean);
    }
  } catch (_) {}
  return [];
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const adminSecret = process.env.ADMIN_BUMP_SECRET;
  const guruToken = process.env.GURU_TOKEN;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!adminSecret) {
    return res.status(500).json({ error: 'ADMIN_BUMP_SECRET não configurado' });
  }
  if (!guruToken || !leonaToken) {
    return res.status(500).json({ error: 'GURU_TOKEN ou LEONA_BILLING_TOKEN não configurado' });
  }

  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== adminSecret) {
    return res.status(401).json({ error: 'admin secret inválido' });
  }

  const dryRun = req.body?.dry_run !== false;
  const headers = guruHeaders(guruToken);

  const stats = {
    dry_run: dryRun,
    total_subs_scanned: 0,
    total_eligible: 0,
    total_updated: 0,
    skipped: {
      no_email: 0,
      no_leona_match: 0,
      no_guru_link: 0,
      no_guru_date: 0,
      already_bumped: 0,
      error: 0
    },
    actions: []
  };

  try {
    // 1. Pagina todas as subs ativas do produto Leona.
    const allSubs = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const url = `${GURU_BASE}/subscriptions?limit=${PAGE_SIZE}&offset=${offset}`;
      const r = await fetch(url, { headers });
      if (!r.ok) {
        return res.status(200).json({
          ...stats,
          error: `Guru retornou ${r.status} ao listar subscriptions (pagina ${page})`
        });
      }
      const body = await r.json();
      const data = Array.isArray(body.data) ? body.data : [];
      if (data.length === 0) break;

      const filtered = data.filter(s =>
        s.last_status === 'active' && s.product?.id === LEONA_GURU_PRODUCT_ID
      );
      allSubs.push(...filtered);

      stats.total_subs_scanned += data.length;

      if (data.length < PAGE_SIZE) break;
    }

    stats.total_eligible = allSubs.length;

    // Cache de contatos Guru pra evitar chamadas repetidas.
    const contactEmailCache = new Map();
    async function getContactEmail(s) {
      if (s.contact?.email) return s.contact.email;
      const contactId = s.contact?.id || s.contact_id;
      if (!contactId) return null;
      if (contactEmailCache.has(contactId)) return contactEmailCache.get(contactId);
      try {
        const r = await fetch(`${GURU_BASE}/contacts/${contactId}`, { headers });
        if (r.ok) {
          const body = await r.json();
          const email = body?.email || body?.data?.email || null;
          contactEmailCache.set(contactId, email);
          return email;
        }
      } catch (_) {}
      contactEmailCache.set(contactId, null);
      return null;
    }

    // 2. Para cada sub, processa.
    for (const s of allSubs) {
      const guruSubId = s.id;
      const guruSubCode = s.subscription_code;
      const email = await getContactEmail(s);
      const guruDateStr = s.cycle_end_date || s.next_cycle_at;

      const action = {
        guru_sub_id: guruSubId,
        guru_sub_code: guruSubCode,
        email: email || null,
        guru_date: guruDateStr || null,
        current_leona_due: null,
        new_leona_due: null,
        result: null
      };

      if (!email) {
        stats.skipped.no_email++;
        action.result = 'skipped: sub sem email no contato';
        stats.actions.push(action);
        continue;
      }

      if (!guruDateStr) {
        stats.skipped.no_guru_date++;
        action.result = 'skipped: sub sem cycle_end_date nem next_cycle_at';
        stats.actions.push(action);
        continue;
      }

      let leonaProfiles = [];
      try {
        leonaProfiles = await fetchAllLeonaProfilesByEmail(email, leonaToken);
      } catch (e) {
        stats.skipped.error++;
        action.result = `error: fetchAllLeonaProfilesByEmail: ${e.message}`;
        stats.actions.push(action);
        continue;
      }

      if (leonaProfiles.length === 0) {
        stats.skipped.no_leona_match++;
        action.result = 'skipped: nenhuma conta Leona pra esse email';
        stats.actions.push(action);
        continue;
      }

      const leonaProfile = leonaProfiles.find(p =>
        p.guru_account_id && (p.guru_account_id === guruSubId || p.guru_account_id === guruSubCode)
      );

      if (!leonaProfile) {
        stats.skipped.no_guru_link++;
        action.result = `skipped: nenhuma conta Leona vinculada a esta sub Guru (${leonaProfiles.length} contas encontradas pra ${email})`;
        action.leona_accounts_found = leonaProfiles.map(p => ({
          account_id: p.account_id,
          guru_account_id: p.guru_account_id || null,
          status: p.subscription_status || null
        }));
        stats.actions.push(action);
        continue;
      }

      const accountId = leonaProfile.account_id;
      action.account_id = accountId;
      action.leona_guru_account_id = leonaProfile.guru_account_id;

      // Calcula a data alvo na Leona = data Guru + 1 dia.
      const guruDate = new Date(guruDateStr + 'T00:00:00Z');
      const target = new Date(guruDate);
      target.setUTCDate(target.getUTCDate() + 1);
      const newDueDate = target.toISOString().split('T')[0];
      action.new_leona_due = newDueDate;

      const currentLeonaDate = leonaProfile.current_period_end || leonaProfile.due_date || null;
      action.current_leona_due = currentLeonaDate || null;

      // Idempotencia: se a Leona ja esta em data >= alvo, pula.
      if (currentLeonaDate) {
        const currentDateOnly = currentLeonaDate.split('T')[0];
        if (currentDateOnly >= newDueDate) {
          stats.skipped.already_bumped++;
          action.result = `skipped: Leona ja esta em ${currentDateOnly} (>= alvo ${newDueDate})`;
          stats.actions.push(action);
          continue;
        }
      }

      if (dryRun) {
        action.result = `would_update: ${currentLeonaDate || 'null'} -> ${newDueDate}`;
        stats.actions.push(action);
        continue;
      }

      // Executa o update.
      try {
        const updateRes = await updateLeonaBillingProfile(
          accountId,
          { due_date: newDueDate },
          leonaToken
        );
        if (updateRes.ok) {
          stats.total_updated++;
          action.result = `updated: ${currentLeonaDate || 'null'} -> ${newDueDate}`;
        } else {
          stats.skipped.error++;
          action.result = `error: Leona retornou ${updateRes.status}: ${updateRes.body?.error || updateRes.error || 'erro desconhecido'}`;
        }
      } catch (e) {
        stats.skipped.error++;
        action.result = `error: updateLeonaBillingProfile: ${e.message}`;
      }
      stats.actions.push(action);
    }

    return res.status(200).json(stats);
  } catch (error) {
    console.error('admin-bump-due-dates error:', error);
    return res.status(500).json({ error: error.message, partial_stats: stats });
  }
}
