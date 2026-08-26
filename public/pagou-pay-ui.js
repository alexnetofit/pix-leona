(function (global) {
  function money(n) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
  }

  function payLabel(method, kind, region, amount) {
    if (kind === 'one_shot') {
      const n = Number(amount);
      return Number.isFinite(n) && n > 0 ? `Pagar ${money(n)}` : 'Pagar agora';
    }
    return region === 'international' ? 'Assinar no exterior' : 'Assinar agora';
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
      ? 'PIX ou cartão à vista (1x). Ao pagar, o plano é atualizado.'
      : 'PIX ou cartão à vista. A cobrança se repete todo mês.';
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
      paddleReady: false,
      dlocalReady: false
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
      if (nameField) nameField.style.display = 'none';
      const hint = el(id, 'payHint');
      if (hint) {
        if (intl) {
          hint.textContent = kind() === 'one_shot'
            ? 'PIX ou cartão à vista (1x) na dLocal. O checkout pede o país e converte a moeda.'
            : 'PIX ou cartão à vista na dLocal. A cobrança se repete todo mês.';
        } else {
          hint.textContent = kind() === 'one_shot'
            ? 'PIX ou cartão à vista (1x). Ao pagar, o plano é atualizado.'
            : 'PIX ou cartão à vista. A cobrança se repete todo mês.';
        }
      }
      const btn = el(id, 'payBtn');
      if (btn) {
        btn.dataset.region = state.region;
        btn.disabled = !state.dlocalReady;
        btn.textContent = payLabel(state.method, kind(), state.region, checkout().amount);
      }
    }

    async function readJson(r) {
      const raw = await r.text();
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(
          r.status >= 500
            ? 'Servidor falhou ao gerar o checkout. Tente de novo.'
            : (raw.slice(0, 140) || 'Resposta inválida do servidor')
        );
      }
    }

    async function openDlocalCheckout(c) {
      const r = await fetch('/api/dlocal-go-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: c.accountId,
          email: c.email,
          qty: c.qty,
          kind: c.kind === 'one_shot' ? 'one_shot' : 'subscription',
          region: state.region,
          ...(Number(c.amount) > 0 ? { amount: c.amount } : {})
        })
      });
      const data = await readJson(r);
      if (!r.ok || !data.checkout_url) {
        throw new Error(data.error || 'Não foi possível gerar o checkout da dLocal');
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
        if (!state.dlocalReady) throw new Error('Pagamento dLocal indisponível. Tente de novo em instantes.');
        await openDlocalCheckout(c);
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
        ? 'PIX ou cartão à vista (1x). Ao pagar, o plano é atualizado.'
        : 'PIX ou cartão à vista. A cobrança se repete todo mês.';
    }
    const btn = el(id, 'payBtn');
    if (btn) btn.textContent = payLabel(state.method, kind(), state.region, checkout().amount);

    loadPayConfig().then((cfg) => {
      state.paddleReady = !!cfg.paddle_ready;
      state.dlocalReady = !!cfg.dlocal_ready;
      applyRegion(cfg.suggest_international ? 'international' : 'br');
    });
  }

  global.PagouPay = { money, formHtml, attach, payLabel };
})(window);
