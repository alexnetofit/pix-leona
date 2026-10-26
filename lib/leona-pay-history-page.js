export const LEONA_PAY_HISTORY_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="no-referrer">
  <title>Grupos Leona Pay</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <style>
    :root {
      --bg: #0c0a12;
      --panel: #151120;
      --card: #1c1730;
      --line: #2c2444;
      --text: #f4f0fb;
      --muted: #9b90b4;
      --faint: #6f6488;
      --accent: #8b5cf6;
      --ok: #34d399;
      --warn: #fbbf24;
      --bad: #f87171;
      --wait: #7dd3fc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 18px 64px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; flex-wrap: wrap; }
    h1 { font-size: 1.45rem; margin: 0 0 6px; }
    .muted { color: var(--muted); margin: 0; font-size: 0.92rem; }
    button, .tab {
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      font-weight: 650;
    }
    .tabs { display: flex; gap: 8px; margin: 22px 0 14px; }
    .tab.active { background: var(--accent); }
    .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 14px; }
    .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px; }
    .stat b { display: block; font-size: 1.3rem; }
    .stat span { color: var(--faint); font-size: 0.75rem; }
    .banner {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .banner strong { display: block; margin-bottom: 4px; }
    .tools { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    input, select {
      background: var(--card);
      color: var(--text);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 11px 12px;
      min-width: 220px;
    }
    .list { display: grid; gap: 10px; }
    article {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px 14px 12px;
    }
    .top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .who { font-weight: 700; }
    .sub { color: var(--muted); font-size: 0.86rem; margin-top: 3px; }
    .pill { border-radius: 999px; padding: 4px 8px; font-size: 0.75rem; font-weight: 750; white-space: nowrap; }
    .ok { background: rgba(52, 211, 153, 0.15); color: var(--ok); }
    .partial { background: rgba(251, 191, 36, 0.15); color: var(--warn); }
    .failed { background: rgba(248, 113, 113, 0.15); color: var(--bad); }
    .queued, .creating { background: rgba(125, 211, 252, 0.14); color: var(--wait); }
    .reason { margin: 10px 0 0; color: var(--text); font-size: 0.92rem; }
    .more { margin-top: 10px; background: transparent; color: var(--wait); padding: 0; border-radius: 0; }
    dl { display: grid; grid-template-columns: 140px 1fr; gap: 6px 10px; margin: 12px 0 0; font-size: 0.86rem; }
    dt { color: var(--faint); }
    dd { margin: 0; overflow-wrap: anywhere; }
    .empty { color: var(--muted); padding: 20px 0; }
    .error { color: var(--bad); }
    @media (max-width: 800px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
      dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Grupos do Leona Pay</h1>
        <p class="muted" id="updated">Carregando…</p>
      </div>
      <button id="reload" type="button">Atualizar</button>
    </header>
    <div class="tabs">
      <button class="tab active" type="button" data-tab="history">Histórico</button>
      <button class="tab" type="button" data-tab="queue">Fila</button>
    </div>
    <div id="board"></div>
  </div>
  <script>
    const board = document.querySelector('#board');
    const updated = document.querySelector('#updated');
    let data = null;
    let tab = 'history';
    let query = '';
    let filter = 'all';
    const tools = document.createElement('div');
    tools.className = 'tools';
    const search = document.createElement('input');
    search.placeholder = 'Nome, e-mail, telefone ou empresa';
    const select = document.createElement('select');
    for (const option of [['all', 'Todos'], ['ok', 'Deu certo'], ['partial', 'Parcial'], ['failed', 'Não deu'], ['queued', 'Na fila']]) {
      const node = document.createElement('option');
      node.value = option[0];
      node.textContent = option[1];
      select.append(node);
    }
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
    select.addEventListener('change', () => { filter = select.value; render(); });
    tools.append(search, select);

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }
    function field(list, label, value) {
      if (!value) return;
      list.append(el('dt', '', label), el('dd', '', value));
    }
    function card(item, position) {
      const article = el('article');
      const top = el('div', 'top');
      const left = el('div');
      const title = position ? (position + '. ' + (item.name || item.email || 'Sem nome')) : (item.name || item.email || 'Sem nome');
      left.append(el('div', 'who', title));
      const company = item.company.tradeName || item.company.legalName || 'Empresa sem nome';
      left.append(el('div', 'sub', company + ' · ' + (item.email || 'sem e-mail') + ' · ' + (item.when || '')));
      top.append(left, el('span', 'pill ' + item.outcome, item.label));
      article.append(top, el('p', 'reason', item.reason || ''));
      const button = el('button', 'more', 'Ver dados');
      const extra = el('dl');
      extra.hidden = true;
      field(extra, 'Telefone', item.phone);
      field(extra, 'E-mail', item.email);
      field(extra, 'Nome fantasia', item.company.tradeName);
      field(extra, 'Razão social', item.company.legalName);
      field(extra, 'Documento', item.company.taxId);
      field(extra, 'País', item.company.country);
      field(extra, 'Endereço', item.company.address);
      field(extra, 'ID da empresa', item.company.id);
      field(extra, 'Conta criada', item.company.createdAt);
      field(extra, 'Grupo', item.groupName);
      field(extra, 'ID do grupo', item.groupJid);
      field(extra, 'Tentativas', item.attempts ? String(item.attempts) : '');
      button.addEventListener('click', () => {
        extra.hidden = !extra.hidden;
        button.textContent = extra.hidden ? 'Ver dados' : 'Esconder dados';
      });
      article.append(button, extra);
      return article;
    }
    function matches(item) {
      if (filter !== 'all' && item.outcome !== filter) return false;
      const hay = [item.name, item.email, item.phone, item.company.tradeName, item.company.legalName, item.company.taxId, item.company.id, item.groupName].join(' ').toLowerCase();
      return hay.includes(query);
    }
    function stat(value, label) {
      const box = el('div', 'stat');
      box.append(el('b', '', String(value)), el('span', '', label));
      return box;
    }
    function render() {
      const focused = document.activeElement === search;
      const start = search.selectionStart;
      const end = search.selectionEnd;
      board.replaceChildren();
      if (!data) return;
      const stats = el('div', 'stats');
      stats.append(
        stat(data.counts.ok, 'Deu certo'),
        stat(data.counts.partial, 'Parcial'),
        stat(data.counts.failed, 'Não deu'),
        stat(data.counts.queued, 'Na fila'),
        stat(data.counts.creating, 'Criando')
      );
      board.append(stats);
      if (tab === 'queue') {
        const banner = el('div', 'banner');
        banner.append(el('strong', '', data.nextLabel), el('span', 'muted', data.windowLabel + '. Um grupo a cada 5 a 10 minutos.'));
        const list = el('div', 'list');
        if (!data.queue.length) list.append(el('p', 'empty', 'Nenhuma empresa esperando.'));
        for (const item of data.queue) list.append(card(item, item.outcome === 'creating' ? 'Agora' : item.position));
        board.append(banner, list);
        return;
      }
      const list = el('div', 'list');
      const rows = data.history.filter(matches);
      if (!rows.length) list.append(el('p', 'empty', 'Nenhuma conta nesse filtro.'));
      for (const item of rows) list.append(card(item));
      board.append(tools, list);
      if (focused) {
        search.focus();
        if (start != null) search.setSelectionRange(start, end);
      }
    }
    async function load(force) {
      if (!force && document.querySelector('article dl:not([hidden])')) return;
      const response = await fetch(location.pathname.replace(/\\/$/, '') + '/dados', { headers: { accept: 'application/json' } });
      if (!response.ok) {
        updated.textContent = 'Não foi possível atualizar.';
        updated.className = 'error';
        return;
      }
      data = await response.json();
      updated.className = 'muted';
      updated.textContent = 'Atualizado às ' + data.updatedAt + ' · ' + (data.windowOpen ? 'janela aberta' : 'janela fechada');
      render();
    }
    document.querySelectorAll('.tab').forEach((button) => {
      button.addEventListener('click', () => {
        tab = button.dataset.tab;
        document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button));
        render();
      });
    });
    document.querySelector('#reload').addEventListener('click', () => load(true));
    load(true);
    setInterval(() => load(false), 15000);
  </script>
</body>
</html>`;
