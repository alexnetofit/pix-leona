(function (global) {
  function money(n) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
  }

  function payLabel(method, kind, region, amount) {
    const n = Number(amount);
    const priced = Number.isFinite(n) && n > 0 ? money(n) : '';
    if (region === 'international') {
      return kind === 'one_shot' && priced ? `Pagar ${priced}` : 'Assinar no exterior';
    }
    if (method === 'pix') {
      if (kind === 'one_shot' && priced) return `Pagar ${priced} no PIX`;
      return priced ? `Pagar ${priced} no PIX` : 'Pagar no PIX';
    }
    if (method === 'card') {
      if (kind === 'one_shot' && priced) return `Pagar ${priced} no cartão`;
      return priced ? `Pagar ${priced} no cartão` : 'Pagar no cartão';
    }
    if (kind === 'one_shot') {
      return priced ? `Pagar ${priced}` : 'Pagar agora';
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
    const name = String(opts.name || '').replace(/"/g, '&quot;');
    const kind = opts.kind === 'one_shot' ? 'one_shot' : 'subscription';
    const hint = kind === 'one_shot'
      ? 'PIX à vista (1x). Ao pagar, o plano é atualizado.'
      : 'PIX à vista. A liberação vale o mês; no cartão a cobrança se repete.';
    return `
      <div id="payForm-${id}">
        <div class="group" style="margin-top:16px;">
          <div class="field">
            <label>E-mail</label>
            <input id="email-${id}" type="email" autocomplete="email" readonly value="${String(email).replace(/"/g, '&quot;')}">
          </div>
          <div class="field" id="nameField-${id}">
            <label>Nome</label>
            <input id="name-${id}" type="text" autocomplete="name" placeholder="Como no cartão" value="${name}">
          </div>
          <div class="field">
            <label>País</label>
            <div class="seg" style="margin:8px 0 0;">
              <button type="button" id="tabBr-${id}" class="active">Brasil</button>
              <button type="button" id="tabIntl-${id}">Exterior</button>
            </div>
          </div>
          <div class="field" id="methodField-${id}">
            <label>Como quer pagar</label>
            <div class="seg" style="margin:8px 0 0;">
              <button type="button" id="tabPix-${id}" class="active">PIX</button>
              <button type="button" id="tabCard-${id}">Cartão</button>
            </div>
          </div>
        </div>
        <button class="pay" id="payBtn-${id}" type="button">Pagar no PIX</button>
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

    function hintText() {
      const intl = state.region === 'international';
      if (intl) {
        return kind() === 'one_shot'
          ? 'Cartão à vista (1x) na dLocal. O checkout pede o país e converte a moeda.'
          : 'Cartão na dLocal. A cobrança se repete todo mês.';
      }
      if (state.method === 'card') {
        return kind() === 'one_shot'
          ? 'Cartão à vista (1x). Ao pagar, o plano é atualizado.'
          : 'Cartão. A cobrança se repete todo mês.';
      }
      return kind() === 'one_shot'
        ? 'PIX à vista (1x). Ao pagar, o plano é atualizado.'
        : 'PIX à vista. A liberação vale 30 dias; no cartão a renovação é automática.';
    }

    function syncChrome() {
      const intl = state.region === 'international';
      el(id, 'tabBr')?.classList.toggle('active', !intl);
      el(id, 'tabIntl')?.classList.toggle('active', intl);
      el(id, 'tabPix')?.classList.toggle('active', state.method === 'pix');
      el(id, 'tabCard')?.classList.toggle('active', state.method === 'card');
      const methodField = document.getElementById(`methodField-${id}`);
      if (methodField) methodField.style.display = intl ? 'none' : '';
      const hint = el(id, 'payHint');
      if (hint) hint.textContent = hintText();
      const btn = el(id, 'payBtn');
      if (btn) {
        btn.dataset.region = state.region;
        btn.dataset.method = intl ? 'card' : state.method;
        btn.disabled = !state.dlocalReady;
        btn.textContent = payLabel(intl ? 'card' : state.method, kind(), state.region, checkout().amount);
      }
    }

    function applyRegion(region) {
      state.region = region === 'international' ? 'international' : 'br';
      if (state.region === 'international') state.method = 'card';
      else if (state.method !== 'pix' && state.method !== 'card') state.method = 'pix';
      syncChrome();
    }

    function applyMethod(method) {
      state.method = method === 'card' ? 'card' : 'pix';
      if (state.region === 'international') state.method = 'card';
      syncChrome();
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

    function payerName(c) {
      const typed = String(el(id, 'name')?.value || '').trim();
      return typed || String(c.name || '').trim();
    }

    async function openDlocalCheckout(c) {
      const method = state.region === 'international' ? 'card' : state.method;
      const name = payerName(c);
      const r = await fetch('/api/dlocal-go-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: c.accountId,
          email: c.email,
          qty: c.qty,
          kind: c.kind === 'one_shot' ? 'one_shot' : 'subscription',
          region: state.region,
          method,
          ...(name ? { name } : {}),
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
      const method = state.region === 'international' ? 'card' : state.method;
      if (typeof ctx.onSubmit === 'function') {
        ctx.onSubmit({ ...c, region: state.region, method });
      }
      btn.disabled = true;
      btn.textContent = 'Processando...';
      try {
        if (!state.dlocalReady) throw new Error('Pagamento dLocal indisponível. Tente de novo em instantes.');
        await openDlocalCheckout(c);
      } catch (err) {
        showErr(err.message);
        btn.disabled = false;
        btn.textContent = payLabel(method, kind(), state.region, c.amount);
      }
    }

    el(id, 'tabBr')?.addEventListener('click', () => applyRegion('br'));
    el(id, 'tabIntl')?.addEventListener('click', () => applyRegion('international'));
    el(id, 'tabPix')?.addEventListener('click', () => applyMethod('pix'));
    el(id, 'tabCard')?.addEventListener('click', () => applyMethod('card'));
    el(id, 'payBtn')?.addEventListener('click', () => submitPay());

    const emailInput = el(id, 'email');
    if (emailInput && checkout().email) emailInput.value = checkout().email;
    const nameInput = el(id, 'name');
    if (nameInput && checkout().name && !nameInput.value) nameInput.value = checkout().name;
    syncChrome();

    loadPayConfig().then((cfg) => {
      state.paddleReady = !!cfg.paddle_ready;
      state.dlocalReady = !!cfg.dlocal_ready;
      applyRegion(cfg.suggest_international ? 'international' : 'br');
    });
  }

  global.PagouPay = { money, formHtml, attach, payLabel };
})(window);
