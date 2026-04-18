const LEONA_PRODUCT_ID = 'a1869b83-b28d-4257-a986-1df94558a152';
const LEONA_BASE = 'https://apiaws.leonasolutions.io/api/v1/integration';

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

    if (payload.status !== 'approved') {
      return res.status(200).json({ received: true, ignored: true, reason: `status: ${payload.status}` });
    }

    const productId = payload.product?.internal_id;
    if (productId !== LEONA_PRODUCT_ID) {
      return res.status(200).json({ received: true, ignored: true, reason: 'produto diferente do Leona Flow' });
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

    const profiles = await fetchLeonaProfiles(email, leonaHeaders);

    if (profiles.length === 0) {
      console.error('webhook-guru: nenhuma conta Leona encontrada para:', email);
      return res.status(200).json({
        received: true,
        processed: false,
        error: `nenhuma conta Leona encontrada para ${email}`
      });
    }

    let match = profiles.find(p =>
      p.guru_account_id &&
      (p.guru_account_id === guruSubId || p.guru_account_id === guruSubCode)
    );

    let firstLink = false;

    if (!match) {
      const unlinked = profiles.filter(p => !p.guru_account_id);

      if (unlinked.length === 1) {
        match = unlinked[0];
        firstLink = true;
        console.log(`webhook-guru: conta ${match.account_id} sem guru_account_id, vinculando à subscription ${guruSubId}`);
      } else if (unlinked.length > 1) {
        const activeUnlinked = unlinked.filter(p =>
          p.subscription_status === 'active' && p.current_period_end && new Date(p.current_period_end) > new Date()
        );
        if (activeUnlinked.length === 1) {
          match = activeUnlinked[0];
          firstLink = true;
          console.log(`webhook-guru: múltiplas contas sem vínculo, mas apenas conta ${match.account_id} está ativa, vinculando à subscription ${guruSubId}`);
        } else {
          console.log(`webhook-guru: ${activeUnlinked.length} contas ativas sem vínculo, não é possível determinar qual atualizar. Contas: ${profiles.map(p => `${p.account_id}(guru=${p.guru_account_id}, status=${p.subscription_status})`).join(', ')}`);
          return res.status(200).json({
            received: true,
            processed: false,
            error: `múltiplas contas sem vínculo (${unlinked.length}), ${activeUnlinked.length} ativas — não é possível determinar qual atualizar`,
            accounts_found: profiles.map(p => ({ account_id: p.account_id, guru_account_id: p.guru_account_id, status: p.subscription_status }))
          });
        }
      } else {
        console.log(`webhook-guru: nenhuma conta Leona com guru_account_id correspondente à subscription ${guruSubId}. Contas encontradas: ${profiles.map(p => `${p.account_id}(guru=${p.guru_account_id})`).join(', ')}`);
        return res.status(200).json({
          received: true,
          processed: false,
          error: `nenhuma conta Leona vinculada à subscription ${guruSubId}`,
          accounts_found: profiles.map(p => ({ account_id: p.account_id, guru_account_id: p.guru_account_id }))
        });
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

    if (!isUpgradeOrDowngrade) {
      const calculatedDueDate = calculateDueDate(payload);
      if (calculatedDueDate) {
        updateData.due_date = calculatedDueDate;
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

      return res.status(200).json({
        received: true,
        processed: true,
        account_id: accountId,
        instances,
        is_upgrade_downgrade: isUpgradeOrDowngrade,
        due_date: updateData.due_date || null
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

function calculateDueDate(payload) {
  const chargeAt = payload.invoice?.charge_at;
  const chargedEveryDays = payload.subscription?.charged_every_days;

  if (chargeAt && chargedEveryDays) {
    const date = new Date(chargeAt + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + chargedEveryDays);
    return date.toISOString().split('T')[0];
  }

  const periodEnd = payload.invoice?.period_end;
  if (periodEnd) return periodEnd;

  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().split('T')[0];
}
