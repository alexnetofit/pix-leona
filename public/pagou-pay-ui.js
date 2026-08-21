(function (global) {
  function money(n) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
  }

  function digits(v) {
    return String(v || '').replace(/\D/g, '');
  }

  function payLabel(method, kind) {
    if (method === 'pix') return kind === 'one_shot' ? 'Gerar PIX' : 'Assinar com PIX';
    return kind === 'one_shot' ? 'Pagar no cartão' : 'Assinar no cartão';
  }

  function el(id, name) {
    return document.getElementById(`${name}-${id}`);
  }

  function formHtml(id, opts = {}) {
    const email = opts.email || '';
    const kind = opts.kind === 'one_shot' ? 'one_shot' : 'subscription';
    const hint = kind === 'one_shot'
      ? 'Pagamento único do upgrade no ciclo atual. Não cria nova recorrência.'
      : 'A cobrança se repete todo mês. Cancele quando quiser.';
    return `
      <div id="payForm-${id}">
        <div class="group" style="margin-top:16px;">
          <div class="field">
            <label>E-mail</label>
            <input id="email-${id}" type="email" autocomplete="email" readonly value="${String(email).replace(/"/g, '&quot;')}">
          </div>
          <div class="field">
            <label>Nome</label>
            <input id="name-${id}" type="text" autocomplete="name" placeholder="Como no documento">
          </div>
          <div class="field">
            <label>CPF ou CNPJ</label>
            <input id="document-${id}" type="text" inputmode="numeric" placeholder="000.000.000-00">
          </div>
          <div class="field">
            <label>Celular</label>
            <input id="phone-${id}" type="tel" placeholder="(11) 99999-9999">
          </div>
        </div>
        <div class="seg">
          <button type="button" id="tabPix-${id}" class="active">PIX</button>
          <button type="button" id="tabCard-${id}">Cartão</button>
        </div>
        <div id="cardFields-${id}" style="display:none;">
          <div id="card-element-${id}"></div>
        </div>
        <button class="pay" id="payBtn-${id}" type="button">Assinar com PIX</button>
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
      elements: null,
      card: null,
      cardValid: false,
      txId: null,
      subId: null,
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

    function buyer() {
      return {
        name: (el(id, 'name')?.value || '').trim(),
        document: digits(el(id, 'document')?.value),
        phone: digits(el(id, 'phone')?.value)
      };
    }

    async function createTx(extra = {}) {
      const c = checkout();
      const r = await fetch('/api/pagou-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: c.accountId,
          email: c.email,
          qty: c.qty,
          amount: c.amount,
          offer_name: c.offer,
          kind: kind(),
          buyer: buyer(),
          ...extra
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Falha ao gerar o pagamento');
      return data;
    }

    async function ensureCard() {
      if (state.card || !global.Pagou) return;
      const cfg = await fetch('/api/pagou-config').then((r) => r.json());
      if (!cfg.public_key) {
        showErr('Cartão indisponível no momento. Use PIX.');
        setMethod('pix');
        return;
      }
      state.elements = Pagou.elements({
        publicKey: cfg.public_key,
        locale: 'pt-BR',
        origin: location.origin
      });
      state.card = state.elements.create('card', {
        theme: 'default',
        style: {
          base: {
            color: '#1d1d1f',
            fontFamily: '-apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif',
            fontSize: '17px',
            borderRadius: '8px',
            backgroundColor: '#ffffff'
          },
          focus: { borderColor: '#0071e3' },
          invalid: { color: '#d70015' }
        }
      });
      state.card.mount(`#card-element-${id}`);
      state.card.on('change', ({ valid }) => { state.cardValid = !!valid; });
    }

    async function setMethod(method) {
      state.method = method;
      showErr('');
      el(id, 'tabPix')?.classList.toggle('active', method === 'pix');
      el(id, 'tabCard')?.classList.toggle('active', method === 'card');
      const fields = el(id, 'cardFields');
      if (fields) fields.style.display = method === 'card' ? 'block' : 'none';
      const btn = el(id, 'payBtn');
      if (btn && !btn.disabled) btn.textContent = payLabel(method, kind());
      if (method === 'card') await ensureCard();
    }

    async function checkPaid(payId) {
      if (!payId) return false;
      const c = checkout();
      const q = new URLSearchParams({ id: payId, account_id: c.accountId, email: c.email });
      if (state.subId && payId === state.subId) q.set('type', 'subscription');
      const r = await fetch('/api/pagou-pay?' + q.toString());
      const data = await r.json();
      return !!(r.ok && data.paid);
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

    function showPix(data) {
      state.txId = data.id;
      state.subId = data.subscription_id || null;
      state.pixCode = data.pix?.qr_code || '';
      hideChrome();
      const pix = el(id, 'pixCard');
      if (pix) pix.style.display = 'block';
      const copy = el(id, 'pixCopy');
      if (copy) {
        copy.textContent = state.pixCode || (
          kind() === 'subscription'
            ? 'Abra o app do banco e autorize o PIX automático da Leona.'
            : 'Código indisponível'
        );
      }
      const qr = el(id, 'pixQr');
      const wait = el(id, 'pixWait');
      if (state.pixCode && qr) {
        qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(state.pixCode);
      } else if (qr) {
        qr.style.display = 'none';
        if (wait) {
          wait.textContent = kind() === 'subscription'
            ? 'Aguardando autorização do PIX automático...'
            : 'Aguardando pagamento...';
        }
      }
      pollPaid();
    }

    function copyPix() {
      if (!state.pixCode) return;
      navigator.clipboard.writeText(state.pixCode).then(() => {
        const wait = el(id, 'pixWait');
        if (wait) wait.textContent = 'Código copiado. Aguardando pagamento...';
      });
    }

    async function waitPaid(payId) {
      for (let i = 0; i < 20; i++) {
        if (await checkPaid(payId)) return showOk();
        await new Promise((r) => setTimeout(r, 2000));
      }
      const wait = el(id, 'pixWait');
      if (wait) wait.textContent = 'Pagamento em análise. Atualize a página em instantes.';
    }

    function pollPaid() {
      const timer = setInterval(async () => {
        if (await checkPaid(state.subId || state.txId)) {
          clearInterval(timer);
          showOk();
        }
      }, 3500);
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
      if (typeof ctx.onSubmit === 'function') ctx.onSubmit(c);
      btn.disabled = true;
      btn.textContent = 'Processando...';
      try {
        if (state.method === 'pix') {
          const data = await createTx({ method: 'pix' });
          showPix(data);
          return;
        }
        if (!state.elements || !state.cardValid) {
          throw new Error('Preencha os dados do cartão');
        }
        const result = await state.elements.submit({
          mode: kind() === 'subscription' ? 'subscription' : 'payment',
          createTransaction: async (tokenData) => {
            const created = await createTx({
              method: 'credit_card',
              token: tokenData.token,
              installments: 1
            });
            state.txId = created.id;
            state.subId = created.subscription_id || null;
            const st = String(created.status || '').toLowerCase();
            if (['error', 'refused', 'failed'].includes(st) && !created.next_action) {
              throw new Error(created.error || 'Cartão recusado. Tente outro cartão ou pague com PIX.');
            }
            return { id: created.id, status: created.status, next_action: created.next_action };
          }
        });
        if (result.status === 'error') throw new Error(result.error || 'Cartão recusado');
        await waitPaid(state.subId || state.txId);
      } catch (err) {
        showErr(err.message);
        btn.disabled = false;
        btn.textContent = payLabel(state.method, kind());
      }
    }

    el(id, 'tabPix')?.addEventListener('click', () => setMethod('pix'));
    el(id, 'tabCard')?.addEventListener('click', () => setMethod('card'));
    el(id, 'payBtn')?.addEventListener('click', () => submitPay());
    el(id, 'pixCopy')?.addEventListener('click', () => copyPix());

    const emailInput = el(id, 'email');
    if (emailInput && checkout().email) emailInput.value = checkout().email;
    const hint = el(id, 'payHint');
    if (hint) {
      hint.textContent = kind() === 'one_shot'
        ? 'Pagamento único do upgrade no ciclo atual. Não cria nova recorrência.'
        : 'A cobrança se repete todo mês. Cancele quando quiser.';
    }
    const btn = el(id, 'payBtn');
    if (btn) btn.textContent = payLabel(state.method, kind());
  }

  global.PagouPay = { money, formHtml, attach, payLabel };
})(window);
