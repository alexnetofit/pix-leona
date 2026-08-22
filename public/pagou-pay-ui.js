(function (global) {
  function money(n) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
  }

  function payLabel(method, kind, region, amount) {
    if (region === 'international') return 'Pagar com cartão';
    if (kind === 'one_shot') {
      const n = Number(amount);
      return Number.isFinite(n) && n > 0 ? `Pagar ${money(n)}` : 'Pagar agora';
    }
    return 'Assinar agora';
  }

  let _payConfig = null;
  function loadPayConfig() {
    if (_payConfig) return _payConfig;
    _payConfig = fetch('/api/pagou-config').then((r) => r.json()).catch(() => ({}));
    return _payConfig;
  }

  function el(id, name) {
    return document.getElementById(`${name}-${id}`);
  }

  function formHtml(id, opts = {}) {
    const email = opts.email || '';
    const kind = opts.kind === 'one_shot' ? 'one_shot' : 'subscription';
    const hint = kind === 'one_shot'
      ? 'Você paga só o proporcional. Ao pagar, o plano é atualizado.'
      : 'Você será redirecionado ao checkout. A cobrança se repete todo mês.';
    return `
      <div id="payForm-${id}">
        <div class="group" style="margin-top:16px;">
          <div class="field">
            <label>E-mail</label>
            <input id="email-${id}" type="email" autocomplete="email" readonly value="${String(email).replace(/"/g, '&quot;')}">
          </div>
          <div class="field" id="nameField-${id}" style="display:none;">
            <label>Nome</label>
            <input id="name-${id}" type="text" autocomplete="name" placeholder="Como no cartão">
          </div>
          <div class="field">
            <label>País</label>
            <div class="seg" style="margin:8px 0 0;">
              <button type="button" id="tabBr-${id}" class="active">Brasil</button>
              <button type="button" id="tabIntl-${id}">Exterior</button>
            </div>
          </div>
        </div>
        <button class="pay" id="payBtn-${id}" type="button">Assinar agora</button>
        <div class="err" id="err-${id}"></div>
        <p class="hint" id="payHint-${id}">${hint}</p>
      </div>
    `;
  }

  function attach(id, ctx) {
    const state = {
      method: 'pix',
      region: 'br',
      paddleReady: false
    };

    function checkout() {
      return ctx.getCheckout();
    }

    function kind() {
      return checkout().kind === 'one_shot' ? 'one_shot' : 'subscription';
    }

    function showErr(msg) {
      const node = el(id, 'err');
      if (!node) return;
      node.textContent = msg || '';
      node.style.display = msg ? 'block' : 'none';
    }

    function applyRegion(region) {
      state.region = region === 'international' ? 'international' : 'br';
      const intl = state.region === 'international';
      el(id, 'tabBr')?.classList.toggle('active', !intl);
      el(id, 'tabIntl')?.classList.toggle('active', intl);
      const nameField = document.getElementById(`nameField-${id}`);
      if (nameField) nameField.style.display = intl ? '' : 'none';
      const hint = el(id, 'payHint');
      if (hint) {
        if (intl) {
          hint.textContent = state.paddleReady
            ? 'Pagamento internacional pela Paddle. Sem CPF. Cartão na sua moeda.'
            : 'Pagamento internacional temporariamente indisponível. Fale com o suporte.';
        } else {
          hint.textContent = kind() === 'one_shot'
            ? 'Você paga só o proporcional. Ao pagar, o plano é atualizado.'
            : 'Você será redirecionado ao checkout da Guru. A cobrança se repete todo mês.';
        }
      }
      const btn = el(id, 'payBtn');
      if (btn) {
        btn.dataset.region = state.region;
        btn.disabled = intl && !state.paddleReady;
        if (!btn.disabled || intl) btn.textContent = payLabel(state.method, kind(), state.region, checkout().amount);
      }
    }

    async function openPagouOneShot(c) {
      if (!(Number(c.amount) > 0)) {
        throw new Error('Valor do ajuste ausente. Recalcule o upgrade.');
      }
      const r = await fetch('/api/pagou-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: c.accountId,
          email: c.email,
          qty: c.qty,
          amount: c.amount,
          offer_name: c.offer,
          kind: 'one_shot',
          hosted: true
        })
      });
      const data = await r.json();
      if (!r.ok || !data.url) {
        throw new Error(data.error || 'Não foi possível gerar o pagamento do ajuste');
      }
      location.href = data.url;
    }

    async function openGuruCheckout(c) {
      const r = await fetch('/api/guru-replace-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: c.accountId,
          email: c.email,
          qty: c.qty
        })
      });
      const data = await r.json();
      if (!r.ok || !data.checkout_url) {
        throw new Error(data.error || 'Não foi possível gerar o checkout da Guru');
      }
      location.href = data.checkout_url;
    }

    async function openPaddleCheckout(c) {
      if (!state.paddleReady) throw new Error('Pagamento internacional indisponível. Fale com o suporte.');
      const r = await fetch('/api/paddle-international-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: c.accountId,
          email: c.email,
          qty: c.qty,
          name: (el(id, 'name')?.value || '').trim()
        })
      });
      const data = await r.json();
      if (!r.ok || !data.checkout_url) {
        throw new Error(data.error || 'Falha ao abrir o checkout internacional');
      }
      location.href = data.checkout_url;
    }

    async function submitPay() {
      const btn = el(id, 'payBtn');
      const c = checkout();
      showErr('');
      if (!c.accountId || !c.email) {
        showErr('Abra esta página pelo painel da Leona.');
        return;
      }
      if (!c.qty) {
        showErr('Escolha um plano disponível.');
        return;
      }
      if (typeof ctx.onSubmit === 'function') ctx.onSubmit({ ...c, region: state.region });
      btn.disabled = true;
      btn.textContent = 'Processando...';
      try {
        if (state.region === 'international') await openPaddleCheckout(c);
        else if (kind() === 'one_shot' && c.prorata) await openPagouOneShot(c);
        else await openGuruCheckout(c);
      } catch (err) {
        showErr(err.message);
        btn.disabled = false;
        btn.textContent = payLabel(state.method, kind(), state.region, c.amount);
      }
    }

    el(id, 'tabBr')?.addEventListener('click', () => applyRegion('br'));
    el(id, 'tabIntl')?.addEventListener('click', () => applyRegion('international'));
    el(id, 'payBtn')?.addEventListener('click', () => submitPay());

    const emailInput = el(id, 'email');
    if (emailInput && checkout().email) emailInput.value = checkout().email;
    const hint = el(id, 'payHint');
    if (hint) {
      hint.textContent = kind() === 'one_shot'
        ? 'Você paga só o proporcional. Ao pagar, o plano é atualizado.'
        : 'Você será redirecionado ao checkout da Guru. A cobrança se repete todo mês.';
    }
    const btn = el(id, 'payBtn');
    if (btn) btn.textContent = payLabel(state.method, kind(), state.region, checkout().amount);

    loadPayConfig().then((cfg) => {
      state.paddleReady = !!cfg.paddle_ready;
      applyRegion(cfg.suggest_international ? 'international' : 'br');
    });
  }

  global.PagouPay = { money, formHtml, attach, payLabel };
})(window);
