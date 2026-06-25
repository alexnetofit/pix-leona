import { applyCors } from '../lib/auth.js';

const GURU_BASE = 'https://digitalmanager.guru/api/v2';
const GURU_HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'n8n'
});

const LEONA_PRODUCT_ID = 'a1869b83-b28d-4257-a986-1df94558a152';

// O produto Leona tem >50 ofertas. A API da Guru pagina e a ordem nao garante
// que planos como 8/9 conexoes venham nas primeiras 50, entao paginamos tudo.
async function fetchAllOffers(productId, headers) {
  const all = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const u = new URL(`${GURU_BASE}/products/${productId}/offers`);
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u, { headers });
    if (!res.ok) break;
    const body = await res.json();
    if (Array.isArray(body.data)) all.push(...body.data);
    cursor = body.next_cursor;
    if (!body.has_more_pages || !cursor) break;
  }
  return all;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const guruToken = process.env.GURU_TOKEN;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });

  const { email, account_id } = req.body || {};
  // account_id aceita int (legado) ou UUID. Tratamos como string opaca.
  const accountIdRaw = account_id != null ? String(account_id).trim() : '';
  const hasAccountId = accountIdRaw.length > 0;
  const isLegacyNumericId = hasAccountId && /^\d+$/.test(accountIdRaw);
  const queryEmail = email ? String(email).trim().toLowerCase() : '';

  if (!hasAccountId && !queryEmail) {
    return res.status(400).json({ error: 'Informe um e-mail ou account_id' });
  }

  // Anti-IDOR: ID numerico legado e enumeravel, entao exigimos email como
  // segunda chave (a Leona ainda envia ambos no botao). Quando o Leona
  // migrar pro UUID (inadivinhavel por design), essa exigencia some
  // automaticamente — UUID passa direto sem precisar de email.
  if (isLegacyNumericId && !queryEmail) {
    console.warn(`[idor:legacy_no_email] guru-search account_id=${accountIdRaw}`);
    return res.status(403).json({
      error: 'forbidden',
      code: 'EMAIL_ID_MISMATCH',
      message: 'os dados do link nao correspondem'
    });
  }

  const headers = GURU_HEADERS(guruToken);
  const leonaAuthHeaders = { 'Authorization': `Bearer ${leonaToken}`, 'Accept': 'application/json' };

  try {
    // Se veio account_id, busca a conta Leona DIRETO pelo ID.
    //
    // Mitigacao anti-IDOR (enquanto o Leona ainda envia account_id sequencial
    // junto com o email): quando a query traz email + account_id, exigimos
    // que o email da query bata com o email do dono da conta retornada
    // pela Leona. Caso nao bata (ou a conta nao exista), retornamos 403
    // com codigo unificado 'EMAIL_ID_MISMATCH' — sem distinguir entre
    // mismatch e id-inexistente, pra impedir enumeracao binaria de IDs
    // validos por usuarios autenticados que so conhecem o proprio email.
    //
    // Quando o Leona migrar pro UUID (e parar de mandar email na URL),
    // queryEmail vai ser vazio e essa validacao nao se aplica — o lookup
    // segue direto pelo UUID.
    let leonaPriority = null;
    let lookupEmail = queryEmail || null;

    if (hasAccountId && leonaToken) {
      try {
        const r = await fetch(
          `https://apiaws.leonasolutions.io/api/v1/integration/accounts/${encodeURIComponent(accountIdRaw)}/billing_profile`,
          { headers: leonaAuthHeaders }
        );
        if (r.ok) {
          const profile = await r.json();
          const profileEmail = profile?.user?.email
            ? String(profile.user.email).trim().toLowerCase()
            : null;

          if (queryEmail && profileEmail && queryEmail !== profileEmail) {
            console.warn(`[idor:mismatch] guru-search account_id=${accountIdRaw} queryEmail=${queryEmail} profileEmail=${profileEmail}`);
            return res.status(403).json({
              error: 'forbidden',
              code: 'EMAIL_ID_MISMATCH',
              message: 'os dados do link nao correspondem'
            });
          }

          leonaPriority = { found: true, billing_profile: profile, billing_profiles: [profile], error: null };
          if (profileEmail) lookupEmail = profileEmail;
        } else if (r.status === 404) {
          // Mesmo codigo do mismatch quando a query trouxe email — evita que
          // o atacante distinga "id existe mas e de outro" de "id inexistente".
          if (queryEmail) {
            console.warn(`[idor:notfound] guru-search account_id=${accountIdRaw} queryEmail=${queryEmail}`);
            return res.status(403).json({
              error: 'forbidden',
              code: 'EMAIL_ID_MISMATCH',
              message: 'os dados do link nao correspondem'
            });
          }
          leonaPriority = { found: false, billing_profile: null, billing_profiles: [], error: `account_id ${accountIdRaw} nao encontrada` };
        } else {
          leonaPriority = { found: false, billing_profile: null, billing_profiles: [], error: `Leona retornou ${r.status} para account_id ${accountIdRaw}` };
        }
      } catch (e) {
        leonaPriority = { found: false, billing_profile: null, billing_profiles: [], error: e.message };
      }
    }

    if (!lookupEmail) {
      return res.status(400).json({
        error: hasAccountId
          ? `nao foi possivel determinar o email do dono da conta ${accountIdRaw}`
          : 'Informe um e-mail'
      });
    }

    const emailClean = lookupEmail;

    const [contactRes, rawOffers, leonaRes] = await Promise.all([
      fetch(`${GURU_BASE}/contacts?email=${encodeURIComponent(emailClean)}&limit=20`, { headers }),
      fetchAllOffers(LEONA_PRODUCT_ID, headers),
      // Se ja achamos a conta via account_id, nao precisa buscar de novo.
      leonaPriority
        ? Promise.resolve(null)
        : (leonaToken
            ? fetch(`https://apiaws.leonasolutions.io/api/v1/integration/accounts/billing_profile?email=${encodeURIComponent(emailClean)}`, {
                headers: leonaAuthHeaders
              }).catch(e => ({ ok: false, _error: e.message }))
            : Promise.resolve(null))
    ]);

    const contactData = contactRes.ok ? await contactRes.json() : { data: [] };
    const contacts = Array.isArray(contactData.data) ? contactData.data : [];
    // A Guru pode ter contatos duplicados com o mesmo e-mail (ex.: sub criada
    // via fluxo replace cai num contato novo). Varremos TODOS pra nao perder a
    // assinatura ativa que ficou pendurada em outro contato.
    const matchedContacts = contacts.filter(c => c.email?.toLowerCase() === emailClean);
    const contact = matchedContacts[0] || null;

    const offers = (Array.isArray(rawOffers) ? rawOffers : [])
      .filter(o => o.is_active)
      .map(o => ({
        id: o.id,
        name: o.name,
        value: o.value,
        currency: o.currency || 'BRL',
        checkout_url: o.checkout_url,
        payment_types: o.payment_types || [],
        plan: o.plan || null
      }))
      .sort((a, b) => a.value - b.value);

    let leona = { found: false, billing_profile: null, billing_profiles: null, error: null };
    if (leonaPriority) {
      // Conta achada direto pelo account_id na URL — usa essa.
      leona = leonaPriority;
    } else if (leonaRes === null) {
      leona.error = 'LEONA_BILLING_TOKEN não configurado';
    } else if (leonaRes._error) {
      leona.error = leonaRes._error;
    } else if (leonaRes.ok) {
      const leonaBody = await leonaRes.json();
      leona = { found: true, billing_profile: leonaBody, billing_profiles: [leonaBody], error: null };
    } else if (leonaRes.status === 409) {
      const conflict = await leonaRes.json().catch(() => ({}));
      const ids = conflict.account_ids || [];
      if (ids.length > 0) {
        const profiles = await Promise.all(ids.map(async (accId) => {
          try {
            const r = await fetch(
              `https://apiaws.leonasolutions.io/api/v1/integration/accounts/${accId}/billing_profile`,
              { headers: { 'Authorization': `Bearer ${leonaToken}`, 'Accept': 'application/json' } }
            );
            if (r.ok) return await r.json();
          } catch (_) {}
          return null;
        }));
        const valid = profiles.filter(Boolean);
        leona = { found: valid.length > 0, billing_profile: valid[0] || null, billing_profiles: valid, error: null };
      } else {
        leona.error = 'Múltiplas contas encontradas mas sem IDs retornados';
      }
    } else {
      leona = { found: false, billing_profile: null, billing_profiles: null, error: null };
    }

    let guru = { found: false, contact: null, subscriptions: [], invoices: [] };

    if (matchedContacts.length > 0) {
      guru.found = true;

      // Agrega subs Leona de TODOS os contatos com esse e-mail (dedupe por id).
      const subsById = new Map();
      for (const c of matchedContacts) {
        const subsRes = await fetch(
          `${GURU_BASE}/subscriptions?contact_id=${c.id}&limit=50`,
          { headers }
        );
        if (!subsRes.ok) continue;
        const subsData = await subsRes.json();
        const allSubs = Array.isArray(subsData.data) ? subsData.data : [];
        for (const s of allSubs) {
          if (s.product?.id === LEONA_PRODUCT_ID && !subsById.has(s.id)) {
            subsById.set(s.id, s);
          }
        }
      }
      const leonaSubs = Array.from(subsById.values());

      // Contato exibido: o dono da sub ativa (se houver), senao o primeiro.
      const activeOwnerId = leonaSubs.find(s => s.last_status === 'active')?.contact?.id;
      const displayContact = matchedContacts.find(c => c.id === activeOwnerId) || matchedContacts[0];
      guru.contact = {
        id: displayContact.id,
        name: displayContact.name,
        email: displayContact.email,
        doc: displayContact.doc,
        phone: displayContact.phone_number ? `+${displayContact.phone_local_code || '55'}${displayContact.phone_number}` : null
      };

      {
        const subDetails = await Promise.all(
          leonaSubs.map(async (s) => {
            let currentInvoice = null;
            if (s.last_status === 'active') {
              try {
                const detailRes = await fetch(`${GURU_BASE}/subscriptions/${s.id}`, { headers });
                if (detailRes.ok) {
                  const detail = await detailRes.json();
                  const ci = detail.current_invoice;
                  if (ci && ci.status !== 'paid') {
                    currentInvoice = {
                      id: ci.id,
                      status: ci.status,
                      type: ci.type,
                      value: ci.value,
                      charge_at: ci.charge_at || null,
                      period_start: ci.period_start || null,
                      period_end: ci.period_end || null,
                      payment_url: ci.payment_url || null
                    };
                  }
                }
              } catch (_) {}
            }
            return {
              id: s.id,
              subscription_code: s.subscription_code,
              product_name: s.product?.name || '',
              product_group: s.product?.group?.name || '',
              offer_id: s.offer?.id || s.product?.offer?.id || null,
              offer_name: s.offer?.name || s.product?.offer?.name || null,
              status: s.last_status,
              status_at: s.last_status_at,
              payment_method: s.payment_method,
              charged_times: s.charged_times,
              cycle_start: s.cycle_start_date,
              cycle_end: s.cycle_end_date,
              next_cycle: s.next_cycle_at,
              started_at: s.started_at,
              cancelled_at: s.cancelled_at,
              trial_start: s.trial_started_at,
              trial_end: s.trial_finished_at,
              charged_every_days: s.charged_every_days,
              current_invoice: currentInvoice
            };
          })
        );

        guru.subscriptions = subDetails;

        if (guru.subscriptions.length > 0) {
          const leonaSubIds = new Set(leonaSubs.map(s => s.id));
          const invoiceMap = new Map();
          for (const c of matchedContacts) {
            const txRes = await fetch(
              `${GURU_BASE}/transactions?contact_id=${c.id}&limit=100`,
              { headers }
            );
            if (!txRes.ok) continue;
            const txData = await txRes.json();
            const allTx = Array.isArray(txData.data) ? txData.data : [];
            const leonaTx = allTx.filter(t =>
              (t.product?.internal_id === LEONA_PRODUCT_ID ||
              leonaSubIds.has(t.subscription?.internal_id)) &&
              t.invoice
            );
            for (const t of leonaTx) {
              const key = t.invoice.id;
              if (!invoiceMap.has(key)) {
                invoiceMap.set(key, {
                  id: t.invoice.id,
                  status: t.invoice.status,
                  value: t.invoice.value,
                  cycle: t.invoice.cycle,
                  charge_at: t.invoice.charge_at,
                  period_start: t.invoice.period_start,
                  period_end: t.invoice.period_end,
                  offer_name: t.product?.offer?.name || '',
                  product_name: t.product?.name || '',
                  payment_method: t.payment?.method || null,
                  payment_url: t.invoice?.payment_url || t.payment?.url || null,
                  subscription_id: t.subscription?.internal_id || null
                });
              }
            }
          }
          guru.invoices = Array.from(invoiceMap.values());
        }
      }
    }

    return res.status(200).json({ guru, leona, offers });

  } catch (error) {
    console.error('guru-search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
