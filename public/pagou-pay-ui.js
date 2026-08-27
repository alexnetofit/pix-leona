(function (global) {
  function money(n) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
  }

  function digits(v) {
    return String(v || '').replace(/\D/g, '');
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
      ? 'PIX ou cartão à vista (1x). Sem endereço — isso é só da assinatura.'
      : 'PIX ou cartão à vista. Sem endereço. A liberação vale 30 dias.';
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
          <div class="field" id="documentField-${id}">
            <label>CPF ou CNPJ</label>
            <input id="document-${id}" type="text" inputmode="numeric" autocomplete="off" placeholder="000.000.000-00">
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
        <div id="cardFields-${id}" style="display:none;margin-top:16px;">
          <div class="group">
            <div class="field">
              <label>Número do cartão</label>
              <input id="cardNumber-${id}" type="text" inputmode="numeric" autocomplete="cc-number" placeholder="•••• •••• •••• ••••">
            </div>
            <div class="field">
              <label>Validade</label>
              <input id="cardExpiry-${id}" type="text" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/AA">
            </div>
            <div class="field">
              <label>CVV</label>
              <input id="cardCvv-${id}" type="text" inputmode="numeric" autocomplete="cc-csc" placeholder="000">
            </div>
          </div>
        </div>
        <button class="pay" id="payBtn-${id}" type="button">Pagar no PIX</button>
        <div class="err" id="err-${id}"></div>
        <p class="hint" id="payHint-${id}">${hint}</p>
      </div>
      <div class="panel pix-box" id="pixCard-${id}">
        <h2>Pague com PIX</h2>
        <p class="hint">Escaneie o QR ou toque no código para copiar.</p>
        <img id="pixQr-${id}" alt="QR Code PIX">
        <div class="copy" id="pixCopy-${id}"></div>
        <p class="hint" id="pixWait-${id}">Aguardando pagamento…</p>
      </div>
      <div class="panel ok-box" id="okCard-${id}">
        <h2>Pronto</h2>
        <p class="lede" style="margin-bottom:0;">Sua Leona já está sendo liberada.</p>
        ${opts.backHref ? `<p class="hint" style="margin-top:20px;"><a href="${String(opts.backHref).replace(/"/g, '&quot;')}">Voltar para a assinatura</a></p>` : ''}
      </div>
    `;
  }

  function attach(id, ctx) {
    const state = {
      method: 'pix',
      region: 'br',
      paddleReady: false,
      pagarmeReady: false,
      txId: null,
      pixCode: ''
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
        return state.paddleReady
          ? 'Cartão na Paddle, na sua moeda. Sem CPF.'
          : 'Pagamento internacional temporariamente indisponível. Fale com o suporte.';
      }
      if (state.method === 'card') {
        return kind() === 'one_shot'
          ? 'Cartão à vista (1x). Sem endereço — a placa é que pede entrega.'
          : 'Cartão à vista. Sem endereço. A liberação vale 30 dias.';
      }
      return kind() === 'one_shot'
        ? 'PIX à vista (1x). Sem endereço — a placa é que pede entrega.'
        : 'PIX à vista. Sem endereço. A liberação vale 30 dias.';
    }

    function syncChrome() {
      const intl = state.region === 'international';
      el(id, 'tabBr')?.classList.toggle('active', !intl);
      el(id, 'tabIntl')?.classList.toggle('active', intl);
      el(id, 'tabPix')?.classList.toggle('active', state.method === 'pix');
      el(id, 'tabCard')?.classList.toggle('active', state.method === 'card');
      const methodField = document.getElementById(`methodField-${id}`);
      const documentField = document.getElementById(`documentField-${id}`);
      if (methodField) methodField.style.display = intl ? 'none' : '';
      if (documentField) documentField.style.display = intl ? 'none' : '';
      const cardFields = document.getElementById(`cardFields-${id}`);
      if (cardFields) cardFields.style.display = !intl && state.method === 'card' ? 'block' : 'none';
      const hint = el(id, 'payHint');
      if (hint) hint.textContent = hintText();
      const btn = el(id, 'payBtn');
      if (btn) {
        btn.dataset.region = state.region;
        btn.dataset.method = intl ? 'card' : state.method;
        btn.disabled = intl ? !state.paddleReady : !state.pagarmeReady;
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
            ? 'Servidor falhou ao gerar o pagamento. Tente de novo.'
            : (raw.slice(0, 140) || 'Resposta inválida do servidor')
        );
      }
    }

    function payerName(c) {
      const typed = String(el(id, 'name')?.value || '').trim();
      return typed || String(c.name || '').trim();
    }

    function readCard(c) {
      const number = digits(el(id, 'cardNumber')?.value);
      const exp = digits(el(id, 'cardExpiry')?.value);
      const cvv = digits(el(id, 'cardCvv')?.value);
      if (number.length < 13 || exp.length < 4 || cvv.length < 3) return null;
      let year = Number(exp.slice(2));
      if (year < 100) year += 2000;
      return {
        number,
        holder_name: payerName(c),
        exp_month: Number(exp.slice(0, 2)),
        exp_year: year,
        cvv
      };
    }

    function hideChrome() {
      const form = document.getElementById(`payForm-${id}`);
      const chrome = document.getElementById(`payChrome-${id}`);
      if (form) form.style.display = 'none';
      if (chrome) chrome.style.display = 'none';
    }

    function showOk() {
      hideChrome();
      const pix = el(id, 'pixCard');
      const ok = el(id, 'okCard');
      if (pix) pix.style.display = 'none';
      if (ok) ok.style.display = 'block';
      if (typeof ctx.onPaid === 'function') ctx.onPaid();
    }

    async function checkPaid(payId) {
      if (!payId) return false;
      const c = checkout();
      const q = new URLSearchParams({ id: payId, account_id: c.accountId, email: c.email });
      const r = await fetch('/api/pagarme-pay?' + q.toString());
      const data = await r.json().catch(() => ({}));
      return !!(r.ok && data.paid);
    }

    function pollPaid() {
      const timer = setInterval(async () => {
        if (await checkPaid(state.txId)) {
          clearInterval(timer);
          showOk();
        }
      }, 3500);
    }

    function showPix(data) {
      state.txId = data.id;
      state.pixCode = data.pix?.qr_code || '';
      hideChrome();
      const pix = el(id, 'pixCard');
      if (pix) pix.style.display = 'block';
      const copy = el(id, 'pixCopy');
      if (copy) copy.textContent = state.pixCode || 'Código indisponível';
      const qr = el(id, 'pixQr');
      if (state.pixCode && qr) {
        qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(state.pixCode);
      } else if (qr) {
        qr.style.display = 'none';
      }
      if (copy) copy.onclick = () => {
        if (!state.pixCode) return;
        navigator.clipboard.writeText(state.pixCode).then(() => {
          const wait = el(id, 'pixWait');
          if (wait) wait.textContent = 'Código copiado. Aguardando pagamento...';
        });
      };
      pollPaid();
    }

    function payerDocument() {
      return digits(el(id, 'document')?.value);
    }

    async function payPagarme(c) {
      const name = payerName(c);
      const document = payerDocument();
      if (document.length !== 11 && document.length !== 14) {
        throw new Error('Informe um CPF ou CNPJ válido');
      }
      const method = state.method === 'card' ? 'credit_card' : 'pix';
      const body = {
        account_id: c.accountId,
        email: c.email,
        qty: c.qty,
        kind: c.kind === 'one_shot' ? 'one_shot' : 'subscription',
        method,
        document,
        ...(name ? { name } : {}),
        ...(Number(c.amount) > 0 ? { amount: c.amount } : {})
      };
      if (method === 'credit_card') {
        const card = readCard(c);
        if (!card) throw new Error('Preencha os dados do cartão');
        body.card = card;
      }
      const r = await fetch('/api/pagarme-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await readJson(r);
      if (!r.ok) throw new Error(data.error || 'Não foi possível gerar o pagamento');
      if (data.paid) {
        showOk();
        return;
      }
      if (method === 'pix') {
        if (!data.pix?.qr_code) throw new Error('PIX gerado sem código. Tente de novo.');
        showPix(data);
        return;
      }
      throw new Error(data.error || 'Pagamento não concluído');
    }

    async function openPaddleCheckout(c) {
      const name = payerName(c);
      const r = await fetch('/api/paddle-international-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: c.accountId,
          email: c.email,
          qty: c.qty,
          ...(name ? { name } : {})
        })
      });
      const data = await readJson(r);
      if (!r.ok || !data.checkout_url) {
        throw new Error(data.error || 'Não foi possível abrir o checkout da Paddle');
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
        if (state.region === 'international') {
          if (!state.paddleReady) throw new Error('Pagamento internacional indisponível. Fale com o suporte.');
          await openPaddleCheckout(c);
          return;
        }
        if (!state.pagarmeReady) throw new Error('Pagamento indisponível. Tente de novo em instantes.');
        await payPagarme(c);
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
      state.pagarmeReady = !!cfg.pagarme_ready;
      applyRegion(cfg.suggest_international ? 'international' : 'br');
    });
  }

  global.PagouPay = { money, formHtml, attach, payLabel };
})(window);
