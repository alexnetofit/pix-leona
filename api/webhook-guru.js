import { updateGuruContact } from '../lib/guru.js';

const LEONA_PRODUCT_ID = 'a1869b83-b28d-4257-a986-1df94558a152';
const LEONA_BASE = 'https://apiaws.leonasolutions.io/api/v1/integration';
const GURU_BASE = 'https://digitalmanager.guru/api/v2';
const STRIPE_UPGRADE_COUPON_PREFIX = 'up-leona-';

/**
 * Procura o `src` do tracking no payload da Guru.
 *
 * O `src` e enviado como query param do checkout (?src=<account_id>) e
 * a Guru o repassa no webhook em algum desses lugares (depende do tipo
 * de transacao). Pegamos a primeira ocorrencia nao-vazia.
 *
 * Convencao do projeto: usar `src` para carregar o `account_id` Leona,
 * permitindo que o webhook saiba qual conta atualizar mesmo quando o
 * cliente compra com email diferente do cadastrado.
 */
function extractSrc(payload) {
  const candidates = [
    payload?.src,
    payload?.subscription?.src,
    payload?.transaction?.src,
    payload?.tracking?.src,
    payload?.tracking?.source,
    payload?.transaction?.tracking?.source,
    payload?.transaction?.tracking?.src,
    payload?.metadata?.src,
    payload?.checkout?.src,
    // A Guru hoje (2026) entrega o tracking do checkout dentro de
    // `payload.source` como objeto: { source, utm_source, utm_campaign, ... }.
    // O `source.source` carrega o valor da query ?src=<account_id>.
    payload?.source?.source,
    payload?.source?.src,
    payload?.source?.utm_source,
    payload?.contact?.tracking?.source,
    payload?.contact?.tracking_source
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const guruApiKey = process.env.GURU_API_KEY;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!leonaToken) {
    console.error('webhook-guru: LEONA_BILLING_TOKEN não configurado');
    return res.status(500).json({ error: 'Configuração incompleta' });
  }

  try {
    const payload = req.body;
    console.log('webhook-guru recebido:', JSON.stringify(payload));

    if (guruApiKey && payload.api_token !== guruApiKey) {
      console.error('webhook-guru: api_token inválido');
      return res.status(401).json({ error: 'Token inválido' });
    }

    if (payload.webhook_type !== 'transaction') {
      return res.status(200).json({ received: true, ignored: true, reason: `webhook_type: ${payload.webhook_type}` });
    }

    const productId = payload.product?.internal_id;
    if (productId !== LEONA_PRODUCT_ID) {
      return res.status(200).json({ received: true, ignored: true, reason: 'produto diferente do Leona Flow' });
    }

    if (payload.status === 'refunded' || payload.status === 'chargedback') {
      return await handleRefundOrChargeback(payload, leonaToken, res);
    }

    if (payload.status !== 'approved') {
      return res.status(200).json({ received: true, ignored: true, reason: `status: ${payload.status}` });
    }

    if (!payload.subscription || !payload.subscription.internal_id) {
      return res.status(200).json({ received: true, ignored: true, reason: 'assinatura não criada (subscription vazio)' });
    }

    const email = payload.contact?.email;
    if (!email) {
      console.error('webhook-guru: email do contato não encontrado');
      return res.status(200).json({ received: true, error: 'email não encontrado' });
    }

    const planName = payload.product?.offer?.name
      || payload.items?.[0]?.offer?.name
      || payload.subscription?.name
      || payload.product?.name
      || '';
    const instances = extractInstances(planName);

    if (instances === null) {
      console.error(`webhook-guru: instâncias não identificadas no plano: "${planName}"`);
      return res.status(200).json({ received: true, error: `instâncias não identificadas no plano: ${planName}` });
    }

    const invoiceType = payload.invoice?.type;
    const isUpgradeOrDowngrade = invoiceType === 'upgrade' || invoiceType === 'downgrade';

    const guruSubId = payload.subscription.internal_id;
    const guruSubCode = payload.subscription.subscription_code || null;

    console.log(`webhook-guru: email=${email}, plano="${planName}", instances=${instances}, invoice.type=${invoiceType}, upgrade/downgrade=${isUpgradeOrDowngrade}, sub=${guruSubId}`);

    const leonaHeaders = {
      'Authorization': `Bearer ${leonaToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    // Priorizacao por src (account_id Leona vindo do checkout):
    // se o front mandou ?src=<account_id> no checkout, a Guru repassa esse
    // valor no webhook. Isso evita problemas quando o cliente compra com um
    // email diferente do cadastrado na Leona.
    const srcRaw = extractSrc(payload);
    const srcAccountId = srcRaw && /^\d+$/.test(srcRaw) ? Number(srcRaw) : null;

    let match = null;
    let firstLink = false;
    let profiles = [];

    if (srcAccountId) {
      console.log(`webhook-guru: src=${srcAccountId} detectado, buscando conta Leona direto pelo ID`);
      try {
        const r = await fetch(`${LEONA_BASE}/accounts/${srcAccountId}/billing_profile`, { headers: leonaHeaders });
        if (r.ok) {
          const profile = await r.json();
          match = profile;
          profiles = [profile];
          firstLink = !profile.guru_account_id || (profile.guru_account_id !== guruSubId && profile.guru_account_id !== guruSubCode);
          console.log(`webhook-guru: conta ${srcAccountId} encontrada via src${firstLink ? ' (precisa vincular guru_account_id)' : ''}`);
        } else {
          console.log(`webhook-guru: conta ${srcAccountId} (src) nao encontrada na Leona (status ${r.status}), caindo no fluxo de email`);
        }
      } catch (e) {
        console.error(`webhook-guru: erro buscando conta ${srcAccountId} via src:`, e.message);
      }
    }

    // Fallback: se nao achou via src, faz lookup tradicional por email.
    if (!match) {
      profiles = await fetchLeonaProfiles(email, leonaHeaders);

      if (profiles.length === 0) {
        console.error('webhook-guru: nenhuma conta Leona encontrada para:', email);
        return res.status(200).json({
          received: true,
          processed: false,
          error: `nenhuma conta Leona encontrada para ${email}`
        });
      }

      match = profiles.find(p =>
        p.guru_account_id &&
        (p.guru_account_id === guruSubId || p.guru_account_id === guruSubCode)
      );
    }

    if (!match) {
      const unlinked = profiles.filter(p => !p.guru_account_id);

      if (unlinked.length === 1) {
        match = unlinked[0];
        firstLink = true;
        console.log(`webhook-guru: conta ${match.account_id} sem guru_account_id, vinculando à subscription ${guruSubId}`);
      } else if (unlinked.length > 1) {
        // Prioridade pra desempatar quando ha varias contas no mesmo email
        // sem vinculo Guru (cenario classico: cliente criou 2 contas e voltou
        // pagar pelo link puro da Guru, sem o src do checkout):
        //   1. exatamente 1 com subscription_status='active' e periodo futuro
        //   2. exatamente 1 com subscription_status='past_due'
        //      (e claro: cliente que estava pagando e atrasou, agora reativando)
        //   3. desempate por current_period_end mais recente entre as
        //      candidatas "vivas" (active ou past_due)
        // Se nada disso bater, aborta com erro detalhado pra acao manual.
        const now = new Date();
        const isActive = (p) => p.subscription_status === 'active' && p.current_period_end && new Date(p.current_period_end) > now;
        const isPastDue = (p) => p.subscription_status === 'past_due';

        const activeUnlinked = unlinked.filter(isActive);
        const pastDueUnlinked = unlinked.filter(isPastDue);

        if (activeUnlinked.length === 1) {
          match = activeUnlinked[0];
          firstLink = true;
          console.log(`webhook-guru: múltiplas contas sem vínculo, mas apenas conta ${match.account_id} está ativa, vinculando à subscription ${guruSubId}`);
        } else if (activeUnlinked.length === 0 && pastDueUnlinked.length === 1) {
          match = pastDueUnlinked[0];
          firstLink = true;
          console.log(`webhook-guru: múltiplas contas sem vínculo, nenhuma ativa, mas conta ${match.account_id} está past_due (cliente reativando), vinculando à subscription ${guruSubId}`);
        } else {
          const liveCandidates = [...activeUnlinked, ...pastDueUnlinked]
            .filter(p => p.current_period_end)
            .sort((a, b) => new Date(b.current_period_end) - new Date(a.current_period_end));

          if (liveCandidates.length > 0) {
            match = liveCandidates[0];
            firstLink = true;
            console.log(`webhook-guru: múltiplas contas vivas sem vínculo (active=${activeUnlinked.length}, past_due=${pastDueUnlinked.length}), desempatando pela conta ${match.account_id} com current_period_end mais recente (${match.current_period_end})`);
          } else {
            console.log(`webhook-guru: ${activeUnlinked.length} contas ativas e ${pastDueUnlinked.length} past_due sem vínculo, sem candidata viva — não é possível determinar qual atualizar. Contas: ${profiles.map(p => `${p.account_id}(guru=${p.guru_account_id}, status=${p.subscription_status})`).join(', ')}`);
            return res.status(200).json({
              received: true,
              processed: false,
              error: `múltiplas contas sem vínculo (${unlinked.length}), ${activeUnlinked.length} ativas / ${pastDueUnlinked.length} past_due — não é possível determinar qual atualizar`,
              accounts_found: profiles.map(p => ({ account_id: p.account_id, guru_account_id: p.guru_account_id, status: p.subscription_status, current_period_end: p.current_period_end }))
            });
          }
        }
      } else {
        const linked = profiles.filter(p => p.guru_account_id);

        if (linked.length === 1) {
          const candidate = linked[0];
          const currentQty = Number(candidate.starter_instances) || 0;
          const newQty = Number(instances) || 0;

          if (newQty >= currentQty) {
            match = candidate;
            firstLink = true;
            console.log(`webhook-guru: sub ${guruSubId} não bate com nenhuma conta. Única candidata=${candidate.account_id} (guru antigo=${candidate.guru_account_id}, qty atual=${currentQty}, nova=${newQty}). Re-vinculando (qty cresceu/manteve).`);
          } else {
            console.log(`webhook-guru: sub ${guruSubId} não bate. Única candidata=${candidate.account_id} teria reduzido qty ${currentQty}→${newQty}. NÃO re-vinculando para evitar perder conexões. Ação manual necessária.`);
            return res.status(200).json({
              received: true,
              processed: false,
              error: `re-vínculo abortado: nova qty (${newQty}) é menor que atual (${currentQty}) na conta ${candidate.account_id}. Verifique se o cliente realmente quis reduzir antes de vincular manualmente.`,
              candidate_account: { account_id: candidate.account_id, guru_account_id: candidate.guru_account_id, current_qty: currentQty, new_qty: newQty }
            });
          }
        } else {
          console.log(`webhook-guru: nenhuma conta Leona com guru_account_id correspondente à subscription ${guruSubId}. Contas encontradas: ${profiles.map(p => `${p.account_id}(guru=${p.guru_account_id})`).join(', ')}`);
          return res.status(200).json({
            received: true,
            processed: false,
            error: linked.length === 0
              ? `nenhuma conta Leona vinculada à subscription ${guruSubId}`
              : `múltiplas contas Leona já vinculadas (${linked.length}) — não é possível determinar qual re-vincular`,
            accounts_found: profiles.map(p => ({ account_id: p.account_id, guru_account_id: p.guru_account_id, starter_instances: p.starter_instances }))
          });
        }
      }
    }

    const accountId = match.account_id;

    const updateData = {
      starter_instances: instances,
      status: 'active'
    };

    if (firstLink) {
      updateData.guru_account_id = guruSubId;
    }

    const couponRaw = payload.payment?.coupon;
    const couponCode = (typeof couponRaw === 'string' ? couponRaw : couponRaw?.coupon_code) || '';
    const isStripeUpgrade = couponCode.toLowerCase().startsWith(STRIPE_UPGRADE_COUPON_PREFIX);
    const existingPeriodEnd = match.current_period_end;
    const preserveStripeCycle = isStripeUpgrade
      && existingPeriodEnd
      && new Date(existingPeriodEnd) > new Date();

    if (!isUpgradeOrDowngrade) {
      if (preserveStripeCycle) {
        console.log(`webhook-guru: cupom ${couponCode} (upgrade vindo do Stripe), preservando current_period_end Leona ${existingPeriodEnd} e ajustando ciclo na Guru`);
      } else {
        const calculatedDueDate = calculateDueDate(payload);
        if (calculatedDueDate) {
          updateData.due_date = calculatedDueDate;
        }
      }
    }

    console.log(`webhook-guru: atualizando conta ${accountId}:`, JSON.stringify(updateData));

    const leonaPostRes = await fetch(
      `${LEONA_BASE}/accounts/${accountId}/billing_profile`,
      {
        method: 'POST',
        headers: leonaHeaders,
        body: JSON.stringify(updateData)
      }
    );

    const leonaResult = await leonaPostRes.json().catch(() => ({}));

    if (leonaPostRes.ok) {
      console.log(`webhook-guru: conta ${accountId} atualizada com sucesso`);

      if (preserveStripeCycle) {
        await syncGuruCycleDate(guruSubId, existingPeriodEnd, accountId, leonaHeaders);
      }

      // Sincronia de email Leona -> Guru: quando o cliente compra via /assinatura
      // com um src valido, podemos ter uma conta Leona com email diferente do
      // que foi usado na Guru. Nesse caso, atualizamos o contato Guru pra que
      // futuros pagamentos cheguem com o email correto.
      let emailSync = null;
      try {
        emailSync = await syncGuruContactEmail({
          payload,
          leonaProfile: match,
          guruWebhookEmail: email,
          accountId
        });
      } catch (e) {
        emailSync = { skipped: true, error: e.message };
        console.error(`webhook-guru: erro inesperado em syncGuruContactEmail:`, e.message);
      }

      return res.status(200).json({
        received: true,
        processed: true,
        email_sync: emailSync,
        account_id: accountId,
        instances,
        is_upgrade_downgrade: isUpgradeOrDowngrade,
        due_date: updateData.due_date || null,
        preserved_stripe_cycle: preserveStripeCycle ? existingPeriodEnd : null
      });
    }

    console.error(`webhook-guru: erro ao atualizar conta ${accountId}:`, JSON.stringify(leonaResult));
    return res.status(200).json({
      received: true,
      processed: false,
      account_id: accountId,
      error: leonaResult.error || 'Erro ao atualizar conta Leona'
    });
  } catch (error) {
    console.error('webhook-guru error:', error);
    return res.status(200).json({ received: true, error: error.message });
  }
}

async function handleRefundOrChargeback(payload, leonaToken, res) {
  const action = payload.status;
  const guruSubId = payload.subscription?.internal_id;
  const guruSubCode = payload.subscription?.subscription_code || null;
  const email = payload.contact?.email;

  if (!guruSubId || !email) {
    console.log(`webhook-guru ${action}: sub/email ausentes — ignorando`);
    return res.status(200).json({ received: true, ignored: true, reason: 'sub/email ausentes' });
  }

  const leonaHeaders = {
    'Authorization': `Bearer ${leonaToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  const profiles = await fetchLeonaProfiles(email, leonaHeaders);
  const match = profiles.find(p =>
    p.guru_account_id &&
    (p.guru_account_id === guruSubId || p.guru_account_id === guruSubCode)
  );

  if (!match) {
    console.log(`webhook-guru ${action}: nenhuma conta Leona vinculada à subscription ${guruSubId}`);
    return res.status(200).json({
      received: true,
      processed: false,
      reason: action,
      error: `nenhuma conta Leona vinculada à subscription ${guruSubId}`
    });
  }

  const eventTs = action === 'refunded'
    ? payload.dates?.refunded_at
    : payload.dates?.chargedback_at;
  const fallbackTs = payload.dates?.updated_at || Math.floor(Date.now() / 1000);
  const eventDate = new Date((eventTs || fallbackTs) * 1000);
  eventDate.setUTCDate(eventDate.getUTCDate() - 1);
  const dueDate = eventDate.toISOString().split('T')[0];

  const updateData = {
    due_date: dueDate,
    status: 'inactive'
  };

  console.log(`webhook-guru ${action}: atualizando conta ${match.account_id} due_date=${dueDate}, status=inactive`);

  const r = await fetch(`${LEONA_BASE}/accounts/${match.account_id}/billing_profile`, {
    method: 'POST',
    headers: leonaHeaders,
    body: JSON.stringify(updateData)
  });
  const body = await r.json().catch(() => ({}));

  if (r.ok) {
    return res.status(200).json({
      received: true,
      processed: true,
      action,
      account_id: match.account_id,
      due_date: dueDate,
      status: 'inactive'
    });
  }

  console.error(`webhook-guru ${action}: erro ao atualizar conta ${match.account_id}:`, JSON.stringify(body));
  return res.status(200).json({
    received: true,
    processed: false,
    action,
    account_id: match.account_id,
    error: body.error || 'Erro ao atualizar conta Leona'
  });
}

async function fetchLeonaProfiles(email, headers) {
  const res = await fetch(
    `${LEONA_BASE}/accounts/billing_profile?email=${encodeURIComponent(email.trim().toLowerCase())}`,
    { headers }
  );

  if (res.ok) {
    const profile = await res.json();
    return [profile];
  }

  if (res.status === 409) {
    const conflict = await res.json().catch(() => ({}));
    const ids = conflict.account_ids || [];
    if (ids.length === 0) return [];

    const results = await Promise.all(ids.map(async (accId) => {
      try {
        const r = await fetch(
          `${LEONA_BASE}/accounts/${accId}/billing_profile`,
          { headers }
        );
        if (r.ok) return await r.json();
      } catch (_) {}
      return null;
    }));

    return results.filter(Boolean);
  }

  return [];
}

function extractInstances(planName) {
  if (!planName) return null;
  const match = planName.match(/(\d+)\s*conex/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

async function syncGuruCycleDate(subscriptionId, leonaPeriodEnd, accountId, leonaHeaders) {
  const guruToken = process.env.GURU_TOKEN;
  if (!guruToken) {
    console.log('webhook-guru: GURU_TOKEN não configurado, não foi possível ajustar ciclo na Guru');
    return;
  }

  // Invariante Leona = Guru + 1 dia: ao empurrar a data Leona pra Guru,
  // subtraimos 1 dia para que a Guru fique com a data "real" do ciclo.
  // Na proxima renovacao, calculateDueDate adiciona +1 de novo, mantendo
  // a invariante.
  const leonaDateStr = leonaPeriodEnd.split('T')[0];
  const guruDate = new Date(leonaDateStr + 'T00:00:00Z');
  guruDate.setUTCDate(guruDate.getUTCDate() - 1);
  let cycleEndDate = guruDate.toISOString().split('T')[0];

  const minDate = new Date();
  minDate.setUTCDate(minDate.getUTCDate() + 6);
  const minDateStr = minDate.toISOString().split('T')[0];

  let adjustedLeona = false;
  if (cycleEndDate < minDateStr) {
    console.log(`webhook-guru: cycle_end_date ${cycleEndDate} < hoje+6 (${minDateStr}), ajustando para ${minDateStr}`);
    cycleEndDate = minDateStr;
    adjustedLeona = true;
  }

  console.log(`webhook-guru: ajustando ciclo da Guru sub=${subscriptionId} para ${cycleEndDate}`);

  try {
    const r = await fetch(`${GURU_BASE}/subscriptions/${subscriptionId}/cycle-end-date`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${guruToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'n8n'
      },
      body: JSON.stringify({ new_end_date: cycleEndDate })
    });

    const data = await r.json().catch(() => ({}));

    if (r.ok) {
      console.log(`webhook-guru: ciclo da Guru ajustado com sucesso para ${cycleEndDate}`);

      if (adjustedLeona) {
        // Invariante Leona = Guru + 1 dia: ao subir a data minima da Guru,
        // a Leona deve ficar 1 dia depois.
        const leonaAdjusted = new Date(cycleEndDate + 'T00:00:00Z');
        leonaAdjusted.setUTCDate(leonaAdjusted.getUTCDate() + 1);
        const leonaDueDate = leonaAdjusted.toISOString().split('T')[0];
        console.log(`webhook-guru: atualizando due_date no Leona para ${leonaDueDate} (Guru=${cycleEndDate}, ajustado por limite mínimo)`);
        await fetch(`${LEONA_BASE}/accounts/${accountId}/billing_profile`, {
          method: 'POST',
          headers: leonaHeaders,
          body: JSON.stringify({ due_date: leonaDueDate })
        }).catch(e => console.error('webhook-guru: erro ao ajustar due_date no Leona:', e.message));
      }
    } else {
      console.error(`webhook-guru: erro ao ajustar ciclo da Guru (${r.status}):`, JSON.stringify(data));
    }
  } catch (e) {
    console.error('webhook-guru: erro ao ajustar ciclo na Guru:', e.message);
  }
}

/**
 * Compara o email do contato Guru com o email do dono da conta Leona.
 * Se forem diferentes, atualiza o contato Guru pra que futuras compras
 * cheguem com o email correto (matching mais preciso).
 *
 * Em caso de erro de duplicidade de documento na Guru (outro contato ja
 * tem aquele doc), o helper updateGuruContact tenta variacoes do ultimo
 * digito automaticamente.
 *
 * Retorna um objeto descrevendo o resultado pra debug:
 *   - { skipped: true, reason }
 *   - { synced: true, from, to, attempts, final_doc }
 *   - { synced: false, error }
 */
async function syncGuruContactEmail({ payload, leonaProfile, guruWebhookEmail, accountId }) {
  const guruToken = process.env.GURU_TOKEN;
  if (!guruToken) {
    return { skipped: true, reason: 'GURU_TOKEN nao configurado' };
  }

  const leonaEmail = leonaProfile?.user?.email;
  if (!leonaEmail) {
    return { skipped: true, reason: 'conta Leona sem email no user' };
  }

  const leonaEmailNorm = String(leonaEmail).trim().toLowerCase();
  const guruEmailNorm = String(guruWebhookEmail || '').trim().toLowerCase();

  if (!guruEmailNorm) {
    return { skipped: true, reason: 'webhook sem email no contato Guru' };
  }

  if (leonaEmailNorm === guruEmailNorm) {
    return { skipped: true, reason: 'emails ja iguais' };
  }

  const contactId = payload?.contact?.internal_id || payload?.contact?.id;
  if (!contactId) {
    return { skipped: true, reason: 'webhook sem contact.internal_id' };
  }

  console.log(`webhook-guru: sincronizando email Guru contact=${contactId} de ${guruEmailNorm} -> ${leonaEmailNorm} (conta Leona ${accountId})`);

  const updatePayload = { email: leonaEmailNorm };
  // Inclui o doc atual na requisicao caso a Guru exija (e tambem porque o
  // helper precisa do doc pra fazer o retry de duplicidade).
  const currentDoc = payload?.contact?.doc;
  if (currentDoc) updatePayload.doc = String(currentDoc);

  const result = await updateGuruContact(contactId, updatePayload, guruToken);

  if (result.ok) {
    console.log(`webhook-guru: email Guru contact=${contactId} sincronizado em ${result.attempts} tentativa(s) (doc final=${result.final_doc})`);
    return {
      synced: true,
      contact_id: contactId,
      from: guruEmailNorm,
      to: leonaEmailNorm,
      attempts: result.attempts,
      final_doc: result.final_doc
    };
  }

  console.error(`webhook-guru: falha ao sincronizar email Guru contact=${contactId}: status=${result.status} body=${JSON.stringify(result.body || {}).slice(0, 200)}`);
  return {
    synced: false,
    contact_id: contactId,
    from: guruEmailNorm,
    to: leonaEmailNorm,
    attempts: result.attempts || 1,
    error: result.error || 'erro desconhecido'
  };
}

/**
 * Calcula o due_date que ira pra Leona com base no payload da Guru.
 *
 * Invariante: Leona = Guru + 1 dia.
 *
 * Motivo: a Guru so libera a fatura do proximo ciclo no dia x+1 as 10h,
 * mas a Leona marcaria como vencida em x+1 as 00h. O cliente entraria em
 * panico e nao conseguiria pagar (fatura ainda indisponivel na Guru).
 * Adicionando +1 dia, o cliente tem o dia x+1 inteiro pra pagar.
 *
 * O fluxo de refund/chargeback (handleRefundOrChargeback) NAO usa essa
 * funcao porque la a expiracao e proposital e imediata.
 */
function calculateDueDate(payload) {
  const chargeAt = payload.invoice?.charge_at;
  const chargedEveryDays = payload.subscription?.charged_every_days;

  if (chargeAt && chargedEveryDays) {
    const date = new Date(chargeAt + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + chargedEveryDays + 1);
    return date.toISOString().split('T')[0];
  }

  const periodEnd = payload.invoice?.period_end;
  if (periodEnd) {
    const d = new Date(periodEnd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 31);
  return d.toISOString().split('T')[0];
}
