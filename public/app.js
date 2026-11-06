// ---------------------------------------------------------------------------
// Kontor Gestão Empresas — interface (JavaScript puro, sem build)
// ---------------------------------------------------------------------------

const $ = (s, el = document) => el.querySelector(s);
const conteudo = $('#conteudo');
const estado = { token: localStorage.getItem('token'), usuario: null, empresas: [], empresaId: Number(localStorage.getItem('empresaId')) || null };

/** O usuário tem a permissão "Excluir registros"? (o servidor confere de novo) */
const podeExcluirRegistros = () => estado.usuario.modulos.includes('excluir');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const brl = (n) => Number(n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
/** Datas do banco vêm em UTC ("2026-10-24 01:25:38"); mostra no horário de Brasília. */
const dhBr = (s) => {
  if (!s) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};
const dataBr = (s) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '');
const mesAtual = () => new Date().toISOString().slice(0, 7);
const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const fmtDoc = (d) => !d ? '' : d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d;
const numero = (v) => (v === '' || v == null ? null : Number(String(v).replace(/\./g, '').replace(',', '.')));
const STATUS = { AUTORIZADA: 'Autorizada', CANCELADA: 'Cancelada', REJEITADA: 'Rejeitada', ERRO_COMUNICACAO: 'Sem resposta', PENDENTE: 'Pendente' };
const carimbo = (s, grande) => `<span class="carimbo ${s}${grande ? ' grande' : ''}">${STATUS[s] ?? s}</span>`;

function aviso(msg) {
  const a = $('#aviso');
  a.textContent = msg;
  a.classList.add('visivel');
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => a.classList.remove('visivel'), 4500);
}

async function api(metodo, url, corpo, { bruto = false } = {}) {
  const opts = { method: metodo, headers: { Authorization: `Bearer ${estado.token}` } };
  if (corpo instanceof FormData) opts.body = corpo;
  else if (corpo !== undefined) { opts.body = JSON.stringify(corpo); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opts);
  if (r.status === 401) { sair(); throw new Error('Sessão expirada.'); }
  if (bruto) { if (!r.ok) throw new Error((await r.json()).erro); return r; }
  const json = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) {
    const e = new Error(json?.erro ?? `Erro ${r.status}`);
    e.campos = json?.campos; e.detalhes = json?.detalhes;
    throw e;
  }
  return json;
}

function mensagemErro(e) {
  if (e.campos?.length) return `${e.message}: ${e.campos.map((c) => `${c.campo || 'campo'} — ${c.mensagem}`).join('; ')}`;
  if (Array.isArray(e.detalhes) && e.detalhes.length) {
    const itens = e.detalhes.map((d) => (typeof d === 'string' ? d : d?.codigo ? `[${d.codigo}] ${d.descricao ?? ''}` : d?.descricao ?? '')).filter(Boolean);
    if (itens.length) return `${e.message} ${itens.join(' ')}`;
  }
  return e.message;
}

async function baixar(url, nome, abrir = false) {
  try {
    const r = await api('GET', url, undefined, { bruto: true });
    const blob = URL.createObjectURL(await r.blob());
    if (abrir) window.open(blob, '_blank');
    else Object.assign(document.createElement('a'), { href: blob, download: nome }).click();
  } catch (e) { aviso(mensagemErro(e)); }
}

async function baixarImagem(url, img) {
  try { const r = await api('GET', url, undefined, { bruto: true }); img.src = URL.createObjectURL(await r.blob()); } catch { img.replaceWith(Object.assign(document.createElement('span'), { className: 'dica', textContent: 'Imagem não encontrada.' })); }
}

/** Lê um formulário em objeto, convertendo campos marcados com data-num. */
function lerForm(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { o[el.name] = el.checked; continue; }
    const v = el.value.trim();
    o[el.name] = el.dataset.num !== undefined ? numero(v) : v === '' ? null : v;
  }
  return o;
}

function abrirDialogo(html, aoAbrir) {
  const d = $('#dialogo');
  $('#dialogo-corpo').innerHTML = html;
  d.showModal();
  d.querySelectorAll('[data-fechar]').forEach((b) => (b.onclick = () => d.close()));
  aoAbrir?.(d);
  return d;
}

/**
 * Consulta de clientes por F2: abre uma busca (nome, CNPJ/CPF ou e-mail) sobre a lista do <select>.
 * Setas navegam, Enter escolhe, Esc fecha. Vale em qualquer tela que passe o formulário e o select.
 */
function habilitarConsultaF2(form, select, clientes, titulo = 'Consultar cliente') {
  const abrir = () => {
    let sel = 0, achados = clientes;
    const norm = (x) => String(x ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    abrirDialogo(`
      <h2>${esc(titulo)}</h2>
      <input id="f2-busca" type="search" autocomplete="off" placeholder="Digite o nome, CNPJ/CPF ou e-mail" style="width:100%">
      <div class="rolagem" style="max-height:320px;margin-top:10px"><table class="tabela"><tbody id="f2-lista"></tbody></table></div>
      <p class="dica">↑ ↓ para navegar · Enter para escolher · Esc para fechar</p>
      <div class="acoes"><button type="button" data-fechar>Fechar</button></div>`, (d) => {
      const lista = d.querySelector('#f2-lista'), busca = d.querySelector('#f2-busca');
      const escolher = (t) => { d.close(); select.value = String(t.id); select.dispatchEvent(new Event('change')); select.focus(); };
      const pintar = () => {
        const q = norm(busca.value).replace(/\s+/g, ' ').trim(), qd = q.replace(/\D/g, '');
        achados = clientes.filter((t) => !q || norm(t.nome).includes(q) || norm(t.email).includes(q) || (qd && String(t.documento ?? '').replace(/\D/g, '').includes(qd)));
        sel = Math.min(sel, Math.max(achados.length - 1, 0));
        lista.innerHTML = achados.length ? achados.slice(0, 200).map((t, i) => `<tr class="clicavel ${i === sel ? 'sel-f2' : ''}" data-i="${i}"><td>${esc(t.nome)}</td><td>${t.documento ? fmtDoc(t.documento) : ''}</td></tr>`).join('') : '<tr><td class="dica">Nenhum cliente encontrado.</td></tr>';
        lista.querySelectorAll('tr[data-i]').forEach((tr) => (tr.onclick = () => escolher(achados[tr.dataset.i])));
        lista.querySelector('.sel-f2')?.scrollIntoView({ block: 'nearest' });
      };
      busca.oninput = () => { sel = 0; pintar(); };
      busca.onkeydown = (ev) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(sel + 1, achados.length - 1); pintar(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(sel - 1, 0); pintar(); }
        else if (ev.key === 'Enter') { ev.preventDefault(); if (achados[sel]) escolher(achados[sel]); }
      };
      pintar(); busca.focus();
    });
  };
  form.addEventListener('keydown', (ev) => { if (ev.key === 'F2') { ev.preventDefault(); abrir(); } });
}

/**
 * Campo de cliente com busca enquanto digita: o <select> original continua sendo a fonte do valor (fica oculto),
 * e o campo de texto filtra a lista por nome, CNPJ/CPF ou e-mail. Setas + Enter escolhem; texto vazio = sem cliente.
 */
function ligarBuscaCliente(select, clientes) {
  const norm = (x) => String(x ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const caixa = document.createElement('div'); caixa.className = 'busca-cliente';
  caixa.innerHTML = '<input type="text" autocomplete="off" role="combobox" aria-expanded="false" placeholder="Digite o nome ou CNPJ/CPF do cliente (vazio = consumidor não identificado)"><ul role="listbox" hidden></ul>';
  const entrada = caixa.querySelector('input'), lista = caixa.querySelector('ul');
  select.hidden = true;
  select.insertAdjacentElement('beforebegin', caixa);
  let achados = [], sel = 0;
  const rotulo = (t) => t.nome;
  const doSelect = () => { const t = clientes.find((x) => x.id === Number(select.value)); return t ? rotulo(t) : ''; };
  const sincronizar = () => { entrada.value = doSelect(); };
  const fechar = () => { lista.hidden = true; entrada.setAttribute('aria-expanded', 'false'); };
  const pintar = () => {
    const q = norm(entrada.value).replace(/\s+/g, ' ').trim(), qd = q.replace(/\D/g, '');
    achados = clientes.filter((t) => !q || norm(t.nome).includes(q) || norm(t.email).includes(q) || (qd && String(t.documento ?? '').replace(/\D/g, '').includes(qd))).slice(0, 12);
    sel = Math.min(sel, Math.max(achados.length - 1, 0));
    lista.innerHTML = achados.length
      ? achados.map((t, i) => `<li role="option" data-i="${i}" class="${i === sel ? 'sel' : ''}"><span>${esc(t.nome)}</span><small>${t.documento ? fmtDoc(t.documento) : ''}</small></li>`).join('')
      : '<li class="vazio-busca">Nenhum cliente encontrado.</li>';
    lista.hidden = false; entrada.setAttribute('aria-expanded', 'true');
    lista.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const escolher = (t) => { select.value = String(t.id); sincronizar(); fechar(); select.dispatchEvent(new Event('change')); };
  entrada.addEventListener('input', () => {
    sel = 0;
    if (!entrada.value.trim() && select.value) { select.value = ''; select.dispatchEvent(new Event('change')); } // apagou o campo: sem cliente
    pintar();
  });
  entrada.addEventListener('focus', () => { entrada.select(); });
  entrada.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (lista.hidden) pintar(); else { sel = Math.min(sel + 1, achados.length - 1); pintar(); } }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(sel - 1, 0); pintar(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (!lista.hidden && achados[sel]) escolher(achados[sel]); } // nunca envia o formulário por aqui
    else if (ev.key === 'Escape') { if (!lista.hidden) { ev.stopPropagation(); fechar(); sincronizar(); } }
    else if (ev.key === 'Tab') { if (!lista.hidden && achados[sel] && entrada.value.trim() && norm(entrada.value) !== norm(doSelect())) escolher(achados[sel]); else fechar(); }
  });
  entrada.addEventListener('blur', () => setTimeout(() => { fechar(); sincronizar(); }, 120));
  lista.addEventListener('mousedown', (ev) => { ev.preventDefault(); const li = ev.target.closest('li[data-i]'); if (li) escolher(achados[li.dataset.i]); });
  select.addEventListener('change', sincronizar);
  sincronizar();
}

/** Busca endereço e código IBGE pelo CEP (ViaCEP). */
async function buscarCep(form) {
  const cep = form.cep.value.replace(/\D/g, '');
  if (cep.length !== 8) return;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`).then((x) => x.json());
    if (r.erro) return aviso('CEP não encontrado.');
    for (const [campo, valor] of [['logradouro', r.logradouro], ['bairro', r.bairro], ['cod_municipio', r.ibge], ['uf', r.uf]]) {
      if (form[campo] && valor && !form[campo].value) form[campo].value = valor;
    }
    if (form.cod_municipio && r.ibge) form.cod_municipio.value = r.ibge;
    if (form.cidade && r.localidade) form.cidade.value = r.localidade;
    if (form.uf && r.uf) form.uf.value = r.uf;
    const info = form.querySelector('[data-municipio]');
    if (info) info.textContent = `${r.localidade}/${r.uf} — IBGE ${r.ibge}`;
  } catch { /* sem internet: preenchimento manual */ }
}

// ---- Dia útil (espelha src/servicos/diautil.ts; o servidor confere de novo) ----
const DIA_MS = 864e5;
function pascoaMs(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
function feriadosAno(y, extras) {
  const S = new Set(), p = pascoaMs(y), iso = (t) => new Date(t).toISOString().slice(0, 10);
  ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].forEach((x) => S.add(`${y}-${x}`));
  [-48, -47, -2, 60].forEach((n) => S.add(iso(p + n * DIA_MS)));
  String(extras ?? '').split(/[,;\s]+/).forEach((t) => { const m = t.match(/^(\d{1,2})\/(\d{1,2})$/); if (m) S.add(`${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`); });
  return S;
}
function motivoNaoUtil(ds, extras) {
  const [y, m, d] = ds.split('-').map(Number), w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 'domingo' : w === 6 ? 'sábado' : feriadosAno(y, extras).has(ds) ? 'feriado' : '';
}
function ajustarVencimento(venc, extras) {
  const motivo = motivoNaoUtil(venc, extras);
  if (!motivo) return { data: venc };
  const andar = (sentido) => { let t = Date.parse(venc + 'T00:00:00Z'); for (let i = 0; i < 15 && motivoNaoUtil(new Date(t).toISOString().slice(0, 10), extras); i++) t += sentido * DIA_MS; return new Date(t).toISOString().slice(0, 10); };
  let novo = andar(-1);
  if (novo < hoje()) novo = andar(1);
  return { data: novo, aviso: `Vencimento ajustado: ${dataBr(venc)} cai em ${motivo}; ${novo < venc ? 'antecipado' : 'adiado'} para ${dataBr(novo)}.` };
}

// ---- Gráficos simples em SVG ----
const compacto = (n) => (n >= 1000 ? 'R$ ' + (n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil' : brl(n));
const nomeMes = (ym) => ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(ym.slice(5)) - 1] + '/' + ym.slice(2, 4);
/** Barras agrupadas: cada série é { cor, valores[] }; rótulos no eixo X. */
function graficoBarras(rotulos, series, destaque) {
  const max = Math.max(1, ...series.flatMap((x) => x.valores));
  const larg = 600 / rotulos.length, bw = Math.min(40, (larg - 14) / series.length);
  let svg = '<svg viewBox="0 0 600 230" role="img" style="width:100%;height:auto"><line x1="10" x2="590" y1="190" y2="190" stroke="currentColor" opacity=".25"/>';
  rotulos.forEach((r, i) => {
    const x0 = i * larg + (larg - bw * series.length) / 2;
    series.forEach((se, j) => {
      const v = se.valores[i], h = (v / max) * 150, x = x0 + j * bw;
      svg += `<rect x="${x}" y="${190 - h}" width="${bw - 3}" height="${h}" rx="3" fill="${se.cor}"/>`;
      if (v > 0) svg += `<text x="${x + (bw - 3) / 2}" y="${186 - h}" text-anchor="middle" font-size="10" fill="currentColor">${compacto(v).replace('R$ ', '')}</text>`;
    });
    svg += `<text x="${i * larg + larg / 2}" y="210" text-anchor="middle" font-size="11" fill="currentColor" opacity="${i === destaque ? 1 : .65}" ${i === destaque ? 'font-weight="700"' : ''}>${nomeMes(r)}</text>`;
  });
  return svg + '</svg>';
}
const legenda = (itens) => `<div class="legenda">${itens.map(([cor, t]) => `<span><i style="background:${cor}"></i>${t}</span>`).join('')}</div>`;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
/** Cores dos gráficos acompanham o tema escolhido. */
const COR = { get verde() { return cssVar('--verde'); }, get laranja() { return cssVar('--laranja'); }, get vermelho() { return cssVar('--vermelho'); } };

// ---------------------------------------------------------------------------
// Sessão e estrutura
// ---------------------------------------------------------------------------

function sair() {
  localStorage.removeItem('token');
  estado.token = null;
  $('#app').hidden = true;
  $('#setup').hidden = true;
  $('#login').hidden = false;
}

function mostrarSetup() {
  $('#app').hidden = true;
  $('#login').hidden = true;
  $('#setup').hidden = false;
}

$('#form-setup').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.senha.value !== f.senha2.value) return ($('#erro-setup').textContent = 'As senhas não são iguais.');
  try {
    const r = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ escritorio: f.escritorio.value, nome: f.nome.value, usuario: f.usuario.value.trim().toUpperCase(), email: f.email.value, senha: f.senha.value }) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.erro), { campos: j.campos });
    estado.token = j.token;
    localStorage.setItem('token', j.token);
    $('#setup').hidden = true;
    iniciar();
  } catch (e) { $('#erro-setup').textContent = mensagemErro(e); }
};

$('#form-login').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: f.usuario.value.trim().toUpperCase(), senha: f.senha.value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.erro);
    estado.token = j.token;
    localStorage.setItem('token', j.token);
    iniciar();
  } catch (e) { $('#erro-login').textContent = e.message; }
};
$('#sair').onclick = sair;

// Esqueci minha senha: 1) informa o usuário e recebe um código por e-mail; 2) informa o código e a senha nova.
$('#esqueci').onclick = () => abrirDialogo(`
  <form id="form-esqueci"><h2>Esqueci minha senha</h2>
    <p class="sutil">Enviamos um código de 6 dígitos para o e-mail cadastrado no seu usuário. Com ele, você cria a sua senha nova.</p>
    <label>Usuário <input name="usuario" required autocapitalize="characters" style="text-transform:uppercase" value="${esc($('#form-login').usuario.value.trim().toUpperCase())}"></label>
    <p class="erro" id="erro-esqueci"></p>
    <div class="acoes"><button class="primario" type="submit">Enviar código por e-mail</button><button type="button" data-fechar>Fechar</button></div>
  </form>`, (d) => {
  $('#form-esqueci').onsubmit = async (ev) => {
    ev.preventDefault();
    const usuario = ev.target.usuario.value.trim().toUpperCase();
    try {
      const r = await fetch('/api/esqueci-senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || 'Não foi possível enviar.');
      $('#dialogo-corpo').innerHTML = `
        <form id="form-codigo"><h2>Digite o código</h2>
          <p class="sutil">${esc(j.mensagem)}</p>
          <label>Código de 6 dígitos <input name="codigo" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"></label>
          <label>Nova senha <input name="nova" type="password" minlength="8" required autocomplete="new-password"><span class="dica">Mínimo de 8 caracteres.</span></label>
          <label>Repita a nova senha <input name="nova2" type="password" minlength="8" required autocomplete="new-password"></label>
          <p class="erro" id="erro-codigo"></p>
          <div class="acoes"><button class="primario" type="submit">Salvar nova senha</button><button type="button" data-fechar>Fechar</button></div>
        </form>`;
      d.querySelectorAll('[data-fechar]').forEach((b) => (b.onclick = () => d.close()));
      $('#form-codigo').onsubmit = async (e2) => {
        e2.preventDefault();
        if (e2.target.nova.value !== e2.target.nova2.value) return ($('#erro-codigo').textContent = 'As senhas novas não são iguais.');
        try {
          const r2 = await fetch('/api/esqueci-senha/confirmar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario, codigo: e2.target.codigo.value.trim(), nova: e2.target.nova.value }) });
          const j2 = await r2.json();
          if (!r2.ok) throw new Error(j2.erro || 'Código inválido.');
          d.close(); $('#form-login').usuario.value = usuario; $('#form-login').senha.focus();
          $('#erro-login').textContent = ''; aviso(j2.mensagem);
        } catch (e) { $('#erro-codigo').textContent = e.message; }
      };
    } catch (e) { $('#erro-esqueci').textContent = e.message; }
  };
});

/** Troca de senha. Obrigatória (sem como fechar) no primeiro acesso com senha provisória. */
function trocarSenha({ obrigatoria = false } = {}) {
  const d = abrirDialogo(`
    <form id="form-senha"><h2>${obrigatoria ? 'Crie sua senha' : 'Alterar minha senha'}</h2>
      ${obrigatoria ? '<p class="sutil">Você está usando uma senha provisória. Escolha uma senha só sua para continuar.</p>' : ''}
      <label>Senha atual <input name="atual" type="password" required autocomplete="current-password"></label>
      <label>Nova senha <input name="nova" type="password" minlength="8" required autocomplete="new-password"><span class="dica">Mínimo de 8 caracteres.</span></label>
      <label>Repita a nova senha <input name="nova2" type="password" minlength="8" required autocomplete="new-password"></label>
      <p class="erro" id="erro-senha"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar senha</button>${obrigatoria ? '<button type="button" id="senha-sair">Sair</button>' : '<button type="button" data-fechar>Fechar</button>'}</div>
    </form>`, (dlg) => {
    if (obrigatoria) { dlg.oncancel = (e) => e.preventDefault(); $('#senha-sair').onclick = () => { dlg.close(); sair(); }; }
    $('#form-senha').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      if (f.nova.value !== f.nova2.value) return ($('#erro-senha').textContent = 'As senhas novas não são iguais.');
      try {
        const r = await api('PUT', '/api/me/senha', { atual: f.atual.value, nova: f.nova.value });
        estado.token = r.token; localStorage.setItem('token', r.token);
        dlg.oncancel = null; dlg.close(); aviso('Senha alterada.');
        if (obrigatoria) iniciar();
      } catch (e) { $('#erro-senha').textContent = mensagemErro(e); }
    };
  });
  return d;
}

async function carregarEmpresas() {
  estado.empresas = await api('GET', '/api/empresas');
  if (!estado.empresas.some((e) => e.id === estado.empresaId)) estado.empresaId = estado.empresas[0]?.id ?? null;
  const sel = $('#empresa-atual');
  sel.innerHTML = estado.empresas.length
    ? estado.empresas.map((e) => `<option value="${e.id}" ${e.id === estado.empresaId ? 'selected' : ''}>${esc(e.nome_fantasia || e.razao_social)}</option>`).join('')
    : '<option>Nenhuma empresa cadastrada</option>';
  infoEmpresa();
}

function empresa() { return estado.empresas.find((e) => e.id === estado.empresaId); }

function infoEmpresa() {
  const e = empresa();
  if (!e) { $('#info-empresa').innerHTML = ''; return; }
  const dias = e.cert_validade ? Math.floor((new Date(e.cert_validade) - Date.now()) / 864e5) : null;
  $('#empresa-atual').title = e.razao_social;
  $('#info-empresa').innerHTML = `${fmtDoc(e.documento)}<br>
    ${e.ambiente === 1 ? 'Produção' : '<span class="alerta">Produção restrita (testes)</span>'} · série ${esc(e.serie)}<br>
    ${!e.tem_certificado ? `<span class="alerta selo-cert ruim">${icone('alerta')}Sem certificado A1</span>`
      : dias < 0 ? `<span class="alerta selo-cert ruim">${icone('alerta')}Certificado vencido em ${dataBr(e.cert_validade)}</span>`
      : dias < 30 ? `<span class="alerta selo-cert aviso">${icone('alerta')}Certificado vence em ${dias} dias</span>`
      : `<span class="selo-cert ok">Certificado até ${dataBr(e.cert_validade)} ${icone('ok')}</span>`}`;
}

$('#empresa-atual').onchange = (ev) => {
  estado.empresaId = Number(ev.target.value);
  localStorage.setItem('empresaId', estado.empresaId);
  api('PUT', '/api/me/empresa', { id: estado.empresaId }).catch(() => {});
  infoEmpresa();
  rotear();
};

async function iniciar() {
  try { estado.usuario = await api('GET', '/api/me'); } catch { return sair(); }
  // a escolha guardada no banco vale quando o navegador não lembra (porta/origem mudou após atualizar)
  if (!localStorage.getItem('empresaId') && estado.usuario.ultima_empresa_id) estado.empresaId = estado.usuario.ultima_empresa_id;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#nome-usuario').textContent = `${estado.usuario.nome} (${estado.usuario.login})`;
  document.querySelectorAll('[data-modulo]').forEach((a) => (a.hidden = !estado.usuario.modulos.includes(a.dataset.modulo)));
  // módulos vendidos à parte e ainda não contratados: o item fica no menu, com a marca "contratar"
  for (const m of estado.usuario.naoContratados ?? []) {
    const a = document.querySelector(`#menu a[data-modulo="${m.id}"]`);
    if (a) { a.hidden = false; a.classList.add('nao-contratado'); if (!a.querySelector('.selo-contratar')) a.insertAdjacentHTML('beforeend', '<span class="selo-contratar">contratar</span>'); }
  }
  // grupos do menu: somem se nenhum item é permitido; a abertura de cada um fica guardada neste navegador
  document.querySelectorAll('#menu details.grupo').forEach((g) => {
    g.hidden = ![...g.querySelectorAll('a')].some((a) => !a.hidden);
    let guardado = null; try { guardado = localStorage.getItem('menu-' + g.dataset.grupo); } catch { /* sem armazenamento */ }
    g.open = guardado === '1';
    g.addEventListener('toggle', () => { try { localStorage.setItem('menu-' + g.dataset.grupo, g.open ? '1' : '0'); } catch { /* ok */ } });
  });
  // quem não tem o acesso a Relatórios ainda enxerga o manual, por um item próprio no menu
  $('#menu-doc').hidden = estado.usuario.modulos.includes('relatorios');
  iconesMenu(); iniciarTopo();
  if (estado.usuario.trocar_senha) { $('#app').hidden = true; return trocarSenha({ obrigatoria: true }); }
  await carregarEmpresas();
  atualizarLicenca();
  iniciarAbas(); // depois das empresas: reabre a aba que estava ativa
  if (!location.hash || !telaPermitida((location.hash.split('/')[1] || 'inicio'))) location.hash = '#/inicio';
  rotear();
}

/** A tela pertence a algum módulo liberado para o usuário? (o servidor confere de novo em cada chamada) */
function telaPermitida(nome) {
  const modulo = { painel: 'painel', emitir: 'emitir', orcamentos: 'emitir', orcamento: 'emitir', notas: 'notas', nota: 'notas', cobrancas: 'cobrancas', banco: 'empresas', despesas: 'despesas', compras: 'compras', entradas: 'compras', 'compra-nova': 'compras', 'nfe-sefaz': 'compras', tributacao: 'tributacao', extrato: 'despesas', cartao: 'despesas', agenda: 'emitir', relatorios: 'relatorios', tomadores: 'tomadores', servicos: 'servicos', empresas: 'empresas' }[nome];
  return nome === 'config' || nome === 'inicio' || (modulo && estado.usuario.modulos.includes(modulo));
}

const rotas = {
  inicio: telaInicio, painel: telaPainel, emitir: telaEmitir, orcamentos: telaOrcamentos, orcamento: telaOrcamento, notas: telaNotas, nota: telaNota,
  cobrancas: telaCobrancas, banco: telaBanco, despesas: telaDespesas, compras: telaCompras, entradas: telaCompras, 'compra-nova': telaCompraManual, 'nfe-sefaz': telaNfeSefaz, tributacao: telaTributacao, extrato: telaExtrato, cartao: telaCartao, agenda: telaAgenda, relatorios: telaRelatorios, tomadores: telaTomadores, servicos: telaServicos, empresas: telaEmpresas, config: telaConfig,
};

function rotear() {
  const [, nome = 'painel', param] = location.hash.split('/');
  abasNavegou(); // a aba ativa passa a mostrar esta tela
  document.querySelectorAll('#menu details.grupo').forEach((g) => { const ativo = [...g.querySelectorAll('a')].some((a) => a.getAttribute('href') === `#/${nome}` && !a.hidden); g.classList.toggle('tem-ativo', ativo); if (ativo) g.open = true; });
  document.querySelectorAll('nav a, .lateral-rodape a').forEach((a) => a.classList.toggle('ativo', a.getAttribute('href') === `#/${nome}` || (a.id === 'menu-doc' && nome === 'relatorios' && param === 'documentacao') || (a.closest('.lateral-rodape') && a.getAttribute('href') === '#/config' && nome === 'config')));
  const manual = nome === 'relatorios' && param === 'documentacao'; // o manual é de todos os usuários
  if (['usuarios', 'email', 'backup', 'licenca'].includes(nome)) { location.hash = '#/config/' + nome; return; } // endereços antigos
  const naoContratado = (estado.usuario.naoContratados ?? []).find((m) => m.id === nome);
  if (naoContratado) return telaNaoContratado(naoContratado);
  if (!manual && !telaPermitida(nome)) { conteudo.innerHTML = '<div class="vazio"><p>Seu usuário não tem acesso a esta funcionalidade.</p></div>'; return; }
  const precisaEmpresa = !manual && !['inicio', 'painel', 'empresas', 'nota', 'config'].includes(nome);
  if (precisaEmpresa && !empresa()) {
    conteudo.innerHTML = `<div class="vazio"><p>Cadastre a primeira empresa para começar a emitir.</p>
      ${estado.usuario.papel !== 'cliente' ? '<a href="#/empresas">Cadastrar empresa</a>' : ''}</div>`;
    return;
  }
  (rotas[nome] ?? telaPainel)(param).catch((e) => (conteudo.innerHTML = `<p class="erro">${esc(mensagemErro(e))}</p>`));
  conteudo.focus();
}
window.addEventListener('hashchange', rotear);

// ---------------------------------------------------------------------------
// Painel do mês
// ---------------------------------------------------------------------------

async function telaPainel() {
  const mes = telaPainel.mes ?? mesAtual();
  const linhas = await api('GET', `/api/relatorios/resumo?mes=${mes}`);
  const tot = linhas.reduce((a, l) => ({ fat: a.fat + (l.faturado ?? 0), aut: a.aut + (l.autorizadas ?? 0), pend: a.pend + (l.pendencias ?? 0) }), { fat: 0, aut: 0, pend: 0 });
  const fin = empresa() ? await api('GET', `/api/empresas/${estado.empresaId}/painel?mes=${mes}`).catch(() => null) : null;
  const k = fin?.kpis;
  conteudo.innerHTML = `
    <div class="topo">
      <div><h1>Painel do mês</h1><p class="sutil">Cobranças e recebimentos de ${esc(empresa()?.nome_fantasia || empresa()?.razao_social || 'sua empresa')} e notas de todas as empresas.</p></div>
      <label>Mês <input type="month" id="mes" value="${mes}"></label>
    </div>
    ${fin ? `
    <div class="resumo">
      <div class="cartao"><div class="sutil">Faturado</div><div class="valor">${compacto(k.faturado)}</div><div class="dica">${k.qtd} cobrança(s) com vencimento no mês</div></div>
      <div class="cartao"><div class="sutil">Recebido</div><div class="valor" style="color:${COR.verde}">${compacto(k.recebido)}</div><div class="dica">${k.pctRecebido}% do faturado</div></div>
      <div class="cartao"><div class="sutil">A receber</div><div class="valor">${compacto(k.aReceber)}</div><div class="dica">${k.qtdAReceber} em dia</div></div>
      <div class="cartao"><div class="sutil">Em atraso</div><div class="valor" style="color:${k.qtdAtraso ? COR.vermelho : 'inherit'}">${compacto(k.emAtraso)}</div><div class="dica">${k.qtdAtraso} cobrança(s) · inadimplência ${k.inadimplencia}%</div></div>
      <div class="cartao"><div class="sutil">Falta emitir</div><div class="valor">${fin.faltamEmitir.qtd}</div><div class="dica">de ${fin.faltamEmitir.total} cliente(s) em ${nomeMes(mes)}</div></div>
    </div>
    <div class="cartao" style="margin-top:16px"><h2 style="margin-top:0">Dicas para o seu caixa</h2>
      <ul class="dicas">${fin.dicas.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>
    <div class="duas-colunas">
      <div class="cartao"><h2 style="margin-top:0">Cobranças dos últimos 6 meses</h2>
        ${graficoBarras(fin.serie.map((x) => x.mes), [{ cor: COR.verde, valores: fin.serie.map((x) => x.recebido) }, { cor: COR.laranja, valores: fin.serie.map((x) => x.aberto) }], 5)}
        ${legenda([[COR.verde, 'Recebido'], [COR.laranja, 'Em aberto']])}</div>
      <div class="cartao"><h2 style="margin-top:0">Receitas × despesas</h2>
        ${graficoBarras(fin.balanco.map((x) => x.mes), [{ cor: COR.verde, valores: fin.balanco.map((x) => x.receitas) }, { cor: COR.vermelho, valores: fin.balanco.map((x) => x.despesas) }], 5)}
        ${legenda([[COR.verde, 'Recebido no mês'], [COR.vermelho, 'Despesas']])}
        <p class="dica"><a href="#/despesas">Lançar despesas e ver o balanço</a></p></div>
    </div>
    <div class="duas-colunas">
      <div class="cartao"><h2 style="margin-top:0">Atrasadas</h2>
        ${fin.atrasadas.length ? `<table class="tabela"><tbody>${fin.atrasadas.map((c) => `<tr><td>${esc(c.tomador)}</td><td class="num">${brl(c.valor)}</td><td class="sutil">venceu em ${dataBr(c.vencimento)} (${c.dias} dia(s))</td></tr>`).join('')}</tbody></table>` : '<p class="sutil">Nenhuma cobrança em atraso.</p>'}
        <p class="dica"><a href="#/cobrancas">Abrir Cobranças</a></p></div>
      <div class="cartao"><h2 style="margin-top:0">Falta emitir em ${nomeMes(mes)}</h2>
        ${fin.faltamEmitir.qtd ? `<ul class="dicas">${fin.faltamEmitir.clientes.map((c) => `<li>${esc(c.nome)}</li>`).join('')}${fin.faltamEmitir.qtd > fin.faltamEmitir.clientes.length ? `<li class="sutil">e mais ${fin.faltamEmitir.qtd - fin.faltamEmitir.clientes.length}…</li>` : ''}</ul>` : '<p class="sutil">Todos os clientes já foram faturados neste mês.</p>'}
        <p class="dica"><a href="#/emitir">Emitir agora</a></p></div>
    </div>
    <h2>Notas por empresa</h2>` : ''}
    <div class="resumo">
      <div class="cartao"><div class="sutil">Faturado (autorizadas)</div><div class="valor">${brl(tot.fat)}</div></div>
      <div class="cartao"><div class="sutil">Notas autorizadas</div><div class="valor">${tot.aut}</div></div>
      <div class="cartao"><div class="sutil">Pendências</div><div class="valor ${tot.pend ? 'pendente-txt' : ''}">${tot.pend}</div>
        <div class="dica">Rejeitadas ou sem resposta da Sefin</div></div>
    </div>
    <h2>Por empresa</h2>
    ${linhas.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Empresa</th><th class="num">Autorizadas</th><th class="num">Canceladas</th><th class="num">Pendências</th><th class="num">Faturado</th></tr></thead><tbody>
      ${linhas.map((l) => `<tr class="clicavel" data-id="${l.empresa_id}"><td>${esc(l.empresa)}</td><td class="num">${l.autorizadas ?? 0}</td><td class="num">${l.canceladas ?? 0}</td>
        <td class="num ${l.pendencias ? 'pendente-txt' : ''}">${l.pendencias ?? 0}</td><td class="num">${brl(l.faturado)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="vazio">Nenhuma empresa cadastrada ainda.</div>'}`;
  $('#mes').onchange = (e) => { telaPainel.mes = e.target.value; telaPainel(); };
  conteudo.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => {
    estado.empresaId = Number(tr.dataset.id); localStorage.setItem('empresaId', estado.empresaId);
    api('PUT', '/api/me/empresa', { id: estado.empresaId }).catch(() => {});
    $('#empresa-atual').value = estado.empresaId; infoEmpresa(); location.hash = '#/notas';
  }));
}

// ---------------------------------------------------------------------------
// Emitir nota
// ---------------------------------------------------------------------------

async function telaEmitir(param) {
  // #/emitir/ID corrige uma nota recusada; #/emitir/clonar-ID emite uma nota nova a partir de outra já emitida
  const clonarId = /^clonar-(\d+)$/.exec(param ?? '')?.[1];
  const orcP = /^orc-(\d+):(\d*):([\d.]*)$/.exec(param ?? '');
  const notaIdCorrecao = clonarId || orcP ? null : param;
  const origem = clonarId ? await api('GET', `/api/notas/${clonarId}`) : null;
  if (origem && origem.empresa_id !== estado.empresaId && estado.empresas.some((x) => x.id === origem.empresa_id)) {
    estado.empresaId = origem.empresa_id;
    try { localStorage.setItem('empresaId', estado.empresaId); } catch { /* ok */ }
    $('#empresa-atual').value = estado.empresaId; infoEmpresa();
  }
  const e = empresa();
  const [tomadores, servicos, tiposResp] = await Promise.all([
    api('GET', `/api/empresas/${e.id}/tomadores`),
    api('GET', `/api/empresas/${e.id}/servicos`),
    api('GET', `/api/empresas/${e.id}/tributacao/tipos`).catch(() => ({ tipos: [] })),
  ]);
  const tiposSaida = (tiposResp.tipos ?? []).filter((t) => t.sentido === 'SAIDA');
  const corrigindo = notaIdCorrecao ? await api('GET', `/api/notas/${notaIdCorrecao}`) : null;
  // #/emitir/orc-ID:ITEM:VALOR emite a nota de um orçamento (item e valor em branco = soma dos itens, pelo saldo)
  const orc = orcP ? await api('GET', `/api/empresas/${e.id}/orcamentos/${orcP[1]}/conversao?${new URLSearchParams({ ...(orcP[2] ? { item: orcP[2] } : {}), ...(orcP[3] ? { valor: orcP[3] } : {}) })}`) : null;
  let p = corrigindo?.payload ?? {};
  if (orc) p = { tomadorId: orc.tomadorId, servicoId: orc.servicoId, descricao: orc.descricao, valor: orc.valor.toFixed(2).replace('.', ','), competencia: hoje() };
  if (origem) {
    // nota importada do portal (ou antiga) não guarda o formulário original: completa com o que está no registro
    p = { tomadorId: origem.tomador_id, descricao: origem.descricao, valor: String(origem.valor_servico).replace('.', ','), ...(origem.payload?.importadoDoPortal ? {} : origem.payload) };
    p.competencia = hoje();
  }

  conteudo.innerHTML = `
    <div class="topo"><div>
      <h1>${corrigindo ? `Corrigir e reenviar DPS nº ${corrigindo.n_dps}` : orc ? `Emitir nota do orçamento nº ${orc.numero}` : origem ? 'Emitir nota a partir de outra' : 'Emitir nota'}</h1>
      <p class="sutil">${esc(e.razao_social)} — ${fmtDoc(e.documento)}</p>
    </div></div>
    ${orc ? `<div class="banner">Orçamento nº ${orc.numero} de <strong>${esc(orc.cliente ?? '')}</strong>: valor desta nota ${brl(orc.valor)} (ainda falta faturar até ${brl(orc.maximo)}). Confira o cliente, o serviço e a tributação antes de emitir. ${orc.tomadorId ? '' : '<strong>Este orçamento não tem cliente cadastrado: escolha ou cadastre o cliente abaixo.</strong>'}</div>` : ''}
    ${origem ? `<div class="banner">Copiado da ${origem.n_nfse ? `NFS-e nº ${origem.n_nfse}` : `DPS ${origem.serie}/${origem.n_dps}`} (${esc(origem.tomador_nome ?? 'sem tomador')}, ${brl(origem.valor_servico)}). Isto emite uma <strong>nota nova</strong>, com outro número: confira a competência, o valor e a descrição antes de emitir. <a href="#/nota/${origem.id}">Voltar para a nota</a></div>` : ''}
    ${e.ambiente === 2 ? '<div class="banner teste">Esta empresa está em produção restrita: as notas são de teste e não têm valor fiscal.</div>' : ''}
    ${e.modo_emissao === 'PORTAL' ? '<div class="banner teste">Esta empresa emite as notas pelo portal do Emissor Nacional (sem certificado). Aqui você gera o <strong>boleto</strong>; a nota é emitida no portal e importada em <a href="#/notas">Notas emitidas</a>.</div>' : !e.tem_certificado ? '<div class="banner teste">Cadastre o certificado A1 da empresa antes de emitir.</div>' : ''}
    <form id="form-emitir">
      <fieldset><legend>Tomador</legend>
        <div class="grade">
          <label class="largo">Quem contratou o serviço <span class="dica">(digite para buscar · F2 abre a consulta completa)</span>
            <select name="tomadorId">
              <option value="">Consumidor não identificado</option>
              ${tomadores.map((t) => `<option value="${t.id}" ${p.tomadorId === t.id ? 'selected' : ''}>${esc(t.nome)} ${t.documento ? '— ' + fmtDoc(t.documento) : ''}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="acoes"><button type="button" id="novo-tomador">Cadastrar novo cliente</button></div>
      </fieldset>

      <div id="serv-padrao" class="banner" hidden></div>
      <div id="aviso-desconto" class="banner teste" hidden></div>
      <fieldset id="bloco-cobranca" hidden><legend>O que emitir</legend>
        <div class="grade">
          <label class="largo">Ação
            <select name="acao"><option value="NOTA">Somente a nota fiscal</option><option value="NOTA_BOLETO">Nota fiscal + cobrança (boleto ou Pix)</option><option value="BOLETO">Somente a cobrança</option></select>
            <span class="dica" id="dica-acao"></span></label>
        </div>
      </fieldset>

      <fieldset id="bloco-composta" hidden><legend>Descrição composta do cliente</legend>
        <div class="grade" id="comp-campos"></div>
        <p class="dica" id="comp-info"></p>
      </fieldset>

      <fieldset><legend>Serviço</legend>
        <div class="grade">
          <label class="largo">Serviço cadastrado
            <select name="servicoId">
              <option value="">Informar manualmente</option>
              ${servicos.map((s) => `<option value="${s.id}" ${p.servicoId === s.id ? 'selected' : ''}>${esc(s.nome)} (${s.c_trib_nac})</option>`).join('')}
            </select>
          </label>
          <label class="largo">Tributação
            <select name="tipoDocumentoId"><option value="">Padrão / do serviço</option>
              ${tiposSaida.map((t) => `<option value="${t.id}" ${p.tipoDocumentoId === t.id ? 'selected' : ''}>${esc(t.nome)}${t.padrao ? ' (padrão)' : ''}</option>`).join('')}
            </select>
            <span class="dica">Ao escolher, alíquota, retenções, ISSQN e demais dados tributários vêm da tributação; ainda dá para ajustar abaixo.</span></label>
          <label class="largo">Descrição que sai na nota <textarea name="descricao" required maxlength="2000">${esc(p.descricao ?? '')}</textarea></label>
          <label>Competência <input type="date" name="competencia" required value="${p.competencia ?? hoje()}"></label>
          <label>Valor do serviço (R$) <input name="valor" data-num required inputmode="decimal" value="${p.valor ?? ''}"></label>
          <label>Código de tributação nacional <input name="cTribNac" maxlength="8" placeholder="Ex.: 171901" value="${esc(p.cTribNac ?? '')}">
            <span class="dica">Fica em branco para usar o do serviço cadastrado</span></label>
          <label>Município da prestação (IBGE) <input name="municipioPrestacao" maxlength="7" placeholder="${e.cod_municipio}" value="${esc(p.municipioPrestacao ?? '')}"></label>
        </div>
      </fieldset>

      <fieldset><legend>Tributação</legend>
        <div class="grade">
          <label>ISSQN
            <select name="tribISSQN">
              <option value="1">Operação tributável</option><option value="2">Imunidade</option>
              <option value="3">Exportação de serviço</option><option value="4">Não incidência</option>
            </select></label>
          <label>Retenção do ISSQN
            <select name="issRetido"><option value="1">Não retido</option><option value="2">Retido pelo tomador</option><option value="3">Retido pelo intermediário</option></select></label>
          <label>Alíquota ISSQN (%) <input name="aliquota" data-num inputmode="decimal" value="${p.aliquota ?? ''}">
            <span class="dica">Simples ME/EPP: alíquota do Anexo. MEI e não optantes: deixe em branco.</span></label>
          <label>Desconto incondicionado (R$) <input name="descontoIncondicionado" data-num inputmode="decimal" value="${p.descontoIncondicionado ?? ''}"></label>
          <fieldset class="largo retencoes"><legend>Retenções federais</legend>
            <p class="dica">Preencha só o que o tomador vai reter. Use o botão para sugerir as alíquotas usuais (PIS 0,65% · COFINS 3% · CSLL 1% · IRRF 1,5%) e ajuste se o caso for outro; retenções abaixo de R$ 10,00 normalmente são dispensadas.</p>
            <p class="dica" id="aviso-dispensa" hidden style="color:var(--laranja)"></p>
            <div class="grade">
              <label>PIS (%) <input name="pPis" data-num inputmode="decimal" value="${p.retencoes?.pPis ?? ''}"></label>
              <label>PIS retido (R$) <input name="pis" data-num inputmode="decimal" value="${p.retencoes?.pis ?? ''}"></label>
              <label>COFINS (%) <input name="pCofins" data-num inputmode="decimal" value="${p.retencoes?.pCofins ?? ''}"></label>
              <label>COFINS retida (R$) <input name="cofins" data-num inputmode="decimal" value="${p.retencoes?.cofins ?? ''}"></label>
              <label>CSLL (%) <input name="pCsll" data-num inputmode="decimal"></label>
              <label>CSLL retida (R$) <input name="csll" data-num inputmode="decimal" value="${p.retencoes?.csll ?? ''}"></label>
              <label>IRRF (%) <input name="pIrrf" data-num inputmode="decimal"></label>
              <label>IRRF retido (R$) <input name="irrf" data-num inputmode="decimal" value="${p.retencoes?.irrf ?? ''}"></label>
              <label>INSS / CP retido (R$) <input name="cp" data-num inputmode="decimal" value="${p.retencoes?.cp ?? ''}"></label>
              <label><span>&nbsp;</span><button type="button" id="ret-padrao">Sugerir retenções usuais</button></label>
            </div>
          </fieldset>
          ${empresa()?.op_simp_nac === 1 ? `<fieldset class="largo"><legend>Totais aproximados de tributos (Lei 12.741)</legend>
            <p class="dica">Obrigatório informar para empresa não optante do Simples. Use os percentuais do seu serviço (ex.: Federais 11,33 e Municipais 3,00).</p>
            <div class="grade">
              <label>Federais (%) <input name="tFed" data-num inputmode="decimal" value="${p.pTotTrib?.fed ?? ''}"></label>
              <label>Estaduais (%) <input name="tEst" data-num inputmode="decimal" value="${p.pTotTrib?.est ?? ''}"></label>
              <label>Municipais (%) <input name="tMun" data-num inputmode="decimal" value="${p.pTotTrib?.mun ?? ''}"></label>
            </div></fieldset>` : ''}
          ${empresa()?.ambiente === 1 && estado.usuario.papel !== 'cliente' ? '<label class="largo"><span><input type="checkbox" name="enviarEmail"> Enviar por e-mail ao cliente quando a nota for autorizada</span><span class="dica">Usa o e-mail do cadastro do cliente (e os de cobrança). Configure o servidor em E-mail.</span></label>' : ''}
          <label class="largo">Informações complementares <textarea name="infoComplementar" maxlength="2000">${esc(p.infoComplementar ?? '')}</textarea></label>
        </div>
      </fieldset>

      <fieldset id="bloco-pagamento" hidden><legend>Pagamento / parcelamento</legend>
        <p class="dica">O valor do boleto parte do líquido da NFS-e (serviço menos descontos e retenções), já calculado acima.</p>
        <div class="grade">
          <label data-boleto>Vencimento do boleto <input type="date" name="vencimento"></label>
          <label data-boleto>Valor do boleto (R$) <input name="valorBoleto" data-num inputmode="decimal" placeholder="Valor líquido da nota"><span class="dica">Preenchido sozinho com o líquido da nota (serviço menos descontos e retenções). Você pode alterar; apague o campo para voltar ao automático.</span><span class="dica" id="dica-boleto-desc"></span></label>
          <label data-boleto>Parcelas <input type="number" name="nParcelas" min="1" max="24" value="1"><span class="dica">Mais de 1: um boleto por parcela, cada um com o seu vencimento (editável abaixo).</span></label>
          <label data-boleto>Dias entre parcelas <input type="number" name="diasEntre" min="1" max="365" placeholder="mensal"><span class="dica">Em branco: mesmo dia de cada mês. Ou informe, por exemplo, 15 ou 30 dias entre uma parcela e outra.</span></label>
          <label data-boleto>Condição de pagamento <input name="condicao" placeholder="Ex.: 30/60/90" maxlength="60"><span class="dica">Dias após hoje para cada parcela. Preenchida, define o número de parcelas e os vencimentos.</span></label>
          <div data-boleto class="largo" id="lista-parcelas" hidden></div>
        </div>
      </fieldset>
      <p class="erro" id="erro-emitir" role="alert"></p>
      <fieldset id="bloco-conferencia"><legend>Conferência da tributação</legend>
        <div class="rolagem" id="conferencia"></div>
      </fieldset>
      <div class="acoes"><button class="primario" type="submit" id="btn-emitir">${corrigindo ? 'Reenviar à Sefin' : 'Emitir nota'}</button></div>
    </form>`;

  const f = $('#form-emitir');
  const portal = e.modo_emissao === 'PORTAL';
  if (!e.tem_certificado && !portal) f.querySelector('[type=submit]').disabled = true;
  if (portal) f.acao.querySelectorAll('option:not([value=BOLETO])').forEach((o) => o.remove());
  if (p.tribISSQN) f.tribISSQN.value = p.tribISSQN;
  if (p.issRetido) f.issRetido.value = p.issRetido;

  let pCpServico = null, tpImunidadeServico = null, modeloComposto = null, tCompor = null, ultimoEfetivo = null, parcelasManual = false;
  let dispensa = { pcc: null, irrf: null };
  f.servicoId.onchange = () => {
    const s = servicos.find((x) => x.id === Number(f.servicoId.value));
    if (!s) return;
    f.descricao.value = s.descricao;
    if (s.aliquota != null) f.aliquota.value = s.aliquota;
    if (s.valor_padrao) f.valor.value = s.valor_padrao;
    f.cTribNac.value = '';
    // o serviço aponta para uma tributação
    const tid = s.tipo_documento_id ?? tiposSaida.find((t) => t.padrao)?.id ?? '';
    f.tipoDocumentoId.value = String(tid);
    aplicarTipo();
    if (modeloComposto && !f.tipoDocumentoId.value) aplicarComposta();
  };
  const fmt = (n) => (n == null ? '' : String(n).replace('.', ','));
  async function aplicarTipo() {
    const tid = f.tipoDocumentoId.value;
    if (!tid) { pCpServico = null; tpImunidadeServico = null; ultimoEfetivo = null; renderConferencia(); return; }
    try {
      const t = await api('GET', `/api/empresas/${e.id}/tributacao/tipos/${tid}/efetiva?data=${f.competencia.value || hoje()}`);
      ultimoEfetivo = t;
      if (t.aliquota != null) f.aliquota.value = fmt(t.aliquota);
      f.tribISSQN.value = String(t.tribISSQN ?? 1);
      f.issRetido.value = String(t.issRetido ?? 1);
      for (const k of ['pPis', 'pCofins', 'pCsll', 'pIrrf']) f.elements[k].value = fmt(t[k]);
      f.municipioPrestacao.value = t.municipioPrestacao ?? '';
      if (t.infoComplementar) f.infoComplementar.value = t.infoComplementar;
      if (f.tFed) { f.tFed.value = fmt(t.pTotTrib?.fed); f.tEst.value = fmt(t.pTotTrib?.est); f.tMun.value = fmt(t.pTotTrib?.mun); }
      pCpServico = t.pCp ?? null; tpImunidadeServico = t.tpImunidade ?? null;
      recalcular();
      sugerirBoleto?.();
      renderConferencia();
      if (modeloComposto) aplicarComposta();
    } catch (err) { $('#erro-emitir').textContent = mensagemErro(err); }
  }
  f.tipoDocumentoId.onchange = aplicarTipo;
  f.competencia.addEventListener('change', () => f.tipoDocumentoId.value && aplicarTipo());
  // descrição composta: o cliente pode ter um modelo (período, ordem de compra, linhas de valor e INSS só sobre algumas)
  const modeloDe = (t) => { try { const m = t?.descricao_modelo ? JSON.parse(t.descricao_modelo) : null; return m?.ativo ? m : null; } catch { return null; } };
  function prepararComposta() {
    const t = tomadores.find((x) => x.id === Number(f.tomadorId.value));
    modeloComposto = modeloDe(t);
    $('#bloco-composta').hidden = !modeloComposto;
    f.descricao.readOnly = !!modeloComposto;
    if (!modeloComposto) { $('#comp-campos').innerHTML = ''; return; }
    const m = modeloComposto, ant = lerForm(f);
    $('#comp-campos').innerHTML =
      (m.periodo ? `<label>Período inicial <input type="date" name="comp_ini" value="${esc(ant.comp_ini ?? '')}"></label><label>Período final <input type="date" name="comp_fim" value="${esc(ant.comp_fim ?? '')}"></label>` : '') +
      (m.ordem_compra ? `<label>Ordem de compra <input name="comp_oc" maxlength="60" value="${esc(ant.comp_oc ?? '')}"></label>` : '') +
      m.linhas.map((l, i) => `<label>${esc(l.rotulo)} (R$)${l.retem_cp ? ' · retém INSS' : ''} <input name="comp_v${i}" data-num inputmode="decimal"></label>`).join('');
    $('#comp-campos').querySelectorAll('input').forEach((el) => el.addEventListener('input', () => { clearTimeout(tCompor); tCompor = setTimeout(aplicarComposta, 250); }));
    aplicarComposta();
  }
  async function aplicarComposta() {
    if (!modeloComposto || !f.tomadorId.value) return;
    const x = lerForm(f);
    try {
      const r = await api('POST', `/api/tomadores/${f.tomadorId.value}/descricao`, { periodoIni: x.comp_ini || null, periodoFim: x.comp_fim || null, ordemCompra: x.comp_oc || null, valores: modeloComposto.linhas.map((_, i) => x[`comp_v${i}`] ?? 0) });
      $('#erro-emitir').textContent = '';
      f.descricao.value = r.descricao;
      f.valor.value = r.valorTotal ? String(r.valorTotal.toFixed(2)).replace('.', ',') : '';
      pCpServico = null;
      recalcular();
      f.elements.cp.value = r.cp ? r.cp.toFixed(2).replace('.', ',') : '';
      $('#comp-info').textContent = `Total ${brl(r.valorTotal)} · INSS ${String(r.cpPct).replace('.', ',')}% sobre ${brl(r.baseCp)} = ${brl(r.cp)}.`;
      sugerirBoleto?.();
    } catch (err) { $('#erro-emitir').textContent = mensagemErro(err); }
  }
  f.tomadorId.addEventListener('change', () => setTimeout(prepararComposta, 0));
  // ---- parcelamento do boleto: uma linha por parcela (data + valor), geradas a partir do vencimento e do valor do boleto
  const addMes = (iso, k) => {
    const [a, m, d] = iso.split('-').map(Number);
    const alvo = new Date(Date.UTC(a, m - 1 + k, 1)), ult = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth(), Math.min(d, ult))).toISOString().slice(0, 10);
  };
  const nParcelas = () => Math.max(1, Math.min(24, Number(f.nParcelas?.value) || 1));
  function desenharParcelas(regerar = true) {
    const box = $('#lista-parcelas');
    if (!box || !f.nParcelas) return;
    // condição "30/60/90": dias após hoje, um por parcela; define sozinha a quantidade e o primeiro vencimento
    const cond = (f.condicao.value.match(/^\s*\d{1,3}(\s*[\/;,-]\s*\d{1,3}){0,23}\s*$/) ? f.condicao.value.split(/[\/;,-]/).map((x) => Number(x.trim())) : null);
    const hojeIso = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    const somaDiasIso = (iso, d) => new Date(Date.parse(iso + 'T12:00:00Z') + d * 86400e3).toISOString().slice(0, 10);
    if (cond && regerar && !parcelasManual) { f.nParcelas.value = String(cond.length); f.vencimento.value = somaDiasIso(hojeIso, cond[0]); }
    const n = nParcelas(), total = lerForm(f).valorBoleto ?? 0;
    box.hidden = n < 2 || f.acao.value === 'NOTA';
    if (n < 2) { box.innerHTML = ''; return; }
    if (regerar && !parcelasManual) {
      const base = f.vencimento.value || vencPadrao(tomadores.find((x) => x.id === Number(f.tomadorId.value)));
      const dias = Number(f.diasEntre.value) || 0;
      const dataParcela = (i) => (cond && cond.length === n ? somaDiasIso(hojeIso, cond[i]) : dias ? somaDiasIso(base, dias * i) : addMes(base, i));
      const cent = Math.round(total * 100), cada = Math.floor(cent / n);
      box.innerHTML = Array.from({ length: n }, (_, i) => {
        const v = (i === n - 1 ? cent - cada * (n - 1) : cada) / 100;
        return `<div class="linha-serv"><label>Parcela ${i + 1} — vencimento <input type="date" data-pv="${i}" value="${dataParcela(i)}"></label><label>Valor (R$) <input data-pq="${i}" data-num inputmode="decimal" value="${v ? v.toFixed(2).replace('.', ',') : ''}"></label></div>`;
      }).join('') + '<p class="dica" id="soma-parcelas"></p>';
      box.querySelectorAll('input').forEach((el) => el.addEventListener('input', () => { parcelasManual = true; somarParcelas(); }));
    }
    somarParcelas();
  }
  function somarParcelas() {
    const el = $('#soma-parcelas'); if (!el) return;
    const soma = [...f.querySelectorAll('[data-pq]')].reduce((a, i) => a + (numero(i.value) ?? 0), 0), total = lerForm(f).valorBoleto ?? 0;
    const dif = Math.round((soma - total) * 100) / 100;
    el.textContent = dif === 0 ? `Soma das parcelas: ${brl(soma)} (confere com o boleto).` : `Soma das parcelas: ${brl(soma)} — ${dif > 0 ? 'excede' : 'falta'} ${brl(Math.abs(dif))} para o valor do boleto.`;
  }
  const lerParcelas = () => (nParcelas() < 2 ? null : [...f.querySelectorAll('[data-pv]')].map((el, i) => ({ vencimento: el.value, valor: numero(f.querySelector(`[data-pq="${i}"]`).value) ?? 0 })));
  f.nParcelas?.addEventListener('input', () => { f.condicao.value = ''; parcelasManual = false; desenharParcelas(); });
  f.diasEntre?.addEventListener('input', () => { f.condicao.value = ''; parcelasManual = false; desenharParcelas(); });
  f.condicao?.addEventListener('input', () => { parcelasManual = false; desenharParcelas(); });
  f.vencimento?.addEventListener('change', () => { parcelasManual = false; desenharParcelas(); });
  f.valorBoleto?.addEventListener('input', () => { parcelasManual = false; desenharParcelas(); });
  f.acao.addEventListener('change', () => desenharParcelas());
  f.addEventListener('input', (ev) => { if (['valor', 'descontoIncondicionado'].includes(ev.target.name) || ev.target.name?.startsWith('comp_')) setTimeout(() => { parcelasManual = false; desenharParcelas(); }, 0); });

  // ---- conferência: cada imposto com base, alíquota e valor, a partir do que está no formulário
  function renderConferencia() {
    const d = lerForm(f), base = Math.round(((d.valor ?? 0) - (d.descontoIncondicionado ?? 0)) * 100) / 100;
    const v = (n) => brl(Math.round((n ?? 0) * 100) / 100);
    const pct = (n) => (n || n === 0 ? String(n).replace('.', ',') + '%' : '—');
    const issRet = Number(d.issRetido) === 2 || Number(d.issRetido) === 3;
    const baseTrib = base;
    const iss = Math.round(baseTrib * (d.aliquota ?? 0)) / 100;
    const linhas = [];
    if (Number(d.tribISSQN) === 1) linhas.push(['ISS', baseTrib, d.aliquota, iss, issRet ? 'Retido pelo tomador' : 'A recolher pelo prestador']);
    else linhas.push(['ISS', base, null, 0, { 2: 'Imunidade', 3: 'Exportação', 4: 'Não incidência' }[Number(d.tribISSQN)]]);
    const ret = [['PIS', d.pPis, d.pis], ['COFINS', d.pCofins, d.cofins], ['CSLL', d.pCsll, d.csll], ['IRRF', d.pIrrf, d.irrf], ['INSS (contrib. previdenciária)', null, d.cp]];
    let retidas = 0;
    for (const [n, p, val] of ret) if (val) { linhas.push([n, base, p, val, 'Retido pelo tomador']); retidas += val; }
    const dispPcc = new Set(dispensa.pcc ? ['PIS', 'COFINS', 'CSLL'] : []), dispIrrf = dispensa.irrf ? ['IRRF'] : [];
    for (const [n, p] of ret) if ((dispPcc.has(n) || dispIrrf.includes(n)) && p) linhas.push([n, base, p, 0, 'Dispensada: retenção ≤ R$ 10,00']);
    const proprios = new Set(['ISS', 'PIS', 'COFINS', 'CSLL', 'IRRF', 'INSS']);
    for (const it of ultimoEfetivo?.itens ?? []) if (!proprios.has(it.imposto)) { const b = baseTrib * (1 - (it.reducao_base || 0) / 100); linhas.push([it.imposto.replace('_', ' '), Math.round(b * 100) / 100, it.aliquota, Math.round(b * it.aliquota) / 100, 'Informativo (IBS/CBS)']); }
    const liquido = Math.round((base - retidas - (issRet ? iss : 0)) * 100) / 100;
    const tot = [d.tFed, d.tEst, d.tMun].some((x) => x) ? `<tr><td colspan="3">Tributos aproximados (fed ${pct(d.tFed)} · est ${pct(d.tEst)} · mun ${pct(d.tMun)})</td><td class="num">${v(base * ((d.tFed ?? 0) + (d.tEst ?? 0) + (d.tMun ?? 0)) / 100)}</td><td>Lei 12.741</td></tr>` : '';
    $('#conferencia').innerHTML = base > 0
      ? `<table class="tabela"><thead><tr><th>Imposto</th><th class="num">Base</th><th class="num">Alíquota</th><th class="num">Valor</th><th>Situação</th></tr></thead><tbody>
        ${linhas.map(([n, b, p, val, sit]) => `<tr><td>${esc(n)}</td><td class="num">${v(b)}</td><td class="num">${pct(p)}</td><td class="num">${v(val)}</td><td>${esc(sit)}</td></tr>`).join('')}${tot}
        <tr><td colspan="3"><strong>Retenções (federais${issRet ? ' + ISS' : ''})</strong></td><td class="num"><strong>${v(retidas + (issRet ? iss : 0))}</strong></td><td></td></tr>
        <tr><td colspan="3"><strong>Líquido a receber</strong> (${v(d.valor ?? 0)}${d.descontoIncondicionado ? ` − desconto ${v(d.descontoIncondicionado)}` : ''} − retenções)</td><td class="num"><strong>${v(liquido)}</strong></td><td></td></tr></tbody></table>`
      : '<p class="sutil">Informe o valor do serviço para conferir a tributação.</p>';
  }
  f.addEventListener('input', () => setTimeout(renderConferencia, 0));
  f.addEventListener('change', () => setTimeout(renderConferencia, 0));
  renderConferencia();
  habilitarConsultaF2($('#form-emitir'), $('#form-emitir').tomadorId, tomadores);
  ligarBuscaCliente($('#form-emitir').tomadorId, tomadores);
  $('#novo-tomador').onclick = () => formTomador(null, async (id) => { telaEmitir.prefTomador = id; await telaEmitir(param); $('#form-emitir').tomadorId.value = id; });

  // regra do cliente: nota / nota + boleto / só boleto
  const somaDias = (d, n) => new Date(d.getTime() + n * 86400e3);
  const vencPadrao = (t) => {
    const base = new Date(Date.now() - 3 * 3600e3);
    if (!t || t.vencimento_tipo !== 'DIA_FIXO') return somaDias(base, t?.vencimento_valor ?? 10).toISOString().slice(0, 10);
    const ult = (a, m) => new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
    let a = base.getUTCFullYear(), m = base.getUTCMonth(), dia = Math.min(t.vencimento_valor, ult(a, m));
    if (dia <= base.getUTCDate()) { m += 1; if (m > 11) { m = 0; a += 1; } dia = Math.min(t.vencimento_valor, ult(a, m)); }
    return new Date(Date.UTC(a, m, dia)).toISOString().slice(0, 10);
  };
  const aplicarModo = () => {
    const t = tomadores.find((x) => x.id === Number(f.tomadorId.value));
    const bloco = $('#bloco-cobranca');
    bloco.hidden = !t || !!corrigindo;
    if (!t || corrigindo) { $('#bloco-pagamento').hidden = true; return; }
    const acao = f.acao.value;
    const boleto = acao !== 'NOTA';
    $('#bloco-pagamento').hidden = !boleto;
    $('#dica-acao').textContent = `Padrão do cliente: ${NOME_MODO[t.modo_faturamento] ?? 'Nota'}.`;
    // só boleto: não há dados fiscais a preencher
    f.querySelectorAll('fieldset').forEach((fs) => { if (fs.querySelector('[name=tribISSQN]') && !fs.closest('fieldset#bloco-cobranca')) fs.hidden = acao === 'BOLETO'; });
    $('#bloco-conferencia').hidden = acao === 'BOLETO';
    $('#btn-emitir').textContent = { NOTA: 'Emitir nota', NOTA_BOLETO: 'Emitir nota e boleto', BOLETO: 'Gerar boleto' }[acao];
  };
  f.tomadorId.addEventListener('change', () => {
    const t = tomadores.find((x) => x.id === Number(f.tomadorId.value));
    if (t) {
      f.acao.value = portal ? 'BOLETO' : t.modo_faturamento ?? 'NOTA';
      f.vencimento.value = vencPadrao(t);
      if (f.enviarEmail) f.enviarEmail.checked = !!t.enviar_email_auto;
    }
    aplicarModo();
  });
  f.acao.addEventListener('change', aplicarModo);
  // vencimento em dia útil: antecipa fim de semana/feriado e avisa (o servidor repete a regra)
  let feriadosLocais = '';
  api('GET', `/api/empresas/${e.id}/feriados`).then((r) => { feriadosLocais = r.feriados_extra ?? ''; }).catch(() => {});
  const avisoVenc = document.createElement('span'); avisoVenc.className = 'dica'; f.vencimento?.after(avisoVenc);
  const conferirVenc = () => {
    avisoVenc.textContent = '';
    if (!f.vencimento?.value) return;
    const r = ajustarVencimento(f.vencimento.value, feriadosLocais);
    if (r.aviso) { f.vencimento.value = r.data; avisoVenc.textContent = r.aviso; }
  };
  f.vencimento?.addEventListener('change', conferirVenc);
  f.tomadorId.addEventListener('change', () => setTimeout(conferirVenc, 0));
  // Valor do boleto: acompanha o líquido da nota (mesma conta do servidor), até o usuário digitar outro valor
  let boletoManual = false;
  const sugerirBoleto = () => {
    if (boletoManual || !f.valorBoleto) return;
    const d = lerForm(f), r = d;
    const base = (d.valor ?? 0) - (d.descontoIncondicionado ?? 0);
    const iss = Number(d.issRetido) === 2 ? Math.round(base * (d.aliquota ?? 0)) / 100 : 0;
    const ret = (r.irrf ?? 0) + (r.cp ?? 0) + (r.csll ?? 0) + (r.pis ?? 0) + (r.cofins ?? 0) + iss;
    const liquido = f.acao.value === 'BOLETO' ? (d.valor ?? 0) : Math.round((base - ret) * 100) / 100;
    f.valorBoleto.value = liquido > 0 ? liquido.toFixed(2).replace('.', ',') : '';
  };
  // serviço padrão do cliente: preenche serviço, texto e valor (nota e boleto)
  const aplicarServicoPadrao = (sp, t) => {
    const sv = servicos.find((x) => x.id === sp.servico_id);
    if (!sv) return;
    f.servicoId.value = String(sv.id);
    f.servicoId.onchange();
    if (sp.descricao) f.descricao.value = sp.descricao;
    f.valor.value = String(sp.valor).replace('.', ',');
    boletoManual = false;
    f.valor.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const mostrarServicoPadrao = () => {
    const box = $('#serv-padrao');
    const t = tomadores.find((x) => x.id === Number(f.tomadorId.value));
    const lista = (t?.servicos_padrao ?? []).filter((x) => servicos.some((sv) => sv.id === x.servico_id));
    if (!t || corrigindo || !lista.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = `<label>Serviço padrão de ${esc(t.nome)} ${lista.length > 1 ? `<select id="sel-serv-padrao">${lista.map((x, i) => `<option value="${i}">${esc(servicos.find((sv) => sv.id === x.servico_id).nome)} — ${brl(x.valor)}${x.padrao ? ' (principal)' : ''}</option>`).join('')}</select>` : `<strong>${esc(servicos.find((sv) => sv.id === lista[0].servico_id).nome)} — ${brl(lista[0].valor)}</strong>`}</label>
      <span class="dica">Já preenchido abaixo; você pode alterar o que precisar antes de emitir.</span>`;
    const sel = $('#sel-serv-padrao');
    if (sel) sel.onchange = () => aplicarServicoPadrao(lista[Number(sel.value)], t);
    aplicarServicoPadrao(lista[0], t);
  };
  f.tomadorId.addEventListener('change', mostrarServicoPadrao);
  // desconto fixo do cliente: lembrete na emissão e efeito no boleto
  const atualizarDesconto = () => {
    const t = tomadores.find((x) => x.id === Number(f.tomadorId.value));
    const box = $('#aviso-desconto'), desc = t?.desconto_valor ?? 0;
    if (!t || !desc || corrigindo) { box.hidden = true; $('#dica-boleto-desc')?.replaceChildren(); return; }
    const naNota = (lerForm(f).descontoIncondicionado ?? 0) >= desc;
    box.hidden = false;
    // só redesenha se mudou: refazer o botão durante o clique (o campo anterior dispara "change") faria o clique se perder
    const html = `<strong>Este cliente tem desconto cadastrado: ${brl(desc)}</strong> (${esc(t.desconto_motivo ?? '')}).<br>
      ${f.acao.value === 'NOTA' ? '' : 'No boleto o desconto é aplicado automaticamente. '}Na NFS-e ele <u>não</u> é aplicado sozinho: ${naNota ? 'já está lançado como desconto incondicionado nesta nota.' : 'se o desconto também vale para a nota, use o botão abaixo.'}
      ${naNota ? '' : '<br><button type="button" id="aplicar-desc-nota">Lançar como desconto na nota</button>'}`;
    if (box.dataset.html !== html) {
      box.innerHTML = html; box.dataset.html = html;
      const b = $('#aplicar-desc-nota');
      if (b) b.onclick = () => { f.descontoIncondicionado.value = String(desc).replace('.', ','); f.descontoIncondicionado.dispatchEvent(new Event('input', { bubbles: true })); };
    }
    const dica = $('#dica-boleto-desc');
    if (dica) {
      const bruto = numero(f.valorBoleto.value) ?? 0;
      dica.textContent = naNota ? 'O desconto do cliente já está na nota, então não é abatido de novo.' : bruto > desc ? `Desconto do cliente: − ${brl(desc)} (${t.desconto_motivo}) → boleto de ${brl(bruto - desc)}.` : '';
    }
  };
  f.addEventListener('input', atualizarDesconto); f.addEventListener('change', atualizarDesconto);
  f.valorBoleto?.addEventListener('input', () => { boletoManual = f.valorBoleto.value.trim() !== ''; if (!boletoManual) sugerirBoleto(); });
  f.addEventListener('input', (ev) => { if (ev.target !== f.valorBoleto) sugerirBoleto(); });
  f.addEventListener('change', (ev) => { if (ev.target !== f.valorBoleto) sugerirBoleto(); });
  if (f.tomadorId.value) f.tomadorId.dispatchEvent(new Event('change'));

  function recalcular() {
    const base = (lerForm(f).valor ?? 0) - (lerForm(f).descontoIncondicionado ?? 0);
    if (pCpServico != null) f.elements.cp.value = pCpServico ? (Math.round(base * pCpServico) / 100).toFixed(2).replace('.', ',') : '';
    const preencher = (aliq, campo) => {
      const pc = lerForm(f)[aliq];
      f.elements[campo].value = pc ? (Math.round(base * pc) / 100).toFixed(2).replace('.', ',') : '';
    };
    preencher('pPis', 'pis'); preencher('pCofins', 'cofins'); preencher('pCsll', 'csll'); preencher('pIrrf', 'irrf');
    // retenção de até R$ 10,00 é dispensada (PCC somado: Lei 10.833/2003, art. 31, § 3º; IRRF: Lei 9.430/1996, art. 67) e não acumula
    const val = (k) => numero(f.elements[k].value) ?? 0;
    dispensa = { pcc: null, irrf: null };
    const pcc = Math.round((val('pis') + val('cofins') + val('csll')) * 100) / 100;
    if (pcc > 0 && pcc <= 10) { dispensa.pcc = pcc; for (const k of ['pis', 'cofins', 'csll']) f.elements[k].value = ''; }
    if (val('irrf') > 0 && val('irrf') <= 10) { dispensa.irrf = val('irrf'); f.elements.irrf.value = ''; }
    const av = $('#aviso-dispensa');
    av.hidden = !dispensa.pcc && !dispensa.irrf;
    av.textContent = [dispensa.pcc ? `PIS + COFINS + CSLL somam ${brl(dispensa.pcc)}` : '', dispensa.irrf ? `IRRF é ${brl(dispensa.irrf)}` : ''].filter(Boolean).join(' e ') + ': retenção dispensada (valor igual ou inferior a R$ 10,00, a cada pagamento; não se acumula com pagamentos seguintes). Para reter mesmo assim, digite o valor retido.';
  }
  // com percentuais preenchidos, os valores retidos acompanham o valor do serviço
  ['valor', 'descontoIncondicionado'].forEach((n) => f.elements[n].addEventListener('input', () => {
    if (['pPis', 'pCofins', 'pCsll', 'pIrrf'].some((k) => lerForm(f)[k]) || pCpServico) recalcular();
  }));
  ['pPis', 'pCofins', 'pCsll', 'pIrrf'].forEach((n) => f.elements[n].addEventListener('input', recalcular));
  $('#ret-padrao').onclick = () => {
    const pad = { pPis: '0,65', pCofins: '3,00', pCsll: '1,00', pIrrf: '1,50' };
    for (const k in pad) f.elements[k].value = pad[k];
    recalcular();
  };
  if (orc?.servicoId) { f.servicoId.value = String(orc.servicoId); f.servicoId.onchange(); f.descricao.value = orc.descricao; f.valor.value = p.valor; }
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    if (portal && !f.tomadorId.value) { $('#erro-emitir').textContent = 'Escolha o cliente para gerar o boleto.'; return; }
    const d = lerForm(f);
    const corpo = {
      empresaId: e.id,
      tomadorId: d.tomadorId ? Number(d.tomadorId) : null,
      servicoId: d.servicoId ? Number(d.servicoId) : null,
      tipoDocumentoId: d.tipoDocumentoId ? Number(d.tipoDocumentoId) : null,
      competencia: d.competencia, descricao: d.descricao, valor: d.valor,
      descontoIncondicionado: d.descontoIncondicionado, cTribNac: d.cTribNac, municipioPrestacao: d.municipioPrestacao,
      aliquota: d.aliquota, tribISSQN: Number(d.tribISSQN), issRetido: Number(d.issRetido), tpImunidade: Number(d.tribISSQN) === 2 ? tpImunidadeServico : null,
      retencoes: { irrf: d.irrf, cp: d.cp, csll: d.csll, pis: d.pis, cofins: d.cofins, pPis: d.pPis, pCofins: d.pCofins }, infoComplementar: d.infoComplementar,
      pTotTrib: empresa()?.op_simp_nac === 1 ? { fed: d.tFed, est: d.tEst, mun: d.tMun } : undefined,
      ...(orc ? { orcamentoId: orc.orcamentoId, orcamentoItemId: orc.itemId } : {}),
    };
    const botao = f.querySelector('[type=submit]');
    botao.disabled = true; botao.textContent = 'Enviando à Sefin…';
    try {
      if (corrigindo) {
        const nota = await api('POST', `/api/notas/${corrigindo.id}/reenviar`, corpo);
        aviso(nota.status === 'AUTORIZADA' ? `NFS-e nº ${nota.n_nfse} autorizada.` : `A nota ficou ${STATUS[nota.status].toLowerCase()}. Veja o motivo.`);
        location.hash = `#/nota/${nota.id}`;
        return;
      }
      // um comando: nota → boleto → e-mail, conforme o cadastro do cliente
      const r = await api('POST', '/api/faturar', {
        ...corpo,
        acao: corpo.tomadorId ? d.acao : 'NOTA',
        vencimento: d.vencimento || null,
        valorBoleto: d.valorBoleto || null,
        parcelas: d.acao !== 'NOTA' ? lerParcelas() : null,
        enviarEmail: f.enviarEmail ? !!f.enviarEmail.checked : null,
      });
      const partes = [];
      if (r.nota) partes.push(r.nota.status === 'AUTORIZADA' ? `NFS-e nº ${r.nota.n_nfse} autorizada` : `a nota ficou ${STATUS[r.nota.status].toLowerCase()}`);
      if (r.cobranca) partes.push(`boleto de ${brl(r.cobranca.valor)} registrado (venc. ${dataBr(r.cobranca.vencimento)})`);
      if (r.email?.status === 'ENVIADO') partes.push(`e-mail enviado para ${r.email.para}`);
      if (r.email?.status === 'ERRO') partes.push(`e-mail não enviado: ${r.email.erro}`);
      aviso(partes.join(' · ').replace(/^./, (c) => c.toUpperCase()) + '.');
      location.hash = r.nota ? `#/nota/${r.nota.id}` : '#/cobrancas';
    } catch (err) {
      $('#erro-emitir').textContent = mensagemErro(err);
      botao.disabled = false; aplicarModo(); if (!botao.textContent || botao.textContent.endsWith('…')) botao.textContent = corrigindo ? 'Reenviar à Sefin' : 'Emitir nota';
      atualizarLicenca();
    }
  };
}

// ---------------------------------------------------------------------------
// Cobranças (boleto por convênio com remessa e retorno): boleto em PDF, remessa CNAB e retorno
// ---------------------------------------------------------------------------
const STATUS_COBRANCA = {
  AGUARDANDO_BANCO: 'Pendente (sem boleto)', A_REMETER: 'Boleto pronto', REMETIDO: 'Enviado ao banco', REGISTRADO: 'Registrado no banco',
  REJEITADO: 'Rejeitado pelo banco', PAGO: 'Pago', CANCELADO: 'Cancelado',
};
const STATUS_PIX = { AGUARDANDO_BANCO: 'Falta o Pix copia e cola', REGISTRADO: 'Pix pronto, a receber', PAGO: 'Pago', CANCELADO: 'Cancelado' };
const situacaoCobranca = (c) => (c.forma === 'PIX' ? STATUS_PIX[c.status] : STATUS_COBRANCA[c.status]) ?? c.status;
/** Cola o Pix copia e cola de uma cobrança da carteira Pix: confere o código e o valor e mostra o QR Code. */
function informarPixDialogo(c, aoSalvar) {
  abrirDialogo(`<form id="form-pix"><h2>Pix da cobrança — ${esc(c.tomador_nome)}</h2>
    <p class="sutil">${brl(c.valor)} · vencimento ${dataBr(c.vencimento)} · ${esc((c.descricao ?? '').slice(0, 80))}</p>
    <ol class="dicas"><li>No aplicativo ou internet banking do escritório, gere uma cobrança Pix (QR Code) de <strong>${brl(c.valor)}</strong>.</li>
      <li>Copie o código <em>Pix copia e cola</em> e cole abaixo.</li></ol>
    <label>Pix copia e cola <textarea name="codigo" rows="4" required spellcheck="false" style="font-family:ui-monospace,Consolas,monospace;font-size:.82rem">${esc(c.pix_copia_cola ?? '')}</textarea></label>
    <p class="erro" id="erro-pix"></p>
    <div class="acoes"><button class="primario" type="submit">Conferir e salvar</button><button type="button" id="pix-gerar">Gerar com a chave Pix da empresa</button><button type="button" data-fechar>Cancelar</button></div></form>`, (d) => {
    const f = $('#form-pix');
    $('#pix-gerar').onclick = async () => {
      try { await api('POST', `/api/cobrancas/${c.id}/pix/gerar`); d.close(); aviso('Pix gerado com a chave da empresa. O demonstrativo com o QR Code já pode ser enviado.'); aoSalvar?.(); }
      catch (e) { $('#erro-pix').textContent = mensagemErro(e); }
    };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const b = f.querySelector('[type=submit]'); b.disabled = true; b.textContent = 'Conferindo…';
      try {
        const r = await api('POST', `/api/cobrancas/${c.id}/pix`, { codigo: f.codigo.value });
        const p = r.pix_lido ?? {};
        d.close();
        aviso(`Pix conferido${p.recebedor ? `: recebedor ${p.recebedor}` : ''}${p.valor != null ? `, ${brl(p.valor)}` : ' (sem valor fixo no código)'}. O demonstrativo com o QR Code já pode ser enviado.`);
        aoSalvar?.();
      } catch (e) { $('#erro-pix').textContent = mensagemErro(e); b.disabled = false; b.textContent = 'Conferir e salvar'; }
    };
  });
}

/** Pix de uma cobrança: QR Code na tela, copiar o copia e cola e baixar a imagem do QR Code. */
function pixDaCobranca(c) {
  const nome = `Pix_${String(c.tomador_nome ?? 'cobranca').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${c.vencimento}.png`;
  abrirDialogo(`<h2>Pix — ${esc(c.tomador_nome)}</h2>
    <p class="sutil">${brl(c.valor)} · vencimento ${dataBr(c.vencimento)}</p>
    <div class="pix-qr"><img id="pix-qr-img" alt="QR Code do Pix"></div>
    <label>Pix copia e cola <textarea rows="4" readonly id="pix-codigo" spellcheck="false" style="font-family:ui-monospace,Consolas,monospace;font-size:.8rem">${esc(c.pix_copia_cola)}</textarea></label>
    <div class="acoes"><button class="primario" id="pix-baixar">Baixar QR Code (PNG)</button><button id="pix-copiar">Copiar código</button><button data-fechar>Fechar</button></div>`, () => {
    baixarImagem(`/api/cobrancas/${c.id}/qrcode`, $('#pix-qr-img'));
    $('#pix-baixar').onclick = () => baixar(`/api/cobrancas/${c.id}/qrcode`, nome);
    $('#pix-copiar').onclick = async () => { try { await navigator.clipboard.writeText(c.pix_copia_cola); aviso('Pix copia e cola copiado.'); } catch { $('#pix-codigo').select(); aviso('Selecione o código e copie com Ctrl+C.'); } };
  });
}

async function telaCobrancas() {
  const [lista, remessas, conta, cora] = await Promise.all([
    api('GET', `/api/empresas/${estado.empresaId}/cobrancas`),
    api('GET', `/api/empresas/${estado.empresaId}/remessas`),
    api('GET', `/api/empresas/${estado.empresaId}/conta-bancaria`),
    api('GET', `/api/empresas/${estado.empresaId}/cora`).catch(() => null),
  ]);
  const coraAtiva = !!cora?.ativa;
  const podeEditar = estado.usuario.papel !== 'cliente';
  const st = telaCobrancas.estado ??= { carteira: 'BOLETO' };
  const daCarteira = (k) => lista.filter((c) => (c.forma ?? 'BOLETO') === k);
  const abertoDe = (l) => l.filter((c) => !['CANCELADO', 'PAGO', 'REJEITADO'].includes(c.status)).reduce((a, c) => a + c.valor, 0);
  const vis = daCarteira(st.carteira);
  const pix = st.carteira === 'PIX';
  const faltaPix = daCarteira('PIX').filter((c) => c.status === 'AGUARDANDO_BANCO').length;
  const aberto = abertoDe(vis);
  const aRemeter = lista.filter((c) => c.status === 'A_REMETER' || c.baixa_pendente === 1).length;
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const ativo = (c) => !['PAGO', 'CANCELADO'].includes(c.status);
  const acoes = (c) => {
    const pronto = c.forma === 'PIX' ? c.pix_copia_cola : c.nosso_numero;
    const principais = [
      c.forma === 'PIX' && podeEditar && ativo(c) && !c.pix_copia_cola ? `<button data-pix="${c.id}" class="primario">Informar Pix</button>` : '',
      c.forma === 'PIX' && c.pix_copia_cola && c.status !== 'CANCELADO' ? `<button data-pixqr="${c.id}" title="QR Code e Pix copia e cola: copiar ou baixar a imagem">Pix</button>` : '',
      pronto && c.status !== 'CANCELADO' ? `<button data-demo="${c.id}">Demonstrativo</button>` : '',
      c.nosso_numero ? `<button data-boleto="${c.id}">Boleto</button>` : '',
      podeEditar && ativo(c) && pronto ? `<button data-email="${c.id}">E-mail</button>` : '',
      ativo(c) ? `<button data-wa="${c.id}">WhatsApp</button>` : '',
    ].join('');
    const mais = [
      c.forma === 'PIX' && podeEditar && ativo(c) && c.pix_copia_cola ? `<button data-pix="${c.id}">Trocar o Pix</button>` : '',
      ativo(c) && c.vencimento < hoje ? `<button data-carta="${c.id}">Carta de cobrança (PDF)</button>` : '',
      podeEditar ? `<button data-reemitir="${c.id}">Reemitir</button>` : '',
      podeEditar && ativo(c) ? `<button data-pago="${c.id}">Marcar pago</button><button data-cancelar="${c.id}">Cancelar</button>` : '',
    ].join('');
    return `<div class="cob-acoes">${principais}${mais ? `<details class="cob-mais"><summary title="Mais ações">⋯</summary><div class="cob-menu">${mais}</div></details>` : ''}</div>`;
  };
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Cobranças</h1><p class="sutil">${lista.length} registros · ${brl(abertoDe(lista))} em aberto</p></div>
      ${podeEditar ? `<div class="acoes">${coraAtiva ? '<button id="cora-atualizar" class="primario" title="Registra boletos pendentes, dá baixa nos pagos e traz o extrato da Cora">Atualizar da Cora</button>' : ''}${pix || (coraAtiva && !aRemeter) ? '' : `<button id="gerar-remessa" class="primario" ${conta && aRemeter ? '' : 'disabled'}>Gerar remessa${aRemeter ? ` (${aRemeter})` : ''}</button>`}
        <button id="novo-boleto" class="primario">Nova cobrança</button>
        <button id="modelo-wa">Mensagem do WhatsApp</button>
        <button id="cfg-demo" title="Texto do rodapé do demonstrativo de cobrança">Demonstrativo</button>
        ${pix ? '' : `<button id="ler-retorno" ${conta ? '' : 'disabled'}>Importar retorno</button><input type="file" id="arq-retorno" accept=".ret,.RET,.txt,.TXT,.rem,.REM,*/*" hidden>`}</div>` : ''}</div>
    <nav class="abas carteiras" aria-label="Carteiras de cobrança">
      <a href="#" data-carteira="BOLETO" class="${pix ? '' : 'ativo'}">Carteira boleto <span class="contagem">${daCarteira('BOLETO').length}</span></a>
      <a href="#" data-carteira="PIX" class="${pix ? 'ativo' : ''}">Carteira Pix <span class="contagem">${daCarteira('PIX').length}</span>${faltaPix ? ` <span class="selo-estado" style="--c:var(--laranja)">${faltaPix} sem Pix</span>` : ''}</a>
    </nav>
    <p class="sutil">${pix ? `Cobranças dos clientes da carteira Pix: com a chave Pix da empresa cadastrada (Empresas › Dados bancários), o Kontor gera o Pix de cada cobrança sozinho; sem ela, gere a cobrança no aplicativo do banco, clique em <strong>Informar Pix</strong> e cole o código copia e cola. O Kontor confere o código e o valor e monta o demonstrativo com o QR Code. ${brl(aberto)} em aberto.`
      : `Boletos do convênio bancário, com remessa e retorno. O demonstrativo de cobrança vai junto no e-mail. ${brl(aberto)} em aberto.`} A carteira de cada cliente fica no cadastro dele (Faturamento e cobrança).</p>
    ${coraAtiva ? `<div class="banner">Cobrança pela <strong>Cora</strong>${cora.ambiente === 'teste' ? ' (ambiente de teste)' : ''}: os boletos são registrados na Cora na hora, com Pix, e a baixa é automática (a cada 10 minutos).${cora.saldo != null ? ` Saldo na Cora: <strong>${brl(cora.saldo)}</strong>.` : ''}</div>` : ''}
    ${!pix && !conta && !coraAtiva ? `<div class="banner teste">Os dados bancários desta empresa ainda não foram informados. <a href="#/banco">Informar agora (em Empresas › Dados bancários)</a> — os boletos pendentes são gerados automaticamente depois disso.</div>` : ''}
    ${vis.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Vencimento</th><th>Cliente</th><th>Nota</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead><tbody>
      ${vis.map((c) => `<tr><td>${dataBr(c.vencimento)}${ativo(c) && c.vencimento < hoje ? ' <span class="dica erro">vencido</span>' : ''}</td>
        <td>${esc(c.tomador_nome)}<br><span class="dica">${esc((c.descricao ?? '').slice(0, 60))}</span>${c.desconto > 0 ? `<br><span class="dica">desconto de ${brl(c.desconto)}: ${esc(c.desconto_motivo ?? '')}</span>` : ''}</td>
        <td>${c.nota_id ? `<a href="#/nota/${c.nota_id}">${c.n_nfse ?? '—'}</a>` : '—'}</td><td class="num">${brl(c.valor)}</td>
        <td>${c.forma === 'PIX' && c.status === 'AGUARDANDO_BANCO' ? `<span class="cor-ambar">${situacaoCobranca(c)}</span>` : situacaoCobranca(c)}${c.baixa_pendente ? ' <span class="dica">(baixa solicitada)</span>' : ''}${c.pago_em ? `<br><span class="dica">em ${dataBr(c.pago_em)}</span>` : ''}${c.observacao_banco ? `<br><span class="dica erro">${esc(c.observacao_banco)}</span>` : ''}${c.email_status ? `<br><span class="dica ${c.email_status === 'ERRO' ? 'erro' : ''}">e-mail ${c.email_status === 'ERRO' ? 'com erro' : 'enviado'}</span>` : ''}</td>
        <td class="acoes-linha">${acoes(c)}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="vazio">${pix ? 'Nenhuma cobrança na carteira Pix. Marque “Pix copia e cola” como carteira no cadastro do cliente (Faturamento e cobrança).' : 'Nenhum boleto registrado. Escolha “Nota + cobrança” ou “Somente a cobrança” ao emitir.'}</div>`}
    ${!pix && remessas.length ? `<h2>Remessas geradas</h2><div class="rolagem"><table class="tabela"><thead><tr><th>Nº</th><th>Data</th><th>Títulos</th><th class="num">Valor</th><th></th></tr></thead><tbody>
      ${remessas.map((r) => `<tr><td>${r.numero}</td><td>${esc(r.criado_em)}</td><td>${r.qtd_titulos}</td><td class="num">${brl(r.valor_total)}</td><td><button data-remessa="${r.id}" data-nome="${esc(r.nome_arquivo)}">Baixar arquivo</button></td></tr>`).join('')}</tbody></table></div>
      <p class="dica">Envie o arquivo de remessa no internet banking do banco, na área de cobrança. Baixe lá o arquivo de retorno e importe-o aqui para dar baixa nos pagamentos.</p>` : ''}`;
  conteudo.querySelectorAll('[data-carteira]').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); st.carteira = a.dataset.carteira; telaCobrancas(); }));
  conteudo.querySelectorAll('[data-carta]').forEach((b) => (b.onclick = () => baixar(`/api/cobrancas/${b.dataset.carta}/carta`, `Carta_Cobranca_${b.dataset.carta}.pdf`, true)));
  conteudo.querySelectorAll('[data-demo]').forEach((b) => (b.onclick = () => baixar(`/api/cobrancas/${b.dataset.demo}/demonstrativo`, `Demonstrativo_${b.dataset.demo}.pdf`, true)));
  conteudo.querySelectorAll('[data-pixqr]').forEach((b) => (b.onclick = () => pixDaCobranca(lista.find((x) => x.id === Number(b.dataset.pixqr)))));
  // "⋯": o menu abre por cima da tabela (posição fixa), sem ficar cortado pela rolagem da tabela
  conteudo.querySelectorAll('details.cob-mais').forEach((dt) => dt.addEventListener('toggle', () => {
    if (!dt.open) return;
    conteudo.querySelectorAll('details.cob-mais[open]').forEach((o) => { if (o !== dt) o.open = false; });
    const m = dt.querySelector('.cob-menu'), r = dt.querySelector('summary').getBoundingClientRect();
    m.style.position = 'fixed'; m.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    const alto = m.offsetHeight;
    m.style.top = `${r.bottom + 4 + alto > window.innerHeight ? Math.max(8, r.top - 4 - alto) : r.bottom + 4}px`;
  }));
  if (!telaCobrancas.fecharMenus) {
    telaCobrancas.fecharMenus = true;
    document.addEventListener('click', (ev) => document.querySelectorAll('details.cob-mais[open]').forEach((o) => { if (!o.contains(ev.target)) o.open = false; }));
    window.addEventListener('scroll', () => document.querySelectorAll('details.cob-mais[open]').forEach((o) => (o.open = false)), true);
  }
  conteudo.querySelectorAll('[data-pix]').forEach((b) => (b.onclick = () => informarPixDialogo(lista.find((x) => x.id === Number(b.dataset.pix)), telaCobrancas)));
  conteudo.querySelectorAll('[data-email]').forEach((b) => (b.onclick = async () => {
    const c = lista.find((x) => x.id === Number(b.dataset.email));
    if (!confirm(`Enviar por e-mail ${c.forma === 'PIX' ? 'o demonstrativo com o Pix' : 'o boleto e o demonstrativo'} de ${brl(c.valor)} para ${c.tomador_nome}?`)) return;
    b.disabled = true; b.textContent = 'Enviando…';
    try { const r = await api('POST', `/api/cobrancas/${c.id}/email`, {}); aviso(`E-mail enviado para ${r.para}.`); telaCobrancas(); }
    catch (e) { aviso(mensagemErro(e)); b.disabled = false; b.textContent = 'E-mail'; }
  }));
  const ca = $('#cora-atualizar');
  if (ca) ca.onclick = async () => {
    ca.disabled = true; ca.textContent = 'Atualizando…';
    try {
      const r = await api('POST', `/api/empresas/${estado.empresaId}/cora/sincronizar`, {});
      aviso(`Cora atualizada: ${r.emitidas} boleto(s) registrado(s), ${r.baixadas} baixa(s)${r.falhas ? `, ${r.falhas} com pendência (veja a observação na cobrança)` : ''}.`);
      telaCobrancas();
    } catch (e) { aviso(mensagemErro(e)); ca.disabled = false; ca.textContent = 'Atualizar da Cora'; }
  };
  const cd = $('#cfg-demo');
  if (cd) cd.onclick = async () => {
    const r = await api('GET', `/api/empresas/${estado.empresaId}/demonstrativo`);
    abrirDialogo(`<form id="form-demo"><h2>Demonstrativo de cobrança</h2>
      <p class="sutil">O demonstrativo usa a logo, o CNPJ, o endereço, o e-mail e o WhatsApp do cadastro da empresa. Aqui você escolhe a frase do rodapé, que aparece depois do nome do escritório.</p>
      <label>Frase do rodapé <input name="rodape" maxlength="120" value="${esc(r.rodape)}" placeholder="Transformando contabilidade em decisões estratégicas"></label>
      <p class="erro" id="erro-demo"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Fechar</button></div></form>`, (d) => {
      $('#form-demo').onsubmit = async (ev) => {
        ev.preventDefault();
        try { await api('PUT', `/api/empresas/${estado.empresaId}/demonstrativo`, { rodape: ev.target.rodape.value }); d.close(); aviso('Rodapé do demonstrativo salvo.'); }
        catch (e) { $('#erro-demo').textContent = mensagemErro(e); }
      };
    });
  };
  conteudo.querySelectorAll('[data-boleto]').forEach((b) => (b.onclick = () => baixar(`/api/cobrancas/${b.dataset.boleto}/boleto`, `Boleto_${b.dataset.boleto}.pdf`, true)));
  conteudo.querySelectorAll('[data-remessa]').forEach((b) => (b.onclick = () => baixar(`/api/remessas/${b.dataset.remessa}/arquivo`, b.dataset.nome)));
  conteudo.querySelectorAll('[data-pago]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Marcar este boleto como pago hoje?')) return;
    try { await api('POST', `/api/cobrancas/${b.dataset.pago}/pagar`, {}); telaCobrancas(); } catch (e) { aviso(mensagemErro(e)); }
  }));
  conteudo.querySelectorAll('[data-cancelar]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Cancelar este boleto? Se ele já foi enviado ao banco, a baixa vai na próxima remessa.')) return;
    try { const r = await api('POST', `/api/cobrancas/${b.dataset.cancelar}/cancelar`, {}); aviso(r.baixaNoBanco ? 'Baixa solicitada: gere uma nova remessa para o banco.' : 'Boleto cancelado.'); telaCobrancas(); } catch (e) { aviso(mensagemErro(e)); }
  }));
  // ---- Novo boleto (sem nota fiscal) ----
  const nb = $('#novo-boleto');
  if (nb) nb.onclick = async () => {
    const [clientes, fer] = await Promise.all([
      api('GET', `/api/empresas/${estado.empresaId}/tomadores`),
      api('GET', `/api/empresas/${estado.empresaId}/feriados`).then((r) => r.feriados_extra).catch(() => ''),
    ]);
    const pixAuto = !!(await api('GET', `/api/empresas/${estado.empresaId}/pix-config`).catch(() => null))?.config?.ativo;
    if (!clientes.length) { aviso('Cadastre um cliente antes de gerar cobranças.'); return; }
    const daAba = (t) => (t.forma_cobranca ?? 'BOLETO') === st.carteira;
    clientes.sort((a, b) => daAba(b) - daAba(a) || (b.modo_faturamento === 'BOLETO') - (a.modo_faturamento === 'BOLETO') || a.nome.localeCompare(b.nome, 'pt-BR'));
    const vencDe = (t) => {
      const base = new Date(Date.now() - 3 * 3600e3);
      if (t.vencimento_tipo !== 'DIA_FIXO') return new Date(base.getTime() + (t.vencimento_valor ?? 10) * 86400e3).toISOString().slice(0, 10);
      const ult = (a, m) => new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
      let a = base.getUTCFullYear(), m = base.getUTCMonth(), dia = Math.min(t.vencimento_valor, ult(a, m));
      if (dia <= base.getUTCDate()) { m += 1; if (m > 11) { m = 0; a += 1; } dia = Math.min(t.vencimento_valor, ult(a, m)); }
      return new Date(Date.UTC(a, m, dia)).toISOString().slice(0, 10);
    };
    abrirDialogo(`
      <form id="form-nb"><h2>Nova cobrança</h2>
        <p class="sutil">Gera só a cobrança, sem emitir nota fiscal: boleto ou Pix, conforme a carteira do cliente. Os clientes da carteira aberta aparecem primeiro.</p>
        <div class="grade">
          <label class="largo">Cliente <select name="tomadorId" required>${clientes.map((t) => `<option value="${t.id}">${esc(t.nome)} — ${t.forma_cobranca === 'PIX' ? 'Pix' : 'boleto'}</option>`).join('')}</select></label>
          ${pixAuto ? `<p class="largo banner" data-so-pix>O Kontor gera o Pix desta cobrança sozinho, com a chave Pix da empresa e o valor final (já com o desconto do cliente).</p>`
            : `<label class="largo" data-so-pix>Pix copia e cola <textarea name="pix" rows="3" placeholder="Cole aqui o código gerado no aplicativo do banco (pode informar depois)"></textarea><span class="dica">Gere a cobrança Pix no banco com o valor final (já com o desconto do cliente). O Kontor confere o código e monta o demonstrativo com o QR Code. Para o Kontor gerar o Pix sozinho, cadastre a chave Pix em Empresas › Dados bancários.</span></label>`}
          <label class="largo">Descrição <input name="descricao" required maxlength="2000" placeholder="ex.: Honorários contábeis — outubro/2026"></label>
          <label>Valor antes do desconto (R$) <input name="valor" data-num required inputmode="decimal"><span class="dica" id="dica-desc-nb"></span></label>
          <label>Vencimento <input type="date" name="vencimento" required></label>
          <label class="largo"><span><input type="checkbox" name="enviarEmail"> Enviar a cobrança por e-mail ao cliente</span>${pixAuto ? '' : '<span class="dica" data-so-pix>No Pix, o e-mail só sai se o código já estiver colado.</span>'}</label>
        </div>
        <p class="dica" id="aviso-nb"></p><p class="erro" id="erro-nb"></p>
        <div class="acoes"><button class="primario" type="submit">Gerar cobrança</button><button type="button" data-fechar>Cancelar</button></div>
      </form>`, (d) => {
      const f = $('#form-nb');
      const formaPix = () => cliente()?.forma_cobranca === 'PIX';
      const cliente = () => clientes.find((t) => t.id === Number(f.tomadorId.value));
      const ajustar = () => { const r = ajustarVencimento(f.vencimento.value, fer); if (r.aviso) { f.vencimento.value = r.data; $('#aviso-nb').textContent = r.aviso; } else $('#aviso-nb').textContent = ''; };
      const dicaDesc = () => { const t = cliente(); $('#dica-desc-nb').textContent = t.desconto_valor ? `Será abatido o desconto do cliente: ${brl(t.desconto_valor)} (${t.desconto_motivo}).` : ''; };
      f.tomadorId.addEventListener('change', dicaDesc);
      // sugestão do cadastro: serviços padrão do cliente (valor e descrição)${'' if not contab else ' ou o honorário do contrato'}; o que a pessoa digitou não é trocado
      const mesRef = (() => { const b = new Date(Date.now() - 3 * 3600e3); return b.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }); })();
      const sugestao = (t) => {
        const sv = (t.servicos_padrao ?? []).filter((x) => x.valor > 0);
        const valor = sv.length ? sv.reduce((a, x) => a + Number(x.valor), 0) : (t.honorario ?? null);
        const nomes = [...new Set(sv.map((x) => (x.descricao || x.servico_nome || '').trim()).filter(Boolean))];
        const desc = nomes.length ? `${nomes.join(' + ')} — ${mesRef}` : t.honorario ? `Honorários contábeis — ${mesRef}` : '';
        return { valor, desc };
      };
      let ultima = { valor: '', desc: '' };
      const sugerir = () => {
        const sg = sugestao(cliente());
        const v = sg.valor != null ? String(Number(sg.valor).toFixed(2)).replace('.', ',') : '';
        if (!f.valor.value || f.valor.value === ultima.valor) f.valor.value = v;
        if (!f.descricao.value || f.descricao.value === ultima.desc) f.descricao.value = sg.desc;
        ultima = { valor: v, desc: sg.desc };
      };
      f.tomadorId.addEventListener('change', sugerir);
      f.tomadorId.onchange = () => { const t = cliente(); dicaDesc(); f.vencimento.value = vencDe(t); f.enviarEmail.checked = !!t.enviar_email_auto; ajustar(); f.querySelectorAll('[data-so-pix]').forEach((x) => (x.hidden = !formaPix())); };
      f.vencimento.onchange = ajustar;
      f.tomadorId.onchange();
      sugerir();
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const v = lerForm(f);
        const botao = f.querySelector('[type=submit]'); botao.disabled = true; botao.textContent = 'Gerando…';
        try {
          const r = await api('POST', `/api/empresas/${estado.empresaId}/boleto-avulso`, { tomadorId: Number(v.tomadorId), descricao: v.descricao, valor: v.valor, vencimento: v.vencimento, enviarEmail: !!v.enviarEmail, pixCopiaCola: formaPix() && f.pix ? (f.pix.value.trim() || null) : null });
          d.close();
          st.carteira = r.cobranca.forma ?? 'BOLETO';
          const partes = [`${r.cobranca.forma === 'PIX' ? 'Cobrança Pix' : 'Boleto'} de ${brl(r.cobranca.valor)} (venc. ${dataBr(r.cobranca.vencimento)})`];
          if (r.email?.status === 'ENVIADO') partes.push(`e-mail enviado para ${r.email.para}`);
          if (r.email?.status === 'ERRO') partes.push(`e-mail não enviado: ${r.email.erro}`);
          aviso(partes.join(' · ') + '.' + (r.avisos?.length ? ' ' + r.avisos.join(' ') : '')); telaCobrancas();
        } catch (e) { $('#erro-nb').textContent = mensagemErro(e); botao.disabled = false; botao.textContent = 'Gerar cobrança'; }
      };
    });
  };

  // ---- WhatsApp de cobrança com modelo editável ----
  const aplicarModelo = (modelo, c) => modelo
    .replace(/\{cliente\}/g, c.tomador_nome).replace(/\{valor\}/g, brl(c.valor)).replace(/\{vencimento\}/g, dataBr(c.vencimento))
    .replace(/\{empresa\}/g, empresa()?.nome_fantasia || empresa()?.razao_social || '')
    .replace(/\{linha\}/g, c.forma === 'PIX' ? (c.pix_copia_cola ? `\nPix copia e cola: ${c.pix_copia_cola}` : '') : c.linha_digitavel ? `\nLinha digitável: ${c.linha_digitavel}` : '')
    .replace(/o boleto de /g, c.forma === 'PIX' ? 'a cobrança de ' : 'o boleto de ');
  conteudo.querySelectorAll('[data-wa]').forEach((b) => (b.onclick = async () => {
    const c = lista.find((x) => x.id === Number(b.dataset.wa));
    const m = await api('GET', `/api/empresas/${estado.empresaId}/modelos-whatsapp`);
    const atrasado = c.vencimento < hoje;
    abrirDialogo(`
      <form id="form-wa"><h2>WhatsApp para ${esc(c.tomador_nome)}</h2>
        <p class="sutil">${atrasado ? 'Cobrança vencida: usando o modelo de atraso.' : 'Usando o modelo de lembrete.'} Revise o texto; o WhatsApp abre com a mensagem pronta e você só confirma o envio.</p>
        <label>WhatsApp do cliente (com DDD) <input name="fone" required value="${esc(c.tomador_fone ?? '')}" placeholder="(47) 99999-9999"></label>
        <label>Mensagem <textarea name="texto" rows="7">${esc(aplicarModelo(atrasado ? m.atraso : m.lembrete, c))}</textarea></label>
        <p class="erro" id="erro-wa"></p>
        <div class="acoes"><button class="primario" type="submit">Abrir WhatsApp</button>${c.nosso_numero ? '<button type="button" id="wa-pdf">Baixar boleto para anexar</button>' : ''}${c.forma === 'PIX' && c.pix_copia_cola ? '<button type="button" id="wa-demo">Baixar demonstrativo para anexar</button>' : ''}<button type="button" data-fechar>Fechar</button></div>
      </form>`, () => {
      const pdf = $('#wa-pdf'); if (pdf) pdf.onclick = () => baixar(`/api/cobrancas/${c.id}/boleto`, `Boleto_${c.id}.pdf`);
      const dm = $('#wa-demo'); if (dm) dm.onclick = () => baixar(`/api/cobrancas/${c.id}/demonstrativo`, `Demonstrativo_${c.id}.pdf`);
      $('#form-wa').onsubmit = (ev) => {
        ev.preventDefault();
        let num = ev.target.fone.value.replace(/\D/g, '');
        if (num.length === 10 || num.length === 11) num = '55' + num;
        if (num.length < 12 || num.length > 13) { $('#erro-wa').textContent = 'Número inválido. Informe DDD + número, por exemplo (47) 99999-9999.'; return; }
        window.open(`https://wa.me/${num}?text=${encodeURIComponent(ev.target.texto.value)}`, '_blank');
      };
    });
  }));
  $('#modelo-wa').onclick = async () => {
    const m = await api('GET', `/api/empresas/${estado.empresaId}/modelos-whatsapp`);
    abrirDialogo(`
      <form id="form-modelo"><h2>Mensagens de cobrança por WhatsApp</h2>
        <p class="sutil">Campos que o sistema preenche sozinho: <code>{cliente}</code> <code>{valor}</code> <code>{vencimento}</code> <code>{empresa}</code> <code>{linha}</code> (linha digitável do boleto, quando existir).</p>
        <label>Lembrete (boleto ainda não vencido) <textarea name="lembrete" rows="5">${esc(m.lembrete)}</textarea></label>
        <label>Cobrança em atraso <textarea name="atraso" rows="5">${esc(m.atraso)}</textarea></label>
        <p class="erro" id="erro-modelo"></p>
        <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" id="modelo-padrao">Voltar ao texto padrão</button><button type="button" data-fechar>Fechar</button></div>
      </form>`, (d) => {
      $('#modelo-padrao').onclick = () => { $('#form-modelo').lembrete.value = m.padrao.lembrete; $('#form-modelo').atraso.value = m.padrao.atraso; };
      $('#form-modelo').onsubmit = async (ev) => {
        ev.preventDefault();
        try { await api('PUT', `/api/empresas/${estado.empresaId}/modelos-whatsapp`, { lembrete: ev.target.lembrete.value, atraso: ev.target.atraso.value }); d.close(); aviso('Mensagens salvas.'); }
        catch (e) { $('#erro-modelo').textContent = mensagemErro(e); }
      };
    });
  };

  // ---- Reemitir: nova cobrança com os mesmos dados e outro vencimento ----
  conteudo.querySelectorAll('[data-reemitir]').forEach((b) => (b.onclick = async () => {
    const c = lista.find((x) => x.id === Number(b.dataset.reemitir));
    const [a, m, dia] = c.vencimento.split('-').map(Number);
    const prox = new Date(Date.UTC(a, m, Math.min(dia, new Date(Date.UTC(a, m + 1, 0)).getUTCDate()))).toISOString().slice(0, 10);
    const sugerido = prox < hoje ? hoje : prox;
    const fer = await api('GET', `/api/empresas/${estado.empresaId}/feriados`).then((r) => r.feriados_extra).catch(() => '');
    abrirDialogo(`
      <form id="form-re"><h2>Reemitir boleto</h2>
        <p class="sutil">Gera uma nova cobrança para <strong>${esc(c.tomador_nome)}</strong> com a mesma descrição. Só o boleto: nenhuma nota é emitida.</p>
        <div class="grade">
          <label>Novo vencimento <input type="date" name="vencimento" required value="${sugerido}"></label>
          <label>Valor antes do desconto (R$) <input name="valor" data-num required inputmode="decimal" value="${String(Math.round((c.valor + (c.desconto ?? 0)) * 100) / 100).replace('.', ',')}"></label>
        </div>
        <p class="dica">${c.desconto > 0 ? `O desconto cadastrado no cliente (${esc(c.desconto_motivo ?? '')}) é abatido deste valor.` : 'Se o cliente tiver desconto cadastrado, ele é abatido deste valor.'}</p>
        <p class="dica" id="aviso-re"></p><p class="erro" id="erro-re"></p>
        <div class="acoes"><button class="primario" type="submit">Gerar boleto</button><button type="button" data-fechar>Cancelar</button></div>
      </form>`, (d) => {
      const f = $('#form-re');
      f.vencimento.onchange = () => { const r = ajustarVencimento(f.vencimento.value, fer); if (r.aviso) { f.vencimento.value = r.data; $('#aviso-re').textContent = r.aviso; } else $('#aviso-re').textContent = ''; };
      f.vencimento.onchange();
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const v = lerForm(f);
        try {
          const r = await api('POST', `/api/cobrancas/${c.id}/reemitir`, { vencimento: v.vencimento, valor: v.valor });
          d.close(); aviso(`Novo boleto de ${brl(r.cobranca.valor)} com vencimento em ${dataBr(r.cobranca.vencimento)}.`); telaCobrancas();
        } catch (e) { $('#erro-re').textContent = mensagemErro(e); }
      };
    });
  }));

  const gr = $('#gerar-remessa');
  if (gr) gr.onclick = async () => {
    gr.disabled = true;
    try {
      const r = await api('POST', `/api/empresas/${estado.empresaId}/remessas`, {});
      await baixar(`/api/remessas/${r.id}/arquivo`, r.nome_arquivo);
      aviso(`Remessa ${r.numero} gerada: ${r.entradas} boleto(s) e ${r.baixas} baixa(s).`); telaCobrancas();
    } catch (e) { aviso(mensagemErro(e)); gr.disabled = false; }
  };
  const lr = $('#ler-retorno'), arq = $('#arq-retorno');
  if (lr) {
    lr.onclick = () => arq.click();
    arq.onchange = async () => {
      const f = arq.files[0]; if (!f) return;
      try {
        const r = await api('POST', `/api/empresas/${estado.empresaId}/retorno`, { conteudo: await f.text() });
        const partes = [r.pagos && `${r.pagos} pago(s)`, r.registrados && `${r.registrados} registrado(s)`, r.rejeitados && `${r.rejeitados} rejeitado(s)`, r.baixados && `${r.baixados} baixado(s)`].filter(Boolean);
        aviso(`Retorno processado: ${partes.join(', ') || 'sem alterações'}.${r.naoEncontrados.length ? ` ${r.naoEncontrados.length} título(s) não encontrados.` : ''}`);
        telaCobrancas();
      } catch (e) { aviso(mensagemErro(e)); }
    };
  }
}

// ---------------------------------------------------------------------------
// Dados bancários (convênio de cobrança com remessa e retorno)
// ---------------------------------------------------------------------------
async function telaBanco() {
  const c = (await api('GET', `/api/empresas/${estado.empresaId}/conta-bancaria`)) ?? { cooperativa_nome: '', carteira: '01', multa_pct: 2, juros_pct_mes: 1 };
  const cora = await api('GET', `/api/empresas/${estado.empresaId}/cora`).catch(() => null);
  const pixCfg = await api('GET', `/api/empresas/${estado.empresaId}/pix-config`).catch(() => null);
  const px = pixCfg?.config;
  conteudo.innerHTML = `
    <div class="topo"><div><p class="sutil"><a href="#/empresas">← Empresas</a></p><h1>Dados bancários</h1><p class="sutil">${esc(empresa().razao_social)} — cobrança pela Cora (API) ou por convênio com remessa e retorno</p></div></div>
    <form id="form-pixk" class="cartao" style="margin-bottom:20px">
      <h2 style="margin-top:0">Pix gerado pelo Kontor ${px ? (px.ativo ? '<span class="selo-estado" style="--c:var(--verde)">ativo</span>' : '<span class="selo-estado" style="--c:var(--laranja)">desativado</span>') : ''}</h2>
      <p class="dica">Para os clientes da carteira Pix: o Kontor monta o Pix copia e cola e o QR Code de cada cobrança, com o valor certo, usando a chave Pix da empresa (InfinitePay ou qualquer outro banco). O dinheiro cai direto na conta dessa chave, sem taxa do Kontor. A baixa do pagamento continua manual (botão Pago, ou pelo extrato).</p>
      <div class="grade">
        <label>Tipo de chave <select name="tipo">${Object.entries(pixCfg?.tipos ?? {}).map(([k, t]) => `<option value="${k}" ${px?.tipo === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label>Chave Pix <input name="chave" maxlength="77" autocomplete="off" required value="${esc(px?.chave ?? '')}" placeholder="A chave cadastrada no banco"></label>
        <label>Nome do recebedor <input name="nome" maxlength="60" required value="${esc(px?.nome ?? empresa().razao_social ?? '')}"><span class="dica">Até 25 letras, sem acento (o banco mostra o nome oficial da conta ao pagar)</span></label>
        <label>Cidade <input name="cidade" maxlength="40" required value="${esc(px?.cidade ?? empresa().cidade ?? '')}"></label>
        <label class="check"><input type="checkbox" name="ativo" ${px ? (px.ativo ? 'checked' : '') : 'checked'}> Gerar o Pix sozinho nas novas cobranças da carteira Pix</label>
      </div>
      <p class="erro" id="erro-pixk" role="alert"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar chave Pix</button>${px && pixCfg.pendentes ? `<button type="button" id="pixk-pend">Gerar o Pix das ${pixCfg.pendentes} cobrança(s) pendente(s)</button>` : ''}</div>
      <p class="dica">Confira a chave com cuidado: um Pix pago para a chave errada não volta sozinho. Faça um Pix de teste de pequeno valor antes de enviar aos clientes.</p>
    </form>
    <form id="form-cora" class="cartao" style="margin-bottom:20px">
      <h2 style="margin-top:0">Banco Cora ${cora ? (cora.ativa ? '<span class="selo-estado" style="--c:var(--verde)">ativa</span>' : '<span class="selo-estado" style="--c:var(--laranja)">desativada</span>') : ''}</h2>
      <p class="dica">Com a Cora, o boleto (com Pix) é registrado direto pelo sistema, a baixa é automática e o extrato vem da API, sem arquivo de remessa. Para gerar as credenciais: app ou Cora Web › <strong>Integrações via API</strong> › <strong>Integração direta</strong>; baixe o <em>Client ID</em>, o <em>certificado</em> e a <em>chave privada</em> (arquivos .pem). Teste e produção têm credenciais diferentes. Se a empresa tiver Cora ativa, os novos boletos saem pela Cora; os já emitidos pelo convênio continuam com remessa e retorno.</p>
      <div class="grade">
        <label>Ambiente <select name="ambiente"><option value="producao" ${cora?.ambiente !== 'teste' ? 'selected' : ''}>Produção</option><option value="teste" ${cora?.ambiente === 'teste' ? 'selected' : ''}>Teste (stage)</option></select></label>
        <label>Client ID <input name="client_id" maxlength="120" autocomplete="off" value="${esc(cora?.client_id ?? '')}"></label>
        <label>Multa após o vencimento (%) <input name="multa_pct" data-num inputmode="decimal" value="${String(cora?.multa_pct ?? 2).replace('.', ',')}"></label>
        <label>Juros ao mês (%) <input name="juros_pct_mes" data-num inputmode="decimal" value="${String(cora?.juros_pct_mes ?? 1).replace('.', ',')}"></label>
        <label class="largo">Certificado (.pem) ${cora ? '<span class="dica">— já salvo; só preencha para trocar</span>' : ''} <textarea name="certificado" rows="3" placeholder="-----BEGIN CERTIFICATE-----" spellcheck="false"></textarea><input type="file" data-ler="certificado" accept=".pem,.crt,.cer,.txt"></label>
        <label class="largo">Chave privada (.pem) ${cora ? '<span class="dica">— já salva; só preencha para trocar</span>' : ''} <textarea name="chave" rows="3" placeholder="-----BEGIN PRIVATE KEY-----" spellcheck="false" autocomplete="off"></textarea><input type="file" data-ler="chave" accept=".pem,.key,.txt"></label>
        <label class="check"><input type="checkbox" name="ativa" ${cora ? (cora.ativa ? 'checked' : '') : 'checked'}> Usar a Cora nas novas cobranças</label>
      </div>
      <p class="erro" id="erro-cora" role="alert"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar Cora</button>${cora ? '<button type="button" id="cora-testar">Testar conexão</button><button type="button" id="cora-remover">Remover</button>' : ''}</div>
      ${cora?.saldo != null ? `<p class="dica">Último saldo lido: ${brl(cora.saldo)}.</p>` : ''}
    </form>
    <form id="form-banco">
      <fieldset><legend>Conta e convênio de cobrança</legend><p class="dica">Peça estes dados à sua cooperativa: o número do convênio de cobrança e a carteira são informados por ela.</p><div class="grade">
        <label>Cooperativa <input name="cooperativa_nome" required maxlength="30" value="${esc(c.cooperativa_nome ?? '')}"></label>
        <label>Agência <input name="agencia" required inputmode="numeric" maxlength="5" value="${esc(c.agencia ?? '')}"></label>
        <label>Dígito da agência <input name="agencia_dv" required maxlength="1" value="${esc(c.agencia_dv ?? '')}"></label>
        <label>Conta corrente (sem dígito) <input name="conta" required inputmode="numeric" maxlength="7" value="${esc(c.conta ?? '')}"></label>
        <label>Dígito da conta <input name="conta_dv" required maxlength="1" value="${esc(c.conta_dv ?? '')}"></label>
        <label>Convênio de cobrança <input name="convenio" required inputmode="numeric" maxlength="6" value="${esc(c.convenio ?? '')}"></label>
        <label>Carteira <input name="carteira" required maxlength="2" value="${esc(c.carteira ?? '01')}"></label>
        <label>Formato do arquivo
          <select name="layout"><option value="CNAB400" ${c.layout !== 'CNAB240' ? 'selected' : ''}>CNAB 400</option><option value="CNAB240" ${c.layout === 'CNAB240' ? 'selected' : ''}>CNAB 240</option></select></label>
      </div></fieldset>
      <fieldset><legend>Numeração (para quem já emitia boletos em outro sistema)</legend>
        <p class="dica">O nosso número nunca pode repetir. Se esta conta já emitiu boletos antes do Kontor, informe aqui o <strong>próximo</strong> número livre (último usado + 1) e o número da próxima remessa. Depois que houver boletos emitidos, só é possível aumentar.</p>
        <div class="grade">
          <label>Próximo número de boleto <input name="proximo_boleto" type="number" min="1" value="${c.proximo_boleto ?? 1}"></label>
          <label>Número da próxima remessa <input name="proxima_remessa" type="number" min="1" value="${c.proxima_remessa ?? 1}"></label>
        </div></fieldset>
      <fieldset><legend>Encargos e mensagem do boleto</legend><div class="grade">
        <label>Multa após o vencimento (%) <input name="multa_pct" data-num inputmode="decimal" value="${String(c.multa_pct ?? 2).replace('.', ',')}"></label>
        <label>Juros ao mês (%) <input name="juros_pct_mes" data-num inputmode="decimal" value="${String(c.juros_pct_mes ?? 1).replace('.', ',')}"></label>
        <label class="largo">Instrução adicional (até 40 caracteres) <input name="instrucoes" maxlength="40" value="${esc(c.instrucoes ?? '')}"></label>
      </div></fieldset>
      <p class="erro" id="erro-banco" role="alert"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar dados bancários</button></div>
    </form>
    <form id="form-feriados" class="cartao" style="margin-top:20px">
      <h2 style="margin-top:0">Feriados locais</h2>
      <p class="dica">Boleto não vence em sábado, domingo nem feriado: o sistema antecipa para o dia útil anterior. Os feriados nacionais, o carnaval, a sexta-feira santa e o Corpus Christi já estão incluídos. Informe aqui os feriados do seu município (dia/mês, separados por vírgula).</p>
      <label>Feriados municipais <input name="feriados_extra" placeholder="ex.: 24/06, 19/03" value=""></label>
      <p class="erro" id="erro-feriados"></p>
      <div class="acoes"><button type="submit">Salvar feriados</button></div>
    </form>
`;
  api('GET', `/api/empresas/${estado.empresaId}/feriados`).then((r) => { $('#form-feriados').feriados_extra.value = r.feriados_extra ?? ''; }).catch(() => {});
  $('#form-feriados').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('PUT', `/api/empresas/${estado.empresaId}/feriados`, { feriados_extra: ev.target.feriados_extra.value }); aviso('Feriados salvos.'); }
    catch (e) { $('#erro-feriados').textContent = mensagemErro(e); }
  };
  const fp = $('#form-pixk');
  fp.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(fp));
    try { await api('PUT', `/api/empresas/${estado.empresaId}/pix-config`, { ativo: !!d.ativo, tipo: d.tipo, chave: d.chave, nome: d.nome, cidade: d.cidade }); aviso('Chave Pix salva.'); telaBanco(); }
    catch (e) { $('#erro-pixk').textContent = mensagemErro(e); }
  };
  $('#pixk-pend') && ($('#pixk-pend').onclick = async () => {
    try { const r2 = await api('POST', `/api/empresas/${estado.empresaId}/pix-gerar`); aviso(`${r2.gerados} Pix gerado(s).`); telaBanco(); } catch (e) { aviso(mensagemErro(e)); }
  });
  const fc = $('#form-cora');
  fc.querySelectorAll('[data-ler]').forEach((i) => (i.onchange = async () => { const a = i.files[0]; if (a) fc[i.dataset.ler].value = await a.text(); }));
  fc.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = lerForm(fc);
    try {
      await api('PUT', `/api/empresas/${estado.empresaId}/cora`, { ativa: !!d.ativa, ambiente: d.ambiente, client_id: d.client_id ?? '', certificado: d.certificado || null, chave: d.chave || null, multa_pct: d.multa_pct ?? 0, juros_pct_mes: d.juros_pct_mes ?? 0 });
      aviso('Cora salva.'); telaBanco();
    } catch (e) { $('#erro-cora').textContent = mensagemErro(e); }
  };
  const ct = $('#cora-testar');
  if (ct) ct.onclick = async () => {
    ct.disabled = true; ct.textContent = 'Testando…';
    try { const r = await api('POST', `/api/empresas/${estado.empresaId}/cora/testar`, {}); aviso(`Conexão com a Cora funcionando${r.saldo != null ? `. Saldo: ${brl(r.saldo)}` : ''}.`); telaBanco(); }
    catch (e) { $('#erro-cora').textContent = mensagemErro(e); ct.disabled = false; ct.textContent = 'Testar conexão'; }
  };
  const cr = $('#cora-remover');
  if (cr) cr.onclick = async () => {
    if (!confirm('Remover a conta Cora desta empresa? Os boletos já registrados continuam existindo na Cora.')) return;
    try { await api('DELETE', `/api/empresas/${estado.empresaId}/cora`); aviso('Conta Cora removida.'); telaBanco(); }
    catch (e) { $('#erro-cora').textContent = mensagemErro(e); }
  };
  const f = $('#form-banco');
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = lerForm(f);
    try {
      await api('PUT', `/api/empresas/${estado.empresaId}/conta-bancaria`, { ...d, multa_pct: d.multa_pct ?? 0, juros_pct_mes: d.juros_pct_mes ?? 0, instrucoes: d.instrucoes || null, proximo_boleto: Number(d.proximo_boleto) || null, proxima_remessa: Number(d.proxima_remessa) || null });
      aviso('Dados bancários salvos.'); telaBanco();
    } catch (e) { $('#erro-banco').textContent = mensagemErro(e); }
  };
}

// ---------------------------------------------------------------------------
// Tributação: tributações e impostos
// ---------------------------------------------------------------------------
async function telaTributacao(aba) {
  const abas = [['perfis', 'Tributações'], ['impostos', 'Impostos']];
  if (aba === 'tipos') aba = 'perfis';
  if (!abas.some((a) => a[0] === aba)) aba = 'perfis';
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Tributação</h1><p class="sutil">Cadastre os impostos uma vez, monte cada tributação (alíquotas, retenções e dados da nota) e vincule serviços e compras a ela.</p></div></div>
    <nav class="abas" aria-label="Tributação">${abas.map(([k, n]) => `<a href="#/tributacao/${k}" class="${k === aba ? 'ativo' : ''}">${n}</a>`).join('')}</nav>
    <div id="trib-corpo"></div>`;
  await { perfis: abaPerfis, impostos: abaImpostos }[aba]();
}

const base_trib = () => `/api/empresas/${estado.empresaId}/tributacao`;
const NOME_NATUREZA_SENTIDO = { SAIDA: 'Saída', ENTRADA: 'Entrada' };
const MODELOS = { NFSE: 'NFS-e', NFE: 'NF-e (compra)', MANUAL: 'Lançamento manual' };
const NATUREZAS = ['Serviço', 'Mercadoria para revenda', 'Insumo', 'Uso e consumo', 'Ativo imobilizado', 'Devolução', 'Outra'];
const DESTINOS = { RECEITA: 'Receita', DESPESA: 'Despesa', NENHUM: 'Nenhum' };

async function abaPerfis() {
  const [perfis, impostos] = await Promise.all([api('GET', `${base_trib()}/perfis`), api('GET', '/api/tributacao/impostos')]);
  const nomeImp = Object.fromEntries(impostos.map((i) => [i.codigo, i.nome]));
  const pct = (n) => String(n ?? 0).replace('.', ',') + '%';
  $('#trib-corpo').innerHTML = `
    <div class="topo"><div><h2 style="margin-top:0">Tributações</h2><p class="sutil">Uma tributação é um conjunto de impostos com alíquota, redução de base, retenção e vigência. As alíquotas mudam ao longo da transição do IBS/CBS: cadastre uma linha por período.</p></div>
      <div><button class="primario" id="novo-perfil">Nova tributação</button> <button id="gerar-serv" title="Cria uma tributação a partir das retenções já cadastradas em cada serviço">Criar a partir dos serviços</button></div></div>
    ${perfis.length ? perfis.map((p, i) => `<div class="cartao"><div class="topo" style="margin:0"><h3 style="margin:0">${esc(p.nome)} <span class="dica">${p.sentido === 'ENTRADA' ? 'Compras' : 'Serviços'}${p.padrao ? ' · padrão' : ''} · ${p.usos ? p.usos + ' vínculo(s)' : 'sem uso'}</span></h3><div><button data-ed="${i}">Editar</button>${podeExcluirRegistros() ? ` <button data-ex="${p.id}">Excluir</button>` : ''}</div></div>
      ${p.descricao ? `<p class="sutil">${esc(p.descricao)}</p>` : ''}
      <table class="tabela"><thead><tr><th>Imposto</th><th class="num">Alíquota</th><th class="num">Redução da base</th><th>Retido</th><th>CST / cClassTrib</th><th>Vigência</th></tr></thead><tbody>
      ${p.itens.map((it) => `<tr><td>${esc(nomeImp[it.imposto_codigo] ?? it.imposto_codigo)}</td><td class="num">${pct(it.aliquota)}</td><td class="num">${it.reducao_base ? pct(it.reducao_base) : '—'}</td><td>${it.retido ? 'Sim' : '—'}</td><td>${esc([it.cst, it.c_class_trib].filter(Boolean).join(' / ') || '—')}</td>
        <td>${it.vigencia_ini || it.vigencia_fim ? `${it.vigencia_ini ? dataBr(it.vigencia_ini) : 'sempre'} → ${it.vigencia_fim ? dataBr(it.vigencia_fim) : 'sem fim'}` : 'sempre'}</td></tr>`).join('') || '<tr><td colspan="6" class="dica">Sem impostos.</td></tr>'}
      </tbody></table></div>`).join('') : '<div class="vazio">Nenhuma tributação. Crie a primeira (ex.: "Serviço — ISS 5%") ou use "Criar a partir dos serviços".</div>'}`;
  const form = (p) => {
    p ??= { itens: [{ imposto_codigo: 'ISS', aliquota: 0, reducao_base: 0, retido: false }], sentido: 'SAIDA', destino: 'RECEITA' };
    const linha = (it) => `<tr class="it">
      <td><select name="imposto">${impostos.filter((i) => i.ativo || i.codigo === it.imposto_codigo).map((i) => `<option value="${i.codigo}" ${it.imposto_codigo === i.codigo ? 'selected' : ''}>${esc(i.nome)}</option>`).join('')}</select></td>
      <td><input name="aliquota" data-num inputmode="decimal" size="6" value="${String(it.aliquota ?? 0).replace('.', ',')}"></td>
      <td><input name="reducao" data-num inputmode="decimal" size="6" value="${String(it.reducao_base ?? 0).replace('.', ',')}"></td>
      <td><input type="checkbox" name="retido" ${it.retido ? 'checked' : ''}></td>
      <td><input name="cst" maxlength="3" size="4" placeholder="CST" value="${esc(it.cst ?? '')}"> <input name="cclass" maxlength="6" size="7" placeholder="cClassTrib" value="${esc(it.c_class_trib ?? '')}"></td>
      <td><input type="date" name="vini" value="${esc(it.vigencia_ini ?? '')}"> <input type="date" name="vfim" value="${esc(it.vigencia_fim ?? '')}"></td>
      <td><button type="button" data-rm title="Remover linha">×</button></td></tr>`;
    abrirDialogo(`<form id="form-perfil" class="dialogo-largo"><h2>${p.id ? 'Editar tributação' : 'Nova tributação'}</h2>
      <label>Nome <input name="nome" required maxlength="80" value="${esc(p.nome ?? '')}" placeholder="Ex.: Serviço com retenção federal"></label>
      <label>Descrição <input name="descricao" maxlength="300" value="${esc(p.descricao ?? '')}"></label>
      <fieldset><legend>Onde se aplica</legend><div class="grade">
        <label>Aplica-se a <select name="sentido"><option value="SAIDA" ${p.sentido !== 'ENTRADA' ? 'selected' : ''}>Serviços prestados (emissão de notas)</option><option value="ENTRADA" ${p.sentido === 'ENTRADA' ? 'selected' : ''}>Compras (NF-e de entrada)</option></select></label>
        <label>Natureza <select name="natureza"><option value=""></option>${NATUREZAS.map((n) => `<option ${p.natureza === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <label>Cód. tributação nacional (serviço) / CFOP (compra) <input name="codigo" maxlength="6" value="${esc(p.codigo ?? '')}"></label>
        <label>Indicador da operação IBS/CBS (cIndOp) <input name="ind_op" maxlength="6" value="${esc(p.ind_op ?? '')}"></label>
        <label>Consumidor final (indFinal) <select name="ind_final"><option value="0" ${(p.ind_final ?? 0) === 0 ? 'selected' : ''}>Não</option><option value="1" ${p.ind_final === 1 ? 'selected' : ''}>Sim</option></select></label>
        <label>Destinatário do IBS/CBS (indDest) <select name="ind_dest"><option value="0" ${(p.ind_dest ?? 0) === 0 ? 'selected' : ''}>O próprio tomador</option><option value="1" ${p.ind_dest === 1 ? 'selected' : ''}>Outro destinatário</option></select></label>
        <label>Destino financeiro <select name="destino">${Object.entries(DESTINOS).map(([k, n]) => `<option value="${k}" ${p.destino === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="gera_credito" ${p.gera_credito ? 'checked' : ''}> Gera crédito de impostos (compras)</label>
      <label class="check"><input type="checkbox" name="padrao" ${p.padrao ? 'checked' : ''}> Tributação padrão (usada quando o serviço ou a compra não indica uma)</label></fieldset>
      <fieldset><legend>Dados da nota (serviços)</legend><div class="grade">
        <label>ISSQN <select name="trib_issqn">${[[1, 'Operação tributável'], [2, 'Imunidade'], [3, 'Exportação de serviço'], [4, 'Não incidência']].map(([v, n]) => `<option value="${v}" ${(p.trib_issqn ?? 1) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Tipo de imunidade <select name="tp_imunidade"><option value="">—</option>${[[0, 'Imunidade não informada'], [1, 'Patrimônio, renda ou serviços'], [2, 'Templos de qualquer culto'], [3, 'Partidos, sindicatos, educação e assistência'], [4, 'Livros, jornais e periódicos'], [5, 'Fonogramas e videofonogramas musicais']].map(([v, n]) => `<option value="${v}" ${p.tp_imunidade === v ? 'selected' : ''}>${v} — ${n}</option>`).join('')}</select></label>
        <label>Tributos aprox. federal % <input name="p_tot_fed" data-num size="5" value="${String(p.p_tot_fed ?? '').replace('.', ',')}"></label>
        <label>estadual % <input name="p_tot_est" data-num size="5" value="${String(p.p_tot_est ?? '').replace('.', ',')}"></label>
        <label>municipal % <input name="p_tot_mun" data-num size="5" value="${String(p.p_tot_mun ?? '').replace('.', ',')}"></label>
        <label>Município da prestação (IBGE) <input name="municipio_prestacao" maxlength="7" value="${esc(p.municipio_prestacao ?? '')}"></label>
        <label class="largo">Informações complementares <textarea name="info_complementar" maxlength="2000">${esc(p.info_complementar ?? '')}</textarea></label>
      </div></fieldset>
      <div class="rolagem"><table class="tabela"><thead><tr><th>Imposto</th><th>Alíquota %</th><th>Redução base %</th><th>Retido</th><th>CST / cClassTrib</th><th>Vigência (de / até)</th><th></th></tr></thead><tbody id="itens-perfil">${p.itens.map(linha).join('')}</tbody></table></div>
      <div class="acoes"><button type="button" id="add-item">Adicionar imposto</button></div>
      <p class="dica">Vigência em branco = vale sempre. Para o mesmo imposto em períodos diferentes, crie uma linha por período.</p>
      <p class="erro" id="erro-perfil"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar perfil</button><button type="button" data-fechar>Cancelar</button></div></form>`, (dlg) => {
      const corpo = dlg.querySelector('#itens-perfil');
      const ligar = () => corpo.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => b.closest('tr').remove()));
      ligar();
      dlg.querySelector('#add-item').onclick = () => { corpo.insertAdjacentHTML('beforeend', linha({ imposto_codigo: 'ISS', aliquota: 0, reducao_base: 0, retido: false })); ligar(); };
      dlg.querySelector('#form-perfil').onsubmit = async (ev) => {
        ev.preventDefault(); const f = ev.target;
        const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
        const itens = [...corpo.querySelectorAll('tr.it')].map((tr) => ({
          imposto_codigo: tr.querySelector('[name=imposto]').value, aliquota: num(tr.querySelector('[name=aliquota]').value), reducao_base: num(tr.querySelector('[name=reducao]').value),
          retido: tr.querySelector('[name=retido]').checked, cst: tr.querySelector('[name=cst]').value.trim() || null, c_class_trib: tr.querySelector('[name=cclass]').value.trim() || null,
          vigencia_ini: tr.querySelector('[name=vini]').value || null, vigencia_fim: tr.querySelector('[name=vfim]').value || null }));
        const opt = (v) => (String(v).trim() === '' ? null : num(v));
        const dados = { nome: f.nome.value, descricao: f.descricao.value || null, itens,
          trib_issqn: Number(f.trib_issqn.value), tp_imunidade: Number(f.trib_issqn.value) === 2 && f.tp_imunidade.value !== '' ? Number(f.tp_imunidade.value) : null,
          p_tot_fed: opt(f.p_tot_fed.value), p_tot_est: opt(f.p_tot_est.value), p_tot_mun: opt(f.p_tot_mun.value),
          municipio_prestacao: f.municipio_prestacao.value.trim() || null, info_complementar: f.info_complementar.value.trim() || null,
          sentido: f.sentido.value, natureza: f.natureza.value || null, codigo: f.codigo.value.trim() || null, ind_op: f.ind_op.value.trim() || null,
          ind_final: Number(f.ind_final.value), ind_dest: Number(f.ind_dest.value), destino: f.destino.value, gera_credito: f.gera_credito.checked, padrao: f.padrao.checked };
        try { p.id ? await api('PUT', `${base_trib()}/perfis/${p.id}`, dados) : await api('POST', `${base_trib()}/perfis`, dados); dlg.close(); aviso('Tributação salva.'); abaPerfis(); }
        catch (e) { $('#erro-perfil').textContent = mensagemErro(e); }
      };
    });
  };
  $('#novo-perfil').onclick = () => form();
  $('#gerar-serv').onclick = async () => {
    try { const r = await api('POST', `${base_trib()}/gerar-dos-servicos`, {}); aviso(r.perfisCriados ? `${r.perfisCriados} tributação(ões) criada(s) a partir de ${r.servicos} serviço(s).` : 'Nenhum serviço com retenções para converter.'); abaPerfis(); } catch (e) { aviso(mensagemErro(e)); }
  };
  $('#trib-corpo').querySelectorAll('[data-ed]').forEach((b) => (b.onclick = () => form(perfis[b.dataset.ed])));
  $('#trib-corpo').querySelectorAll('[data-ex]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Excluir esta tributação?')) return;
    try { await api('DELETE', `${base_trib()}/perfis/${b.dataset.ex}`); abaPerfis(); } catch (e) { aviso(mensagemErro(e)); }
  }));
}

async function abaImpostos() {
  const lista = await api('GET', '/api/tributacao/impostos');
  const grupos = { MUNICIPAL: 'Municipal', ESTADUAL: 'Estadual', FEDERAL: 'Federal', IBS_CBS: 'IBS / CBS' };
  $('#trib-corpo').innerHTML = `
    <h2 style="margin-top:0">Impostos</h2><p class="sutil">Catálogo usado pelos perfis. Desmarque um imposto que a empresa não usa para ele sair das listas; o nome pode ser ajustado.</p>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Código</th><th>Nome</th><th>Grupo</th><th>Pode ser retido</th><th>Gera crédito</th><th>Ativo</th><th></th></tr></thead><tbody>
    ${lista.map((i) => `<tr data-c="${i.codigo}"><td><strong>${i.codigo}</strong></td><td><input name="nome" value="${esc(i.nome)}" maxlength="80"></td><td>${grupos[i.grupo]}</td><td>${i.pode_reter ? 'Sim' : '—'}</td><td>${i.credita ? 'Sim' : '—'}</td><td><input type="checkbox" name="ativo" ${i.ativo ? 'checked' : ''}></td><td><button data-sv>Salvar</button></td></tr>`).join('')}
    </tbody></table></div>`;
  $('#trib-corpo').querySelectorAll('[data-sv]').forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr');
    try { await api('PUT', `/api/tributacao/impostos/${tr.dataset.c}`, { nome: tr.querySelector('[name=nome]').value, ativo: tr.querySelector('[name=ativo]').checked }); aviso('Imposto salvo.'); } catch (e) { aviso(mensagemErro(e)); }
  }));
}

// ---------------------------------------------------------------------------
// Compras (NF-e de entrada)
// ---------------------------------------------------------------------------
const isoMais = (iso, d) => new Date(Date.parse(iso + 'T12:00:00Z') + d * 86400e3).toISOString().slice(0, 10);

/** Editor de parcelas: linhas de vencimento e valor, com a conferência contra o total da nota. `total` pode ser função (valor digitado na tela). */
function editorParcelas(box, parcelas, total, base, aoMudar) {
  let linhas = parcelas.map((p) => ({ numero: p.numero ?? null, vencimento: p.vencimento, valor: p.valor }));
  const tot = () => Math.round((typeof total === 'function' ? total() : total) * 100) / 100 || 0;
  const fmt = (v) => String(Number(v).toFixed(2)).replace('.', ',');
  const soma = () => Math.round(linhas.reduce((a, p) => a + (Number(p.valor) || 0), 0) * 100) / 100;
  const dividir = (n, dias) => {
    const ini = linhas[0]?.vencimento ?? base, cent = Math.round(tot() * 100), cada = Math.floor(cent / n);
    linhas = Array.from({ length: n }, (_, i) => ({ numero: null, vencimento: dias ? isoMais(ini, dias * i) : (linhas[i]?.vencimento ?? isoMais(ini, 30 * i)), valor: (i === n - 1 ? cent - cada * (n - 1) : cada) / 100 }));
  };
  const desenhar = () => {
    box.innerHTML = `<table class="tabela"><thead><tr><th>Parcela</th><th>Vencimento</th><th class="num">Valor (R$)</th><th></th></tr></thead><tbody>
      ${linhas.map((p, i) => `<tr><td>${i + 1}/${linhas.length}</td><td><input type="date" data-pv="${i}" value="${p.vencimento}"></td>
        <td class="num"><input data-pq="${i}" data-num inputmode="decimal" size="10" value="${fmt(p.valor)}"></td>
        <td>${linhas.length > 1 ? `<button type="button" data-pr="${i}" title="Remover parcela">×</button>` : ''}</td></tr>`).join('')}</tbody></table>
      <div class="acoes-linha"><button type="button" id="p-add">Adicionar parcela</button>
        <label style="display:inline-flex;gap:6px;align-items:center">Refazer em <input id="p-n" type="number" min="1" max="60" value="${linhas.length}" style="width:64px"> parcelas a cada <input id="p-d" type="number" min="1" max="365" value="30" style="width:64px"> dias</label>
        <button type="button" id="p-refaz">Refazer</button></div>
      <p id="p-status"></p>`;
    status();
    box.querySelectorAll('[data-pv]').forEach((i) => (i.onchange = () => { linhas[Number(i.dataset.pv)].vencimento = i.value; aoMudar?.(); }));
    box.querySelectorAll('[data-pq]').forEach((i) => (i.oninput = () => { linhas[Number(i.dataset.pq)].valor = numero(i.value) ?? 0; status(); aoMudar?.(); }));
    box.querySelectorAll('[data-pr]').forEach((b) => (b.onclick = () => { linhas.splice(Number(b.dataset.pr), 1); desenhar(); aoMudar?.(); }));
    box.querySelector('#p-add').onclick = () => { const ult = linhas[linhas.length - 1]; linhas.push({ numero: null, vencimento: isoMais(ult?.vencimento ?? base, 30), valor: Math.max(0, Math.round((tot() - soma()) * 100) / 100) }); desenhar(); aoMudar?.(); };
    box.querySelector('#p-refaz').onclick = () => {
      dividir(Math.min(60, Math.max(1, Number(box.querySelector('#p-n').value) || 1)), Math.max(1, Number(box.querySelector('#p-d').value) || 30));
      desenhar(); aoMudar?.();
    };
  };
  const status = () => {
    const dif = Math.round((soma() - tot()) * 100) / 100, el = box.querySelector('#p-status');
    if (el) el.innerHTML = Math.abs(dif) < 0.005 ? `<span class="cor-verde">Parcelas fecham com o total (${brl(tot())}).</span>`
      : `<span class="cor-vermelho">Soma das parcelas ${brl(soma())} · total ${brl(tot())} · ${dif > 0 ? 'sobram' : 'faltam'} ${brl(Math.abs(dif))}.</span>`;
  };
  desenhar();
  return {
    ler: () => linhas.map((p) => ({ numero: p.numero, vencimento: p.vencimento, valor: Number(p.valor) || 0 })),
    fecha: () => Math.abs(soma() - tot()) < 0.005,
    /** À vista: uma parcela só, vencendo até a data da compra. */
    aVista: (emissao) => linhas.length === 1 && linhas[0].vencimento <= emissao,
    /** Passa a parcelar: refaz em n parcelas a cada `dias`, a partir da data indicada. */
    parcelar: (inicio, n = 2, dias = 30) => { if (linhas[0]) linhas[0].vencimento = inicio; dividir(n, dias); desenhar(); },
    /** O total ou a data da compra mudou: refaz as parcelas mantendo a quantidade (uma parcela à vista acompanha a data da compra). */
    recalcular: (emissao) => { if (linhas.length === 1 && emissao) linhas[0].vencimento = emissao; dividir(linhas.length, 0); desenhar(); },
  };
}

async function dadosDeEntrada() {
  const base = `/api/empresas/${estado.empresaId}`;
  const cat = await api('GET', `${base}/despesas?mes=${mesAtual()}`).then((x) => x.categorias).catch(() => ['Outras']);
  const tiposEntrada = await api('GET', `${base}/tributacao/tipos`).then((r) => r.tipos.filter((t) => t.sentido === 'ENTRADA')).catch(() => []);
  const opcTipo = () => `<option value="">${tiposEntrada.some((t) => t.padrao) ? 'Tributação padrão da empresa' : 'Sem tributação'}</option>` + tiposEntrada.map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join('');
  const opcCat = (sel) => cat.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');
  return { base, cat, tiposEntrada, opcTipo, opcCat };
}

const opcForma = () => '<option value="">Selecione…</option>' + Object.entries(FORMAS_PGTO).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');

const linhaCompra = (c) => `<tr class="clicavel" data-c="${c.id}"><td>${dataBr(c.emissao)}</td><td>${esc(c.fornecedor_nome)}${c.fornecedor_documento ? `<br><span class="dica">${fmtDoc(c.fornecedor_documento)}</span>` : ''}</td>
  <td>${esc(c.numero ?? '')}${c.origem === 'MANUAL' ? ' <span class="dica">(manual)</span>' : ''}</td><td class="num">${c.itens || ''}</td><td class="num">${brl(c.valor_total)}</td>
  <td>${c.despesas ? `<span class="cor-verde">lançadas (${esc(c.categoria ?? '')})</span>` : '<span class="dica">não lançadas</span>'}</td><td><button data-ver="${c.id}">Abrir</button></td></tr>`;

/** Compras: lançamento (XML ou manual) e consulta das notas num lugar só, com busca por fornecedor, número, CNPJ ou chave. */
async function telaCompras() {
  const est = (telaCompras.est ??= { q: '', de: mesAtual() + '-01', ate: '' });
  if (!est.ate) { const [a, m] = mesAtual().split('-').map(Number); est.ate = `${mesAtual()}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`; }
  const { base, tiposEntrada, opcTipo, opcCat } = await dadosDeEntrada();
  const d = await api('GET', `${base}/compras?de=${est.de}&ate=${est.ate}${est.q ? '&q=' + encodeURIComponent(est.q) : ''}`);
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Compras</h1><p class="sutil">Lance as notas de entrada e consulte o que já foi lançado. Importe o XML da NF-e (cada nota abre com o resumo e o parcelamento para conferir) ou lance a compra manualmente. Para buscar as notas emitidas contra o CNPJ, use <a href="#/nfe-sefaz">Buscar NF-e (SEFAZ)</a>.</p></div>
      <div><button class="primario" id="imp-xml">Importar XML da NF-e</button><input type="file" id="arq-xml" accept=".xml,text/xml,application/xml" multiple hidden>
        <button id="nova-compra">Lançar compra manual</button></div></div>
    <form id="busca-comp" class="grade" style="align-items:end">
      <label class="largo">Buscar <input type="search" name="q" value="${esc(est.q)}" placeholder="Fornecedor, nº da nota, CNPJ ou chave de acesso"></label>
      <label>De <input type="date" name="de" value="${est.de}"></label><label>Até <input type="date" name="ate" value="${est.ate}"></label>
      <div><button class="primario" type="submit">Buscar</button></div></form>
    <div class="resumo">
      <div class="cartao"><div class="sutil">Total no período</div><div class="valor">${compacto(d.total)}</div><div class="dica">${d.compras.length} nota(s)</div></div>
      <div class="cartao"><div class="sutil">Maiores fornecedores</div>${d.fornecedores.length ? d.fornecedores.map((f) => `<div class="dica">${esc(f.nome)} · <strong>${brl(f.total)}</strong></div>`).join('') : '<div class="dica">—</div>'}</div>
    </div>
    ${d.compras.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Emissão</th><th>Fornecedor</th><th>NF</th><th class="num">Itens</th><th class="num">Total</th><th>Despesas</th><th></th></tr></thead><tbody>${d.compras.map(linhaCompra).join('')}</tbody></table></div>`
      : '<div class="vazio">Nenhuma nota encontrada neste período e busca.</div>'}`;
  $('#busca-comp').onsubmit = (e) => { e.preventDefault(); const f = e.target; Object.assign(est, { q: f.q.value.trim(), de: f.de.value || '0000-01-01', ate: f.ate.value || '9999-12-31' }); telaCompras(); };
  conteudo.querySelectorAll('[data-ver]').forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); detalheCompra(Number(b.dataset.ver), telaCompras); }));
  conteudo.querySelectorAll('tr[data-c]').forEach((tr) => (tr.onclick = () => detalheCompra(Number(tr.dataset.c), telaCompras)));
  $('#nova-compra').onclick = () => { location.hash = '#/compra-nova'; };
  $('#imp-xml').onclick = () => $('#arq-xml').click();
  $('#arq-xml').onchange = async (ev) => {
    const arqs = [...ev.target.files]; ev.target.value = '';
    if (!arqs.length) return;
    const resultado = [];
    for (let k = 0; k < arqs.length; k++) {
      const a = arqs[k];
      let xml, pv;
      try { xml = await a.text(); pv = await api('POST', `${base}/compras/previa-xml`, { xml }); }
      catch (err) { resultado.push(`<li class="cor-vermelho">${esc(a.name)}: ${esc(mensagemErro(err))}</li>`); continue; }
      const r = await conferirNotaDialogo({ opc: { tiposEntrada, opcTipo, opcCat }, pv, rotulo: `Nota ${k + 1} de ${arqs.length}`, origem: a.name, ultima: k + 1 === arqs.length,
        enviar: (f, parcelas) => api('POST', `${base}/compras/importar-xml`, { xml, gerarDespesas: f.gerar.checked, categoria: f.categoria.value, tipoDocumentoId: f.tipo?.value ? Number(f.tipo.value) : null, formaPagamento: f.forma.value || null, parcelas }) });
      resultado.push(r.ok ? `<li class="cor-verde">NF ${esc(r.numero)} — ${esc(r.fornecedor)} · ${brl(r.valor)} · ${r.parcelas} parcela(s)</li>` : `<li class="dica">NF ${esc(pv.numero)} — ${esc(pv.fornecedor.nome)}: não importada</li>`);
    }
    abrirDialogo(`<div><h2>Importação concluída</h2><ul class="lista-simples">${resultado.join('')}</ul><div class="acoes"><button class="primario" data-fechar>Fechar</button></div></div>`, () => {});
    telaCompras();
  };
}

/** Conferência de UMA nota: resumo do XML, parcelamento editável, forma de pagamento (obrigatória à vista), importar ou pular. */
function conferirNotaDialogo({ opc, pv, rotulo, origem, ultima, enviar }) {
  return new Promise((fim) => {
    const t = pv.totais;
    const aVistaInicial = pv.parcelas.length === 1 && pv.parcelas[0].vencimento <= pv.emissao;
    abrirDialogo(`<form id="form-nota"><h2>${esc(rotulo)} — NF ${esc(pv.numero)}</h2>
      <p class="sutil">${esc(pv.fornecedor.nome)} · ${fmtDoc(pv.fornecedor.documento)}${pv.fornecedor.municipio ? ' · ' + esc(pv.fornecedor.municipio) + (pv.fornecedor.uf ? '/' + esc(pv.fornecedor.uf) : '') : ''}<br>emitida em ${dataBr(pv.emissao)}${pv.natureza ? ' · ' + esc(pv.natureza) : ''}${origem ? ' · ' + esc(origem) : ''}</p>
      ${pv.bloqueio ? `<div class="banner perigo">${esc(pv.bloqueio)}</div>` : ''}${pv.alertas.map((x) => `<div class="banner teste">⚠ ${esc(x)}</div>`).join('')}
      <dl class="dados"><dt>Produtos</dt><dd>${brl(t.produtos)}</dd>${t.frete + t.seguro ? `<dt>Frete e seguro</dt><dd>${brl(t.frete + t.seguro)}</dd>` : ''}${t.desconto ? `<dt>Desconto</dt><dd>${brl(t.desconto)}</dd>` : ''}${t.ipi ? `<dt>IPI</dt><dd>${brl(t.ipi)}</dd>` : ''}${t.icmsSt ? `<dt>ICMS-ST</dt><dd>${brl(t.icmsSt)}</dd>` : ''}<dt>Total da nota</dt><dd><strong>${brl(t.nf)}</strong></dd></dl>
      <details><summary>${pv.itens.length} item(ns)</summary><div class="rolagem"><table class="tabela"><thead><tr><th>#</th><th>Descrição</th><th>NCM</th><th class="num">Qtd</th><th class="num">Total</th></tr></thead><tbody>
        ${pv.itens.map((i) => `<tr><td>${i.n}</td><td>${esc(i.descricao)}</td><td>${esc(i.ncm ?? '')}</td><td class="num">${String(i.quantidade).replace('.', ',')} ${esc(i.unidade ?? '')}</td><td class="num">${brl(i.valor)}</td></tr>`).join('')}</tbody></table></div></details>
      <div class="grade"><label>Condição de pagamento <select name="condicao"><option value="AVISTA" ${aVistaInicial ? 'selected' : ''}>À vista</option><option value="PARCELADO" ${aVistaInicial ? '' : 'selected'}>Parcelado</option></select></label></div>
      <div id="bloco-parcelas" ${aVistaInicial ? 'hidden' : ''}>
        <h3>Parcelamento ${pv.parcelasDaNota ? 'da nota' : ''}</h3>
        <p class="dica">Se o pagamento real for diferente do informado na nota, altere as datas e os valores. A soma precisa fechar com o total.</p>
        <div id="ed-parc"></div>
      </div>
      <div class="grade"><label class="check largo"><input type="checkbox" name="gerar" checked> Lançar as parcelas nas <strong>despesas</strong>, na data de vencimento</label>
        <label>Categoria da despesa <select name="categoria">${opc.opcCat('Material e equipamentos')}</select></label>
        <label>Forma de pagamento <span class="dica" id="forma-dica"></span><select name="forma">${opcForma()}</select></label>
        ${opc.tiposEntrada.length ? `<label>Tributação <select name="tipo">${opc.opcTipo()}</select></label>` : ''}</div>
      <p class="erro" id="erro-nota"></p>
      <div class="acoes"><button class="primario" type="submit" ${pv.bloqueio ? 'disabled' : ''}>Importar esta nota</button><button type="button" id="pular">${ultima ? 'Cancelar' : 'Pular'}</button></div></form>`, (dlg) => {
      const f = dlg.querySelector('#form-nota');
      let ed;
      const aVista = () => f.condicao.value === 'AVISTA';
      const obrigatoria = () => f.gerar.checked && (aVista() || ed?.aVista(pv.emissao));
      const atualizar = () => { const o = obrigatoria(); f.forma.required = !!o; dlg.querySelector('#forma-dica').textContent = o ? '(obrigatória)' : '(opcional)'; };
      ed = editorParcelas(dlg.querySelector('#ed-parc'), pv.parcelas, t.nf, pv.emissao, atualizar);
      f.condicao.onchange = () => { dlg.querySelector('#bloco-parcelas').hidden = aVista(); if (!aVista() && ed.aVista(pv.emissao)) ed.parcelar(pv.emissao, 2, 30); atualizar(); };
      f.gerar.onchange = atualizar; atualizar();
      let feito = false; const sair = (v) => { if (!feito) { feito = true; fim(v); } };
      dlg.addEventListener('close', () => sair({ ok: false }));
      dlg.querySelector('#pular').onclick = () => { sair({ ok: false }); dlg.close(); };
      f.onsubmit = async (e2) => {
        e2.preventDefault();
        if (!aVista() && !ed.fecha()) { $('#erro-nota').textContent = 'A soma das parcelas precisa fechar com o total da nota.'; return; }
        if (obrigatoria() && !f.forma.value) { $('#erro-nota').textContent = 'Compra à vista: selecione a forma de pagamento.'; f.forma.focus(); return; }
        try {
          const parcelas = aVista() ? [{ vencimento: pv.emissao, valor: t.nf }] : ed.ler();
          const r = await enviar(f, parcelas);
          const x = r.resultados ? r.resultados[0] : r;
          if (x.ok === false) { $('#erro-nota').textContent = x.mensagem; return; }
          sair({ ok: true, numero: x.numero ?? pv.numero, fornecedor: x.fornecedor ?? pv.fornecedor.nome, valor: x.valor ?? t.nf, parcelas: parcelas.length, compraId: x.compraId ?? x.id, alertas: x.alertas ?? [] }); dlg.close();
        } catch (err) { $('#erro-nota').textContent = mensagemErro(err); }
      };
    });
  });
}

/** Lançamento manual de compra (cupom, recibo, nota sem XML): fornecedor com consulta F2 e busca de CNPJ, parcelamento e forma de pagamento. */
async function telaCompraManual() {
  const { base, tiposEntrada, opcTipo, opcCat } = await dadosDeEntrada();
  const fornecedores = (await api('GET', `${base}/compras/fornecedores`).catch(() => [])).map((x, i) => ({ id: i, nome: x.nome, documento: x.documento, email: '' }));
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  conteudo.innerHTML = `<div class="topo"><div><h1>Lançar compra manual</h1><p class="sutil">Para compra sem XML (cupom, recibo, nota de papel). <span class="dica">Dica: F2 consulta os fornecedores já lançados.</span></p></div>
      <div><button type="button" id="voltar-compras">Voltar para Compras</button></div></div>
    <form id="form-comp">
      <datalist id="lista-forn">${fornecedores.map((x) => `<option value="${esc(x.nome)}">`).join('')}</datalist>
      <div class="grade">
        <label class="largo">Fornecedor <span class="dica">(digite para buscar · F2 abre a consulta)</span><input name="nome" list="lista-forn" required maxlength="120" autocomplete="off"></label>
        <label>CNPJ / CPF <span class="linha-campo"><input name="documento" maxlength="20"><button type="button" data-buscar-cnpj>Buscar CNPJ</button></span><span class="dica" data-cnpj-info>Se o fornecedor ainda não foi lançado, a busca na Receita preenche o nome.</span></label>
        <label>Nº da nota/documento <input name="nf_numero" maxlength="30"></label>
        <label>Data da compra <input type="date" name="emissao" required value="${hoje}"></label>
        <label>Valor total (R$) <input name="valor_total" data-num inputmode="decimal" required></label>
        <label>Categoria <select name="categoria">${opcCat('Material e equipamentos')}</select></label>
        <label>Condição de pagamento <select name="condicao"><option value="AVISTA">À vista</option><option value="PARCELADO">Parcelado</option></select></label>
        <label>Forma de pagamento <span class="dica" id="forma-dica"></span><select name="forma">${opcForma()}</select></label>
        ${tiposEntrada.length ? `<label>Tributação <select name="tipo">${opcTipo()}</select></label>` : ''}
        <label class="largo">Observação <input name="observacao" maxlength="300"></label>
      </div>
      <div id="bloco-parcelas" hidden>
        <h3>Parcelamento</h3>
        <p class="dica">Use <em>Refazer em N parcelas</em> ou edite as datas e os valores. A soma precisa fechar com o valor total.</p>
        <div id="ed-parc"></div>
      </div>
      <label class="check"><input type="checkbox" name="gerar" checked> Lançar as parcelas nas despesas</label>
      <p class="erro" id="erro-comp"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar compra</button><button type="button" id="cancelar-comp">Cancelar</button></div></form>`;
  const f = $('#form-comp');
  $('#voltar-compras').onclick = $('#cancelar-comp').onclick = () => { location.hash = '#/compras'; };
  // fornecedor: F2, lista de digitação e CNPJ (preenche os campos vazios)
  const noFake = { set value(i) { const x = fornecedores[Number(i)]; if (x) { f.nome.value = x.nome; f.documento.value = x.documento ? fmtDoc(x.documento) : ''; } }, dispatchEvent() {}, focus() { f.nome.focus(); } };
  habilitarConsultaF2(f, noFake, fornecedores, 'Consultar fornecedor');
  f.nome.addEventListener('change', () => { const x = fornecedores.find((y) => y.nome === f.nome.value); if (x && !f.documento.value.trim() && x.documento) f.documento.value = fmtDoc(x.documento); });
  f.documento.addEventListener('blur', () => {
    const dig = f.documento.value.replace(/\D/g, ''), x = dig && fornecedores.find((y) => String(y.documento ?? '').replace(/\D/g, '') === dig);
    if (x && !f.nome.value.trim()) f.nome.value = x.nome;
  });
  ligarConsultaCnpj(f, 'fornecedor');
  // parcelamento
  const total = () => numero(f.valor_total.value) ?? 0;
  const ed = editorParcelas($('#ed-parc'), [{ vencimento: hoje, valor: 0 }], total, hoje, () => atualizarForma());
  const aVista = () => f.condicao.value === 'AVISTA';
  function atualizarForma() { const o = f.gerar.checked && (aVista() || ed.aVista(f.emissao.value)); f.forma.required = !!o; $('#forma-dica').textContent = o ? '(obrigatória)' : '(opcional)'; }
  f.valor_total.addEventListener('input', () => { ed.recalcular(aVista() ? f.emissao.value : undefined); atualizarForma(); });
  f.emissao.addEventListener('change', () => { ed.recalcular(aVista() ? f.emissao.value : undefined); atualizarForma(); });
  f.condicao.onchange = () => {
    $('#bloco-parcelas').hidden = aVista();
    if (aVista()) ed.recalcular(f.emissao.value); else ed.parcelar(f.emissao.value, 2, 30);
    atualizarForma();
  };
  f.gerar.onchange = atualizarForma; atualizarForma();
  f.onsubmit = async (e) => {
    e.preventDefault(); const v = lerForm(f);
    if (!aVista() && !ed.fecha()) { $('#erro-comp').textContent = 'A soma das parcelas precisa fechar com o valor total.'; return; }
    if (f.forma.required && !f.forma.value) { $('#erro-comp').textContent = 'Compra à vista: selecione a forma de pagamento.'; f.forma.focus(); return; }
    try {
      await api('POST', `${base}/compras`, { fornecedor_nome: v.nome, fornecedor_documento: v.documento, numero: v.nf_numero, emissao: v.emissao, valor_total: v.valor_total, observacao: v.observacao, gerarDespesas: v.gerar, categoria: v.categoria, tipoDocumentoId: v.tipo ? Number(v.tipo) : null, formaPagamento: v.forma || null, parcelas: aVista() ? [{ vencimento: v.emissao, valor: v.valor_total }] : ed.ler() });
      aviso('Compra lançada.'); location.hash = '#/compras';
    } catch (err) { $('#erro-comp').textContent = mensagemErro(err); }
  };
}

// ---------------------------------------------------------------------------
// Compras: NF-e emitidas contra o CNPJ, direto da SEFAZ (Distribuição DF-e)
// ---------------------------------------------------------------------------
/** Busca das NF-e emitidas contra o CNPJ direto na SEFAZ; a importação passa pela conferência nota a nota. */
async function telaNfeSefaz() {
  const opc = await dadosDeEntrada();
  conteudo.innerHTML = `<div class="topo"><div><h1>Buscar NF-e (SEFAZ)</h1><p class="sutil">Notas fiscais emitidas contra o CNPJ desta empresa, direto do Ambiente Nacional. Ao importar, cada nota abre com o resumo e o parcelamento para você conferir. As notas importadas ficam em <a href="#/compras">Notas de compra</a>.</p></div></div>
    <div id="painel-sefaz"></div>`;
  painelSefaz(opc.base, opc);
}

const SIT_SEFAZ = {
  PRONTA: 'Pronta para importar', NOVA: 'Ciência pendente', AGUARDANDO_XML: 'Aguardando XML', CIENCIA_RECUSADA: 'Ciência recusada',
  CANCELADA: 'Cancelada pelo fornecedor', CANCELADA_IMPORTADA: 'Cancelada após importar', IMPORTADA: 'Importada', DENEGADA: 'Denegada',
};
const dataHoraBr = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const horaBr = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

async function painelSefaz(base, opc) {
  const el = $('#painel-sefaz');
  if (!el) return;
  const url = `${base}/compras/sefaz`;
  const adm = estado.usuario?.tipo === 'adm';
  painelSefaz.todas ??= false;
  let d;
  try { d = await api('GET', `${url}${painelSefaz.todas ? '?todas=1' : ''}`); } catch (e) { el.innerHTML = `<p class="dica erro">${esc(mensagemErro(e))}</p>`; return; }
  if (!$('#painel-sefaz')) return; // usuário trocou de tela
  if (!d.temCertificado) {
    el.innerHTML = `<div class="cartao sefaz"><h2>Notas na SEFAZ</h2><p class="dica">Para o sistema buscar sozinho as NF-e emitidas contra o CNPJ desta empresa, cadastre o certificado digital A1 em <a href="#/empresas">Empresas</a>.</p></div>`;
    return;
  }
  const situacao = !d.iniciada
    ? 'Ainda não buscado. Ao buscar, o sistema registra a <strong>Ciência da Operação</strong> de cada nota nova, que libera o XML completo na SEFAZ.'
    : `Última busca ${dataHoraBr(d.ultimaConsulta) || '—'}${d.ultimoResultado ? `: ${esc(d.ultimoResultado)}` : ''}.${d.proximaConsulta ? ` A SEFAZ libera nova consulta às ${horaBr(d.proximaConsulta)}.` : ''}`;
  const erroRecente = d.ultimoErro && (!d.ultimaConsulta || d.ultimoErro.quando > d.ultimaConsulta) ? d.ultimoErro : null;
  const ORDEM = { CANCELADA_IMPORTADA: 0, PRONTA: 1, CIENCIA_RECUSADA: 2, NOVA: 3, AGUARDANDO_XML: 4, IMPORTADA: 5, CANCELADA: 6, DENEGADA: 7 };
  d.notas.sort((a, b) => ORDEM[a.status] - ORDEM[b.status] || String(b.emissao).localeCompare(String(a.emissao)));
  const selecionaveis = d.notas.filter((n) => n.status === 'PRONTA');
  const linha = (n) => `<tr data-ch="${n.chave}">
      <td>${n.status === 'PRONTA' ? `<input type="checkbox" class="sel-sefaz" value="${n.chave}" aria-label="Selecionar NF ${esc(n.numero ?? '')}">` : ''}</td>
      <td>${dataBr(n.emissao)}</td>
      <td>${esc(n.emitente_nome ?? '—')}${n.emitente_documento ? `<br><span class="dica">${fmtDoc(n.emitente_documento)}</span>` : ''}</td>
      <td>${esc(n.numero ?? '')}${n.serie ? `<span class="dica"> série ${esc(n.serie)}</span>` : ''}</td>
      <td class="num">${n.valor != null ? brl(n.valor) : '—'}</td>
      <td><span class="carimbo ${n.status}" ${n.ciencia_erro ? `title="${esc(n.ciencia_erro)}"` : ''}>${SIT_SEFAZ[n.status]}</span>${n.status === 'CIENCIA_RECUSADA' ? `<br><span class="dica">${esc(n.ciencia_erro)}</span>` : ''}</td>
      <td class="acoes-linha">${n.status === 'PRONTA' ? `<button class="primario" data-imp="${n.chave}">Importar</button>` : ''}${n.compra_id ? `<button data-abrir="${n.compra_id}">Abrir compra</button>` : ''}${n.tem_xml ? `<button data-xml="${n.chave}">XML</button>` : ''}${n.status === 'CIENCIA_RECUSADA' ? `<button data-ciencia="${n.chave}">Reenviar ciência</button>` : ''}${!n.compra_id ? `<button data-ocultar="${n.chave}" data-v="${n.oculta ? 0 : 1}" title="${n.oculta ? 'Voltar a mostrar' : 'Esconder esta nota (ex.: não é compra da empresa)'}">${n.oculta ? 'Mostrar' : 'Ocultar'}</button>` : ''}</td></tr>`;
  el.innerHTML = `<div class="cartao sefaz">
    <div class="sefaz-topo"><div><h2>Notas na SEFAZ</h2><p class="dica">${situacao}</p></div>
      <div class="sefaz-acoes"><button class="primario" id="sefaz-buscar">Buscar agora</button><button id="sefaz-chave">Buscar pela chave</button>
        <label class="check"><input type="checkbox" id="sefaz-auto" ${d.automatica ? 'checked' : ''}> Buscar automaticamente</label>
        ${adm ? '<button id="sefaz-conexao" title="Cadeia de certificados ICP-Brasil">Conexão com a SEFAZ</button>' : ''}</div></div>
    ${erroRecente ? `<div class="banner perigo">Erro na última busca (${dataHoraBr(erroRecente.quando)}): ${esc(erroRecente.mensagem)}</div>` : ''}
    ${d.contagem.canceladasImportadas ? `<div class="banner perigo"><strong>Atenção:</strong> ${d.contagem.canceladasImportadas} nota(s) já importada(s) em Compras foi(ram) <strong>cancelada(s) pelo fornecedor</strong>. Confira a compra e as despesas lançadas.</div>` : ''}
    ${d.notas.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>${selecionaveis.length ? '<input type="checkbox" id="sel-todas-sefaz" aria-label="Selecionar todas">' : ''}</th><th>Emissão</th><th>Fornecedor</th><th>NF</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead>
      <tbody>${d.notas.map(linha).join('')}</tbody></table></div>`
      : `<p class="dica">${d.iniciada ? 'Nenhuma nota pendente de importação.' : ''}</p>`}
    <div class="acoes">${selecionaveis.length ? `<button class="primario" id="sefaz-importar" disabled>Importar selecionadas</button>` : ''}
      <button id="sefaz-todas">${painelSefaz.todas ? 'Mostrar só as pendentes' : 'Mostrar também importadas e ocultas'}</button>
      ${d.contagem.aguardando ? `<span class="dica">${d.contagem.aguardando} nota(s) aguardando o XML completo: ele chega numa próxima busca (a SEFAZ libera depois da ciência).</span>` : ''}</div>
  </div>`;

  const recarregar = () => painelSefaz(base, opc);
  const btImp = $('#sefaz-importar');
  const marcadas = () => [...el.querySelectorAll('.sel-sefaz:checked')].map((c) => c.value);
  const atualizarBotao = () => { if (btImp) { const n = marcadas().length; btImp.disabled = !n; btImp.textContent = n ? `Importar selecionadas (${n})` : 'Importar selecionadas'; } };
  el.querySelectorAll('.sel-sefaz').forEach((c) => (c.onchange = atualizarBotao));
  const todasCb = $('#sel-todas-sefaz');
  if (todasCb) todasCb.onchange = () => { el.querySelectorAll('.sel-sefaz').forEach((c) => (c.checked = todasCb.checked)); atualizarBotao(); };
  if (btImp) btImp.onclick = () => importarDaSefaz(base, marcadas(), opc, recarregar);
  el.querySelectorAll('[data-imp]').forEach((b) => (b.onclick = () => importarDaSefaz(base, [b.dataset.imp], opc, recarregar)));
  el.querySelectorAll('[data-abrir]').forEach((b) => (b.onclick = () => detalheCompra(Number(b.dataset.abrir), telaNfeSefaz)));
  el.querySelectorAll('[data-xml]').forEach((b) => (b.onclick = () => baixar(`${url}/xml/${b.dataset.xml}`, `NFe-${b.dataset.xml}.xml`)));
  el.querySelectorAll('[data-ocultar]').forEach((b) => (b.onclick = async () => {
    try { await api('POST', `${url}/ocultar`, { chave: b.dataset.ocultar, oculta: b.dataset.v === '1' }); recarregar(); } catch (e) { aviso(mensagemErro(e)); }
  }));
  el.querySelectorAll('[data-ciencia]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { const r = await api('POST', `${url}/ciencia`, { chaves: [b.dataset.ciencia] }); aviso(r.ciencias ? 'Ciência registrada. O XML completo chega numa próxima busca.' : 'A SEFAZ recusou de novo a ciência desta nota.'); recarregar(); }
    catch (e) { tratarErroSefaz(e, recarregar); b.disabled = false; }
  }));
  $('#sefaz-todas').onclick = () => { painelSefaz.todas = !painelSefaz.todas; recarregar(); };
  $('#sefaz-auto').onchange = async (e) => {
    try { await api('PUT', `${url}/config`, { automatica: e.target.checked }); aviso(e.target.checked ? 'Busca automática ligada: o sistema consulta a SEFAZ sozinho, respeitando o intervalo de 1 hora.' : 'Busca automática desligada.'); }
    catch (err) { e.target.checked = !e.target.checked; aviso(mensagemErro(err)); }
  };
  $('#sefaz-conexao')?.addEventListener('click', () => dialogoConexaoSefaz(recarregar));
  $('#sefaz-buscar').onclick = async (e) => {
    const b = e.target; b.disabled = true; b.textContent = 'Buscando…';
    try {
      const r = await api('POST', `${url}/buscar`);
      aviso(r.consultou ? `SEFAZ: ${r.resumo}.` : `A SEFAZ só libera nova consulta às ${horaBr(r.proximaConsulta)} (intervalo de 1 hora).${r.ciencias ? ` Ciência registrada em ${r.ciencias} nota(s).` : ''}`);
      recarregar();
    } catch (err) { tratarErroSefaz(err, recarregar); b.disabled = false; b.textContent = 'Buscar agora'; }
  };
  $('#sefaz-chave').onclick = () => abrirDialogo(`<form id="form-chave"><h2>Buscar NF-e pela chave</h2>
      <p class="dica">Para uma nota específica que o fornecedor avisou. A empresa precisa ser a destinatária.</p>
      <label>Chave de acesso (44 dígitos) <input name="chave" required inputmode="numeric" autocomplete="off" placeholder="0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000"></label>
      <p class="erro" id="erro-chave"></p>
      <div class="acoes"><button class="primario" type="submit">Buscar</button><button type="button" data-fechar>Cancelar</button></div></form>`, (dlg) => {
    dlg.querySelector('#form-chave').onsubmit = async (ev) => {
      ev.preventDefault();
      const chave = ev.target.chave.value.replace(/\D/g, '');
      if (chave.length !== 44) { $('#erro-chave').textContent = `A chave tem ${chave.length} dígito(s); são 44.`; return; }
      const bt = ev.target.querySelector('[type=submit]'); bt.disabled = true; bt.textContent = 'Buscando…';
      try {
        const r = await api('POST', `${url}/chave`, { chave });
        dlg.close();
        aviso(r.nota ? `NF ${r.nota.numero} — ${r.nota.emitente_nome ?? ''}: ${SIT_SEFAZ[r.nota.status]}.` : 'Consulta feita.');
        painelSefaz.todas = r.nota?.status === 'IMPORTADA'; recarregar();
      } catch (err) {
        if (err.detalhes?.cadeia) { dlg.close(); tratarErroSefaz(err, recarregar); return; }
        $('#erro-chave').textContent = mensagemErro(err); bt.disabled = false; bt.textContent = 'Buscar';
      }
    };
  });
}

function tratarErroSefaz(err, depois) {
  if (!err.detalhes?.cadeia) { aviso(mensagemErro(err)); return; }
  if (estado.usuario?.tipo === 'adm') dialogoConexaoSefaz(depois, err.message);
  else aviso(`${err.message} Peça ao administrador do sistema.`);
}

async function importarDaSefaz(base, chaves, opc, depois) {
  if (!chaves.length) return;
  const resultado = [];
  for (let k = 0; k < chaves.length; k++) {
    let pv;
    try { pv = await api('GET', `${base}/compras/sefaz/previa/${chaves[k]}`); }
    catch (err) { resultado.push(`<li class="cor-vermelho">${esc(chaves[k])}: ${esc(mensagemErro(err))}</li>`); continue; }
    const r = await conferirNotaDialogo({ opc, pv, rotulo: `Nota ${k + 1} de ${chaves.length}`, origem: 'SEFAZ', ultima: k + 1 === chaves.length,
      enviar: (f, parcelas) => api('POST', `${base}/compras/sefaz/importar`, { chaves: [chaves[k]], gerarDespesas: f.gerar.checked, categoria: f.categoria.value, tipoDocumentoId: f.tipo?.value ? Number(f.tipo.value) : null, formaPagamento: f.forma.value || null, parcelas }) });
    resultado.push(r.ok ? `<li class="cor-verde">NF ${esc(r.numero)} — ${esc(r.fornecedor)} · ${brl(r.valor)} · ${r.parcelas} parcela(s)${r.alertas.map((a) => `<br><span class="aviso-txt">⚠ ${esc(a)}</span>`).join('')}</li>` : `<li class="dica">NF ${esc(pv.numero)} — ${esc(pv.fornecedor.nome)}: não importada</li>`);
  }
  abrirDialogo(`<div><h2>Importação concluída</h2><ul class="lista-simples">${resultado.join('')}</ul><div class="acoes"><button class="primario" data-fechar>Fechar</button></div></div>`, () => {});
  depois?.();
}

/** Administrador: cadeia ICP-Brasil usada só na conexão com a SEFAZ. */
async function dialogoConexaoSefaz(depois, motivo) {
  let s;
  try { s = await api('GET', '/api/sefaz/conexao'); } catch (e) { aviso(mensagemErro(e)); return; }
  const embRaizes = s.embutida.filter((c) => c.tipo === 'raiz').map((c) => c.nome.replace('Autoridade Certificadora Raiz Brasileira ', ''));
  const embAcs = s.embutida.filter((c) => c.tipo !== 'raiz').map((c) => c.nome.replace('Autoridade Certificadora do ', 'AC '));
  abrirDialogo(`<div class="conexao-sefaz"><h2>Conexão com a SEFAZ</h2>
    ${motivo ? `<div class="banner perigo">${esc(motivo)}</div>` : ''}
    <p class="sutil">O servidor da SEFAZ usa certificado da <strong>ICP-Brasil</strong>, que o Windows nem sempre reconhece. O sistema já traz essa cadeia embutida e a usa só na conexão com a SEFAZ.</p>
    <dl class="dados"><dt>Embutida no sistema</dt><dd><span class="cor-verde">raízes ${embRaizes.map(esc).join(', ')}</span><br><span class="dica">e as ACs SSL dos servidores da SEFAZ: ${embAcs.map(esc).join(', ')}</span></dd>
      <dt>Adicionais guardados</dt><dd>${s.cadeiaIcp ? `${s.cadeiaIcp} certificado(s)` : '<span class="dica">nenhum (normalmente não é preciso)</span>'}</dd>
      <dt>Verificar o servidor</dt><dd>${s.verificarServidor ? '<span class="cor-verde">ligado (recomendado)</span>' : '<span class="cor-vermelho">desligado</span>'}</dd></dl>
    <h3>Se a SEFAZ trocar de certificado</h3>
    <p class="dica">Só é preciso se a busca avisar que não reconhece o certificado do servidor (por exemplo, quando a SEFAZ passa a usar uma AC nova).</p>
    <button id="cx-baixar" class="primario">Atualizar pelo site do ITI</button>
    <p class="dica">Baixa o pacote oficial de ACs da ICP-Brasil e guarda só os certificados que encadeiam até as raízes acima.</p>
    <h3>Ou enviar o arquivo</h3>
    <p class="dica">Se a atualização automática falhar, baixe pelo navegador o pacote <a href="${esc(s.urlPacote)}" target="_blank" rel="noopener">ACcompactado.zip</a> (ou as raízes em <a href="${esc(s.urlRepositorio)}" target="_blank" rel="noopener">Repositório AC-Raiz do ITI</a>) e envie aqui. Aceita .zip, .crt, .cer, .pem e .p7b.</p>
    <input type="file" id="cx-arq" accept=".zip,.crt,.cer,.pem,.p7b,.p7c">
    <h3>Último recurso</h3>
    <label class="check"><input type="checkbox" id="cx-verificar" ${s.verificarServidor ? '' : 'checked'}> <span>Conectar <strong>sem verificar</strong> o certificado do servidor da SEFAZ (não recomendado; a conexão continua criptografada)</span></label>
    <p class="erro" id="cx-erro"></p>
    <div class="acoes">${s.cadeiaIcp ? '<button id="cx-apagar">Apagar adicionais</button>' : ''}<button data-fechar>Fechar</button></div></div>`, (dlg) => {
    const reabrir = (msg) => { dlg.close(); aviso(msg); dialogoConexaoSefaz(depois); depois?.(); };
    const erro = (e) => { $('#cx-erro').textContent = mensagemErro(e); };
    $('#cx-baixar').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Baixando…';
      try { const r = await api('POST', '/api/sefaz/conexao/baixar-cadeia'); reabrir(r.guardados ? `${r.guardados} certificado(s) novo(s) guardado(s) do pacote do ITI. Tente buscar de novo.` : `Pacote do ITI conferido (${r.lidos} certificados): nada novo para acrescentar.`); }
      catch (err) { erro(err); e.target.disabled = false; e.target.textContent = 'Atualizar pelo site do ITI'; }
    };
    $('#cx-arq').onchange = async (e) => {
      const arq = e.target.files[0]; if (!arq) return;
      const fd = new FormData(); fd.append('arquivo', arq);
      try { const r = await api('POST', '/api/sefaz/conexao/cadeia', fd); reabrir(`${r.lidos} certificado(s) lido(s); cadeia com ${r.cadeiaIcp}. Tente buscar de novo.`); }
      catch (err) { erro(err); e.target.value = ''; }
    };
    $('#cx-verificar').onchange = async (e) => {
      if (e.target.checked && !confirm('Desligar a verificação do servidor da SEFAZ? Use só se a cadeia ICP-Brasil não puder ser instalada.')) { e.target.checked = false; return; }
      try { await api('PUT', '/api/sefaz/conexao', { verificarServidor: !e.target.checked }); reabrir(e.target.checked ? 'Verificação do servidor desligada.' : 'Verificação do servidor ligada.'); }
      catch (err) { erro(err); e.target.checked = !e.target.checked; }
    };
    $('#cx-apagar')?.addEventListener('click', async () => {
      if (!confirm('Apagar os certificados adicionais guardados? A cadeia embutida no sistema continua valendo.')) return;
      try { await api('DELETE', '/api/sefaz/conexao/cadeia'); reabrir('Certificados adicionais apagados.'); } catch (err) { erro(err); }
    });
  });
}

async function detalheCompra(id, voltar) {
  const c = await api('GET', `/api/compras/${id}`);
  abrirDialogo(`<div class="detalhe-compra"><h2>NF ${esc(c.numero ?? '')} — ${esc(c.fornecedor_nome)}</h2>
    <p class="sutil">${c.fornecedor_documento ? fmtDoc(c.fornecedor_documento) + ' · ' : ''}emitida em ${dataBr(c.emissao)}${c.natureza ? ' · ' + esc(c.natureza) : ''}${c.origem === 'MANUAL' ? ' · lançamento manual' : ''}</p>
    ${c.chave_acesso ? `<p class="dica">Chave de acesso: ${esc(c.chave_acesso)}</p>` : ''}${c.observacao ? `<p>${esc(c.observacao)}</p>` : ''}
    ${c.itens.length ? `<h3>Itens</h3><div class="rolagem"><table class="tabela"><thead><tr><th>#</th><th>Descrição</th><th>NCM</th><th class="num">Qtd</th><th class="num">Unitário</th><th class="num">Total</th></tr></thead><tbody>
      ${c.itens.map((i) => `<tr><td>${i.n_item}</td><td>${esc(i.descricao)}${i.codigo ? `<br><span class="dica">cód. ${esc(i.codigo)}</span>` : ''}</td><td>${esc(i.ncm ?? '')}</td><td class="num">${String(i.quantidade).replace('.', ',')} ${esc(i.unidade ?? '')}</td><td class="num">${brl(i.valor_unitario)}</td><td class="num">${brl(i.valor_total)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <h3>Totais</h3><dl class="dados"><dt>Produtos</dt><dd>${brl(c.valor_produtos)}</dd>${c.valor_frete ? `<dt>Frete e seguro</dt><dd>${brl(c.valor_frete)}</dd>` : ''}${c.valor_outras ? `<dt>Outras despesas</dt><dd>${brl(c.valor_outras)}</dd>` : ''}${c.valor_desconto ? `<dt>Desconto</dt><dd>${brl(c.valor_desconto)}</dd>` : ''}${c.valor_icms ? `<dt>ICMS</dt><dd>${brl(c.valor_icms)}</dd>` : ''}${c.valor_ipi ? `<dt>IPI</dt><dd>${brl(c.valor_ipi)}</dd>` : ''}<dt>Total da nota</dt><dd><strong>${brl(c.valor_total)}</strong></dd></dl>
    <h3>Parcelas</h3><table class="tabela"><thead><tr><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th><th>Despesa</th></tr></thead><tbody>
      ${c.parcelas.map((p) => `<tr><td>${esc(p.numero ?? '')}</td><td>${dataBr(p.vencimento)}</td><td class="num">${brl(p.valor)}</td><td>${p.despesa_id ? 'lançada' : '<span class="dica">não lançada</span>'}</td></tr>`).join('')}</tbody></table>
    <div class="acoes"><button id="c-parcelas">Alterar parcelas</button>${c.tem_xml ? '<button id="c-xml">Baixar XML</button>' : ''}${podeExcluirRegistros() ? '<button class="perigo" id="c-excluir">Excluir compra</button>' : ''}<button data-fechar>Fechar</button></div></div>`, (dlg) => {
    dlg.querySelector('#c-parcelas')?.addEventListener('click', () => {
      dlg.close();
      abrirDialogo(`<form id="form-parc"><h2>Alterar parcelas — NF ${esc(c.numero ?? '')}</h2>
        <p class="dica">Ajuste datas e valores conforme o pagamento real. As despesas geradas pela compra acompanham. A soma precisa fechar com o total (${brl(c.valor_total)}).</p>
        <div id="ed-parc"></div><p class="erro" id="erro-parc"></p>
        <div class="acoes"><button class="primario" type="submit">Salvar parcelas</button><button type="button" data-fechar>Cancelar</button></div></form>`, (d2) => {
        const ed = editorParcelas(d2.querySelector('#ed-parc'), c.parcelas, c.valor_total, c.emissao);
        d2.querySelector('#form-parc').onsubmit = async (e) => {
          e.preventDefault();
          if (!ed.fecha()) { $('#erro-parc').textContent = 'A soma das parcelas precisa fechar com o total da nota.'; return; }
          try { await api('PUT', `/api/compras/${id}/parcelas`, { parcelas: ed.ler() }); d2.close(); aviso('Parcelas atualizadas.'); voltar(); }
          catch (err) { $('#erro-parc').textContent = mensagemErro(err); }
        };
      });
    });
    dlg.querySelector('#c-xml')?.addEventListener('click', () => baixar(`/api/compras/${id}/xml`, `NFe_${c.numero ?? id}.xml`));
    dlg.querySelector('#c-excluir')?.addEventListener('click', async () => {
      if (!confirm('Excluir esta compra? As despesas que ela gerou também serão apagadas. Não dá para desfazer.')) return;
      try { await api('DELETE', `/api/compras/${id}`); dlg.close(); aviso('Compra excluída.'); voltar(); } catch (e) { aviso(mensagemErro(e)); }
    });
  });
}

// ---------------------------------------------------------------------------
// Despesas e balanço
// ---------------------------------------------------------------------------
async function telaDocumentacao() {
  const { MANUAL, MANUAL_VERSAO } = await import('/manual.js');
  const est = (telaDocumentacao.est ??= { topico: MANUAL[0].id, busca: '' });
  const textoPuro = (t) => (t.titulo + ' ' + t.resumo + ' ' + t.corpo.replace(/<[^>]+>/g, ' ')).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Relatórios</h1><p class="sutil">Manual de uso do sistema (versão ${MANUAL_VERSAO}).</p></div></div>
    <nav class="abas" aria-label="Relatórios"><a href="#/relatorios">Relatórios</a><a href="#/relatorios/documentacao" class="ativo">Documentação</a></nav>
    <div class="manual">
      <aside class="manual-indice">
        <input type="search" id="man-busca" placeholder="Pesquisar no manual" autocomplete="off" value="${esc(est.busca)}">
        <div id="man-lista"></div>
        <button type="button" id="man-imprimir">Imprimir / salvar em PDF</button>
      </aside>
      <article class="manual-corpo" id="man-corpo"></article>
    </div>`;
  const pintar = () => {
    const q = est.busca.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const achados = MANUAL.filter((t) => !q || textoPuro(t).includes(q));
    if (!achados.some((t) => t.id === est.topico) && achados[0]) est.topico = achados[0].id;
    $('#man-lista').innerHTML = achados.length
      ? achados.map((t) => `<a href="#" data-t="${t.id}" class="${t.id === est.topico ? 'ativo' : ''}"><strong>${esc(t.titulo)}</strong><span>${esc(t.resumo)}</span></a>`).join('')
      : '<p class="dica">Nada encontrado.</p>';
    $('#man-lista').querySelectorAll('[data-t]').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); est.topico = a.dataset.t; pintar(); $('#man-corpo').scrollIntoView({ block: 'start' }); }));
    const t = MANUAL.find((x) => x.id === est.topico);
    $('#man-corpo').innerHTML = t ? `<h2>${esc(t.titulo)}</h2><p class="sutil">${esc(t.resumo)}</p>${t.corpo}` : '';
  };
  $('#man-busca').oninput = (ev) => { est.busca = ev.target.value; pintar(); };
  $('#man-imprimir').onclick = () => {
    const t = MANUAL.find((x) => x.id === est.topico);
    const box = $('#man-corpo'); const antes = box.innerHTML;
    box.innerHTML = `<h1>Manual do Kontor Gestão Empresas — versão ${MANUAL_VERSAO}</h1>` + MANUAL.map((x) => `<section><h2>${esc(x.titulo)}</h2>${x.corpo}</section>`).join('');
    document.body.classList.add('imprimindo-manual');
    const voltar = () => { document.body.classList.remove('imprimindo-manual'); box.innerHTML = antes; window.removeEventListener('afterprint', voltar); };
    window.addEventListener('afterprint', voltar); setTimeout(() => window.print(), 50);
  };
  pintar();
}

const GRUPOS_REL = ['Faturamento', 'Contas a receber', 'Despesas e pagamentos', 'Fiscal e retenções', 'Resultado e caixa', 'Clientes'];
async function telaRelatorios(aba) {
  if (aba === 'documentacao') return telaDocumentacao();
  const cat = await api('GET', '/api/relatorios');
  const ini = mesAtual() + '-01', fim = new Date(Date.UTC(+mesAtual().slice(0, 4), +mesAtual().slice(5), 0)).toISOString().slice(0, 10);
  const est = telaRelatorios.est ??= { rel: cat[0].id, de: ini, ate: fim, tomadorId: '', situacao: '' };
  const clientes = await api('GET', `/api/empresas/${estado.empresaId}/tomadores`).catch(() => []);
  const fmtCel = (v, t) => (v == null || v === '' ? '' : t === 'moeda' ? brl(v) : t === 'data' ? dataBr(v) : esc(String(v)));
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Relatórios</h1><p class="sutil">A nota e o boleto têm datas diferentes (emissão, vencimento, pagamento). Cada relatório diz qual data usa no filtro e mostra as outras nas colunas.</p></div></div>
    <nav class="abas" aria-label="Relatórios"><a href="#/relatorios" class="ativo">Relatórios</a><a href="#/relatorios/documentacao">Documentação</a></nav>
    <div class="rel-layout">
    <nav class="rel-grupos" aria-label="Tipos de relatório">${GRUPOS_REL.filter((g) => cat.some((c) => c.grupo === g)).map((g) => `<details class="grupo" ${cat.some((c) => c.grupo === g && c.id === est.rel) ? 'open' : ''}><summary>${esc(g)} <span class="dica">${cat.filter((c) => c.grupo === g).length}</span></summary>
      ${cat.filter((c) => c.grupo === g).map((c) => `<a href="#" data-rel="${c.id}" class="${c.id === est.rel ? 'ativo' : ''}">${esc(c.titulo)}</a>`).join('')}</details>`).join('')}</nav>
    <div class="rel-corpo">
    <form id="form-rel" class="filtros grade">
      <input type="hidden" name="rel" value="${esc(est.rel)}">
      <div class="largo"><strong id="tit-rel"></strong><span class="dica" id="desc-rel" style="display:block"></span></div>
      <label>De <input type="date" name="de" required value="${est.de}"></label>
      <label>Até <input type="date" name="ate" required value="${est.ate}"></label>
      <label>Cliente <select name="tomadorId"><option value="">Todos</option>${clientes.map((c) => `<option value="${c.id}" ${String(c.id) === String(est.tomadorId) ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>
      <label id="lbl-sit">Situação <select name="situacao"><option value="">Todas</option><option>Vencido</option><option>A vencer</option></select></label>
      <div class="acoes"><button class="primario" type="submit">Gerar</button> <button type="button" id="rel-csv">Excel (CSV)</button> <button type="button" id="rel-pdf">PDF</button></div>
    </form>
    <div id="res-rel"><div class="vazio">Escolha o relatório ao lado, ajuste o período e clique em Gerar.</div></div>
    </div></div>`;
  const f = $('#form-rel');
  const atual = () => ({ rel: f.rel.value, de: f.de.value, ate: f.ate.value, tomadorId: f.tomadorId.value, situacao: f.situacao.value });
  const ajustar = () => { const c = cat.find((x) => x.id === f.rel.value); $('#tit-rel').textContent = c.titulo; $('#desc-rel').textContent = `${c.descricao} Filtra por: ${c.filtroData}.`; $('#lbl-sit').hidden = !c.situacoes; if (!c.situacoes) f.situacao.value = ''; };
  ajustar(); f.situacao.value = est.situacao;
  conteudo.querySelectorAll('[data-rel]').forEach((a) => (a.onclick = (ev) => {
    ev.preventDefault(); f.rel.value = a.dataset.rel; est.rel = a.dataset.rel;
    conteudo.querySelectorAll('[data-rel]').forEach((x) => x.classList.toggle('ativo', x === a));
    ajustar(); $('#res-rel').innerHTML = '<div class="vazio">Ajuste o período e clique em Gerar.</div>';
  }));
  const qs = (formato) => { const a = atual(); return new URLSearchParams({ de: a.de, ate: a.ate, formato, ...(a.tomadorId && { tomadorId: a.tomadorId }), ...(a.situacao && { situacao: a.situacao }) }).toString(); };
  f.onsubmit = async (ev) => {
    ev.preventDefault(); Object.assign(est, atual());
    const box = $('#res-rel'); box.innerHTML = '<p class="sutil">Gerando…</p>';
    try {
      const r = await api('GET', `/api/empresas/${estado.empresaId}/relatorios/${est.rel}?${qs('json')}`);
      box.innerHTML = `<h2>${esc(r.titulo)}</h2><p class="sutil">${esc(r.subtitulo)} · ${r.linhas.filter((l) => !l._subtotal).length} registro(s)</p>
        ${r.linhas.length ? `<div class="rolagem"><table class="tabela"><thead><tr>${r.colunas.map((c) => `<th class="${c.tipo === 'moeda' || c.tipo === 'inteiro' ? 'num' : ''}">${esc(c.nome)}</th>`).join('')}</tr></thead><tbody>
          ${r.linhas.map((l) => `<tr${l._subtotal ? ' class="rel-subtotal"' : ''}>${r.colunas.map((c) => `<td class="${c.tipo === 'moeda' || c.tipo === 'inteiro' ? 'num' : ''}">${fmtCel(l[c.k], c.tipo)}</td>`).join('')}</tr>`).join('')}
          ${r.colunas.some((c) => c.soma) ? `<tr><td><strong>TOTAL</strong></td>${r.colunas.slice(1).map((c) => `<td class="num"><strong>${c.soma ? fmtCel(r.totais[c.k], c.tipo) : ''}</strong></td>`).join('')}</tr>` : ''}
          </tbody></table></div>` : '<div class="vazio">Nenhum registro neste período.</div>'}`;
    } catch (e) { box.innerHTML = `<p class="erro">${esc(mensagemErro(e))}</p>`; }
  };
  $('#rel-csv').onclick = () => { Object.assign(est, atual()); baixar(`/api/empresas/${estado.empresaId}/relatorios/${est.rel}?${qs('csv')}`, `${est.rel}.csv`); };
  $('#rel-pdf').onclick = () => { Object.assign(est, atual()); baixar(`/api/empresas/${estado.empresaId}/relatorios/${est.rel}?${qs('pdf')}`, `${est.rel}.pdf`); };
}

const STATUS_AGENDA = { SEM_AGENDA: ['Sem agenda', ''], AGENDADA: ['Agendada', ''], PRONTA: ['Pronta para confirmar', 'cor-ambar'], EMITIDA: ['Emitida', 'cor-verde'], ERRO: ['Com erro', 'cor-vermelho'], PULADA: ['Pulada neste mês', ''] };

async function telaAgenda() {
  const mes = telaAgenda.mes ?? mesAtual();
  const base = `/api/empresas/${estado.empresaId}/agenda`;
  const d = await api('GET', `${base}?mes=${mes}`);
  const porCliente = new Map();
  for (const i of d.itens) (porCliente.get(i.tomador_id) ?? porCliente.set(i.tomador_id, []).get(i.tomador_id)).push(i);
  const prontas = d.itens.filter((i) => i.status === 'PRONTA' || i.status === 'ERRO');
  const totalProntas = prontas.reduce((t, i) => t + i.valor, 0);
  const acaoTxt = (m) => ({ NOTA: 'nota', NOTA_BOLETO: 'nota + boleto', BOLETO: 'boleto' }[m] ?? m);
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Emissão automática</h1><p class="sutil">Todo mês, na data de cada cliente, o sistema deixa a emissão pronta com o serviço padrão e o valor cadastrados. Você confere e confirma; nada é emitido sem a sua confirmação.</p></div>
      <div><label>Mês <input type="month" id="mes-ag" value="${mes}"></label>
        <button class="primario" id="todas" ${prontas.length ? '' : 'disabled'}>Emitir ${prontas.length ? prontas.length + ' pronta(s)' : 'prontas'}</button></div></div>
    ${porCliente.size ? `<div class="resumo">
      <div class="cartao"><div class="sutil">Prontas para confirmar</div><div class="valor" style="color:${COR.laranja}">${d.resumo.prontas}</div><div class="dica">${prontas.length ? brl(totalProntas) + ' em serviços' : 'nada pendente'}</div></div>
      <div class="cartao"><div class="sutil">Agendadas</div><div class="valor">${d.resumo.agendadas}</div><div class="dica">ainda não chegou a data</div></div>
      <div class="cartao"><div class="sutil">Com erro</div><div class="valor" style="color:${d.resumo.erros ? COR.vermelho : COR.verde}">${d.resumo.erros}</div></div>
    </div>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Cliente</th><th>Serviço</th><th class="num">Valor</th><th>O que gera</th><th>Data</th><th>Situação</th><th></th></tr></thead><tbody>
    ${[...porCliente.values()].map((itens) => itens.map((i, k) => `<tr>
      ${k === 0 ? `<td rowspan="${itens.length}"><strong>${esc(i.tomador)}</strong><br>${i.agenda_ativa ? `<span class="dica">todo dia ${i.agenda_dia}</span> ` : ''}<button data-cfg="${i.tomador_id}">${i.agenda_ativa ? 'Alterar' : 'Agendar'}</button></td>` : ''}
      <td>${esc(i.servico)}</td><td class="num">${brl(i.valor)}</td><td>${acaoTxt(i.modo)}</td><td>${i.data_prevista ? dataBr(i.data_prevista) : '—'}</td>
      <td><span class="${STATUS_AGENDA[i.status][1]}">${STATUS_AGENDA[i.status][0]}</span>${i.mensagem && i.status !== 'PULADA' ? `<br><span class="dica">${esc(i.mensagem)}</span>` : ''}</td>
      <td class="acoes-linha">${i.status === 'PRONTA' || i.status === 'ERRO' ? `<button data-exe="${i.tomador_id}:${i.servico_id}">${i.status === 'ERRO' ? 'Tentar de novo' : 'Emitir'}</button> <button data-pul="${i.tomador_id}:${i.servico_id}">Pular</button>` : i.status === 'PULADA' ? `<button data-des="${i.tomador_id}:${i.servico_id}">Desfazer</button>` : i.nota_id ? `<a href="#/nota/${i.nota_id}">Ver nota</a>` : ''}</td></tr>`).join('')).join('')}
    </tbody></table></div>`
    : '<div class="vazio">Nenhum cliente com serviço padrão. Abra um cliente, cadastre o serviço e o valor na aba <strong>Serviços padrão</strong> e volte aqui para agendar. <a href="#/tomadores">Ir para Clientes</a></div>'}`;
  $('#mes-ag').onchange = (ev) => { telaAgenda.mes = ev.target.value || mesAtual(); telaAgenda(); };
  const recarregar = async () => { const y = window.scrollY; await telaAgenda(); window.scrollTo(0, y); };
  const par = (v) => v.split(':').map(Number);
  conteudo.querySelectorAll('[data-cfg]').forEach((b) => (b.onclick = () => {
    const i = d.itens.find((x) => x.tomador_id === Number(b.dataset.cfg));
    abrirDialogo(`<form id="form-ag"><h2>Emissão automática — ${esc(i.tomador)}</h2>
      <p class="sutil">Gera ${acaoTxt(i.modo)} com os serviços padrão e valores do cadastro do cliente. Se o dia cair em fim de semana ou feriado, passa para o próximo dia útil.</p>
      <div class="grade"><label class="largo"><span><input type="checkbox" name="ativa" ${i.agenda_ativa ? 'checked' : ''}> Agendar todo mês</span></label>
        <label>Dia do mês <input name="dia" type="number" min="1" max="31" value="${i.agenda_dia ?? 5}"></label></div>
      <p class="erro" id="erro-ag"></p><div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Fechar</button></div></form>`, (dlg) => {
      $('#form-ag').onsubmit = async (ev) => {
        ev.preventDefault(); const f = ev.target;
        try { await api('POST', `${base}/config`, { tomadorId: i.tomador_id, ativa: f.ativa.checked, dia: Number(f.dia.value) }); dlg.close(); await recarregar(); }
        catch (e) { $('#erro-ag').textContent = mensagemErro(e); }
      };
    });
  }));
  const exec = async (b, rotulo) => {
    const [t, sv] = par(b.dataset.exe); b.disabled = true; b.textContent = 'Emitindo…';
    try { const r = await api('POST', `${base}/executar`, { tomadorId: t, servicoId: sv, mes }); aviso(r.status === 'EMITIDA' ? 'Emitido.' : (r.mensagem ?? 'Não foi possível emitir.')); }
    catch (e) { aviso(mensagemErro(e)); }
    await recarregar();
  };
  conteudo.querySelectorAll('[data-exe]').forEach((b) => (b.onclick = () => exec(b)));
  conteudo.querySelectorAll('[data-pul],[data-des]').forEach((b) => (b.onclick = async () => {
    const [t, sv] = par(b.dataset.pul ?? b.dataset.des);
    await api('POST', `${base}/pular`, { tomadorId: t, servicoId: sv, mes, desfazer: !!b.dataset.des }); await recarregar();
  }));
  $('#todas').onclick = async () => {
    if (!confirm(`Emitir agora ${prontas.length} item(ns), no total de ${brl(totalProntas)} em serviços?\nSerão geradas as notas e/ou boletos de cada cliente.`)) return;
    const b = $('#todas'); b.disabled = true; b.textContent = 'Emitindo…';
    try { const r = await api('POST', `${base}/executar-todas`, { mes }); aviso(`${r.emitidas} emitido(s)${r.erros ? `, ${r.erros} com erro` : ''}.`); }
    catch (e) { aviso(mensagemErro(e)); }
    await recarregar();
  };
}

async function telaExtrato() {
  const mes = telaExtrato.mes ?? mesAtual();
  const filtro = telaExtrato.filtro ?? 'todos';
  const semelhantes = telaExtrato.semelhantes ?? true;
  const base = `/api/empresas/${estado.empresaId}/extrato`;
  const [d, coraExt] = await Promise.all([api('GET', `${base}?mes=${mes}`), api('GET', `/api/empresas/${estado.empresaId}/cora`).catch(() => null)]);
  const vis = d.lancamentos.filter((l) => ({ todos: true, sem: !l.categoria, entradas: l.valor > 0, saidas: l.valor < 0 }[filtro]));
  const soma = (l) => l.reduce((t, x) => t + Math.abs(x.valor), 0);
  const agrupar = (l) => Object.entries(l.reduce((a, x) => ({ ...a, [x.categoria ?? 'Sem classificação']: (a[x.categoria ?? 'Sem classificação'] ?? 0) + Math.abs(x.valor) }), {})).sort((a, b) => b[1] - a[1]);
  const ent = d.lancamentos.filter((l) => l.valor > 0), sai = d.lancamentos.filter((l) => l.valor < 0);
  const tabCat = (titulo, l, cor) => `<div class="cartao"><h2 style="margin-top:0">${titulo} <span class="sutil">· ${brl(soma(l))}</span></h2>
    ${l.length ? `<table class="tabela"><tbody>${agrupar(l).map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num" style="color:${cor}">${brl(v)}</td><td class="num sutil">${Math.round(v / soma(l) * 100)}%</td></tr>`).join('')}</tbody></table>` : '<p class="sutil">Nada neste mês.</p>'}</div>`;
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Extrato e conciliação</h1><p class="sutil">Importe o extrato bancário em PDF, classifique entradas e saídas e ligue os recebimentos aos boletos. As <strong>saídas classificadas</strong> são lançadas automaticamente em <a href="#/despesas">Despesas e balanço</a> (exceto “Cartão de crédito” e “Transferências”); entradas como “Outras receitas” entram nas receitas.</p></div>
      <div><label>Mês ${d.meses.length ? `<select id="mes-ext">${[...new Set([mes, ...d.meses])].sort().reverse().map((m) => `<option value="${m}" ${m === mes ? 'selected' : ''}>${nomeMes(m)}</option>`).join('')}</select>` : `<input type="month" id="mes-ext" value="${mes}">`}</label>
        ${coraExt?.ativa ? '<button class="primario" id="cora-ext">Sincronizar com a Cora</button>' : ''}
        <button ${coraExt?.ativa ? '' : 'class="primario"'} id="imp-ext">Importar extrato (PDF)</button><input type="file" id="arq-ext" accept="application/pdf,.pdf" hidden></div></div>
    ${coraExt?.ativa && coraExt.saldo != null ? `<p class="sutil">Saldo na Cora: <strong>${brl(coraExt.saldo)}</strong>${coraExt.saldo_em ? ` (atualizado em ${coraExt.saldo_em.slice(8, 10)}/${coraExt.saldo_em.slice(5, 7)} às ${coraExt.saldo_em.slice(11, 16)} UTC)` : ''}.</p>` : ''}
    <div id="res-import"></div>
    ${d.lancamentos.length ? `<div class="resumo">
      <div class="cartao"><div class="sutil">Entradas</div><div class="valor" style="color:${COR.verde}">${compacto(d.entradas)}</div><div class="dica">${ent.length} lançamento(s)</div></div>
      <div class="cartao"><div class="sutil">Saídas</div><div class="valor" style="color:${COR.vermelho}">${compacto(d.saidas)}</div><div class="dica">${sai.length} lançamento(s)</div></div>
      <div class="cartao"><div class="sutil">Resultado do mês</div><div class="valor" style="color:${d.resultado < 0 ? COR.vermelho : COR.verde}">${compacto(d.resultado)}</div></div>
      <div class="cartao"><div class="sutil">Sem classificação</div><div class="valor" style="color:${d.semClassificacao ? COR.laranja : COR.verde}">${d.semClassificacao}</div><div class="dica">${d.semClassificacao ? 'classifique para fechar o balanço' : 'tudo classificado'}</div></div>
    </div>
    <div class="duas-colunas">${tabCat('Entradas por categoria', ent, COR.verde)}${tabCat('Saídas por categoria', sai, COR.vermelho)}</div>
    <div class="topo"><h2>Lançamentos de ${nomeMes(mes)}</h2>
      <div><nav class="abas" id="filtros-ext">${[['todos', 'Todos'], ['sem', `Sem classificação (${d.semClassificacao})`], ['entradas', 'Entradas'], ['saidas', 'Saídas']].map(([k, n]) => `<a href="#" data-f="${k}" class="${k === filtro ? 'ativo' : ''}">${n}</a>`).join('')}</nav></div></div>
    <label class="sutil" style="flex-direction:row;display:flex;gap:8px;align-items:center;margin:8px 0"><input type="checkbox" id="semelhantes" style="width:auto" ${semelhantes ? 'checked' : ''}> Ao classificar, aplicar também aos lançamentos parecidos (mesma descrição) e lembrar nas próximas importações</label>
    <datalist id="cat-ent">${d.categorias.entradas.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="cat-sai">${d.categorias.saidas.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th><th>Categoria</th><th>Boleto</th></tr></thead><tbody>
      ${vis.map((l) => `<tr><td>${dataBr(l.data)}</td><td>${esc(l.descricao)}${l.documento ? ` <span class="sutil">${esc(l.documento)}</span>` : ''}</td>
        <td class="num" style="color:${l.valor < 0 ? COR.vermelho : COR.verde}">${brl(l.valor)}</td>
        <td><input data-cat="${l.id}" list="${l.valor > 0 ? 'cat-ent' : 'cat-sai'}" value="${esc(l.categoria ?? '')}" placeholder="Classificar…" ${l.categoria ? '' : 'style="border-color:' + (COR.laranja) + '"'}></td>
        <td>${l.cobranca_id ? `<span title="Boleto com vencimento em ${dataBr(l.boleto_venc)}">✔ ${esc(l.tomador ?? 'boleto')}</span> <a href="#" data-des="${l.id}">desfazer</a>` : l.valor > 0 ? `<button data-bol="${l.id}">Ligar a boleto</button>` : l.despesa_ligada_id ? `<span title="Despesa lançada em Compras ou Despesas">✔ ${esc(l.despesa_ligada ?? 'despesa')}</span> <a href="#" data-desd="${l.id}">desfazer</a>` : `<button data-desp="${l.id}">Ligar a despesa</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="sutil">Nenhum lançamento neste filtro.</td></tr>'}
    </tbody></table></div>
    <h3>Importações</h3>
    <table class="tabela"><tbody>${d.importacoes.map((i) => `<tr><td>${esc(i.arquivo)}</td><td>${i.periodo_ini ? dataBr(i.periodo_ini) + ' a ' + dataBr(i.periodo_fim) : ''}</td><td class="num">${i.qtd} lançamentos</td><td class="num">${podeExcluirRegistros() ? `<a href="#" data-exi="${i.id}">excluir</a>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<div class="vazio">Nenhum lançamento neste mês. Importe o extrato da conta corrente em PDF, exportado do internet banking.</div>'}`;

  $('#mes-ext').onchange = (ev) => { telaExtrato.mes = ev.target.value || mesAtual(); telaExtrato(); };
  const arq = $('#arq-ext');
  const ce = $('#cora-ext');
  if (ce) ce.onclick = async () => {
    ce.disabled = true; ce.textContent = 'Sincronizando…';
    try { const r = await api('POST', `/api/empresas/${estado.empresaId}/cora/sincronizar`, {}); aviso(`Extrato da Cora atualizado: ${r.extrato?.novos ?? 0} lançamento(s) novo(s).`); telaExtrato(); }
    catch (e) { aviso(mensagemErro(e)); ce.disabled = false; ce.textContent = 'Sincronizar com a Cora'; }
  };
  $('#imp-ext').onclick = () => arq.click();
  arq.onchange = async () => {
    const f = arq.files[0]; if (!f) return;
    const box = $('#res-import'); box.innerHTML = '<p class="sutil">Lendo o extrato…</p>';
    try {
      const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f); });
      const r = await api('POST', `${base}/importar`, { nome: f.name, pdfBase64: b64 });
      if (r.periodo?.[0]) telaExtrato.mes = r.periodo[1].slice(0, 7);
      await telaExtrato();
      $('#res-import').innerHTML = `<div class="banner"><strong>Extrato importado:</strong> ${r.novos} lançamento(s) novo(s)${r.repetidos ? `, ${r.repetidos} já existiam` : ''}${r.conciliados ? `, ${r.conciliados} ligado(s) a boletos automaticamente` : ''}. Os saldos e totais do PDF foram conferidos.
        ${r.avisos.map((a) => `<br><span class="erro">⚠ ${esc(a)}</span>`).join('')}</div>`;
    } catch (e) { box.innerHTML = `<p class="erro">${esc(mensagemErro(e))}</p>`; }
    arq.value = '';
  };
  if (!d.lancamentos.length) return;
  const recarregar = async () => { const y = window.scrollY; await telaExtrato(); window.scrollTo(0, y); };
  $('#semelhantes').onchange = (ev) => { telaExtrato.semelhantes = ev.target.checked; };
  conteudo.querySelectorAll('#filtros-ext a').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); telaExtrato.filtro = a.dataset.f; telaExtrato(); }));
  conteudo.querySelectorAll('[data-cat]').forEach((i) => (i.onchange = async () => {
    try { await api('PUT', `${base}/${i.dataset.cat}`, { categoria: i.value.trim() || null, aplicarSemelhantes: $('#semelhantes').checked }); await recarregar(); }
    catch (e) { aviso(mensagemErro(e)); }
  }));
  conteudo.querySelectorAll('[data-des]').forEach((a) => (a.onclick = async (ev) => { ev.preventDefault(); await api('POST', `${base}/${a.dataset.des}/conciliar`, { cobrancaId: null }); await recarregar(); }));
  conteudo.querySelectorAll('[data-desd]').forEach((a) => (a.onclick = async (ev) => { ev.preventDefault(); await api('POST', `${base}/${a.dataset.desd}/despesa`, { despesaId: null }); await recarregar(); }));
  conteudo.querySelectorAll('[data-desp]').forEach((b) => (b.onclick = async () => {
    const l = d.lancamentos.find((x) => x.id === Number(b.dataset.desp));
    const c = await api('GET', `${base}/${l.id}/despesas`);
    abrirDialogo(`<form id="form-ligd"><h2>Ligar a uma despesa</h2>
      <p class="sutil">${dataBr(l.data)} · ${esc(l.descricao)} · <strong>${brl(l.valor)}</strong></p>
      ${c.length ? `<div class="rolagem"><table class="tabela"><tbody>${c.map((x) => `<tr><td>${dataBr(x.data)}</td><td>${esc(x.categoria)}</td><td>${esc(x.descricao ?? '')}</td><td class="num">${brl(x.valor)}</td><td><button type="button" data-ligd="${x.id}">Ligar</button></td></tr>`).join('')}</tbody></table></div>
      <p class="dica">Ao ligar, a despesa passa a ser a própria saída do extrato: não há lançamento em duplicidade.</p>`
      : '<p class="sutil">Nenhuma despesa lançada (compras, parcelas ou despesas manuais) com este valor e data próxima. Lance a NF-e em <a href="#/compras">Compras</a> primeiro.</p>'}
      <p class="erro" id="erro-ligd"></p><div class="acoes"><button type="button" data-fechar>Fechar</button></div></form>`, (dlg) => {
      dlg.querySelectorAll('[data-ligd]').forEach((x) => (x.onclick = async () => {
        try { await api('POST', `${base}/${l.id}/despesa`, { despesaId: Number(x.dataset.ligd) }); dlg.close(); await recarregar(); }
        catch (e) { $('#erro-ligd').textContent = mensagemErro(e); }
      }));
    });
  }));
  conteudo.querySelectorAll('[data-exi]').forEach((a) => (a.onclick = async (ev) => {
    ev.preventDefault();
    if (!confirm('Excluir esta importação e todos os lançamentos dela (inclusive as classificações)?')) return;
    await api('DELETE', `${base}/importacoes/${a.dataset.exi}`); await recarregar();
  }));
  conteudo.querySelectorAll('[data-bol]').forEach((b) => (b.onclick = async () => {
    const l = d.lancamentos.find((x) => x.id === Number(b.dataset.bol));
    const c = await api('GET', `${base}/${l.id}/boletos`);
    abrirDialogo(`<form id="form-lig"><h2>Ligar a um boleto</h2>
      <p class="sutil">${dataBr(l.data)} · ${esc(l.descricao)} · <strong>${brl(l.valor)}</strong></p>
      ${c.length ? `<div class="rolagem"><table class="tabela"><tbody>${c.map((x) => `<tr><td>${esc(x.tomador)}</td><td>${esc(x.descricao ?? '')}</td><td>venc. ${dataBr(x.vencimento)}</td><td>${x.status === 'PAGO' ? 'pago' : 'em aberto'}</td><td><button type="button" data-lig="${x.id}" data-st="${x.status}">Ligar</button></td></tr>`).join('')}</tbody></table></div>
      <label><input type="checkbox" name="baixa" checked> Se o boleto estiver em aberto, dar baixa como pago nesta data</label>`
      : '<p class="sutil">Nenhum boleto com este valor e data próxima. Confira se o valor recebido é o do boleto (descontos e juros mudam o valor).</p>'}
      <p class="erro" id="erro-lig"></p><div class="acoes"><button type="button" data-fechar>Fechar</button></div></form>`, (dlg) => {
      dlg.querySelectorAll('[data-lig]').forEach((x) => (x.onclick = async () => {
        try { await api('POST', `${base}/${l.id}/conciliar`, { cobrancaId: Number(x.dataset.lig), darBaixa: $('#form-lig').baixa?.checked ?? false }); dlg.close(); await recarregar(); }
        catch (e) { $('#erro-lig').textContent = mensagemErro(e); }
      }));
    });
  }));
}

async function telaCartao() {
  const mes = telaCartao.mes ?? mesAtual();
  const semelhantes = telaCartao.semelhantes ?? true;
  const filtro = telaCartao.filtro ?? 'todos';
  const base = `/api/empresas/${estado.empresaId}/cartao`;
  const d = await api('GET', `${base}?mes=${mes}`);
  const gastos = d.lancamentos.filter((l) => l.valor > 0);
  const porCat = Object.entries(gastos.reduce((a, x) => ({ ...a, [x.categoria ?? 'Sem classificação']: (a[x.categoria ?? 'Sem classificação'] ?? 0) + x.valor }), {})).sort((a, b) => b[1] - a[1]);
  const vis = d.lancamentos.filter((l) => ({ todos: true, sem: l.valor > 0 && !l.categoria, parcel: !!l.parcela_total }[filtro]));
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Fatura do cartão</h1><p class="sutil">Importe a fatura do cartão de crédito em PDF, classifique os gastos e eles entram em <a href="#/despesas">Despesas e balanço</a> como “Crédito”, no mês do vencimento da fatura. O pagamento da fatura no extrato (“Cartão de crédito”) não é contado de novo.</p></div>
      <div><label>Mês do vencimento ${d.meses.length ? `<select id="mes-car">${[...new Set([mes, ...d.meses])].sort().reverse().map((m) => `<option value="${m}" ${m === mes ? 'selected' : ''}>${nomeMes(m)}</option>`).join('')}</select>` : `<input type="month" id="mes-car" value="${mes}">`}</label>
        <button class="primario" id="imp-car">Importar fatura (PDF)</button><input type="file" id="arq-car" accept="application/pdf,.pdf" hidden></div></div>
    <div id="res-car"></div>
    ${d.lancamentos.length ? `<div class="resumo">
      <div class="cartao"><div class="sutil">Gastos na fatura</div><div class="valor" style="color:${COR.vermelho}">${compacto(d.totalGastos)}</div><div class="dica">${gastos.length} lançamento(s)</div></div>
      <div class="cartao"><div class="sutil">Total das faturas</div><div class="valor">${compacto(d.faturas.reduce((t, f) => t + (f.total_fatura ?? 0), 0))}</div><div class="dica">${d.faturas.map((f) => 'vence ' + dataBr(f.vencimento)).join(' · ')}</div></div>
      <div class="cartao"><div class="sutil">Sem classificação</div><div class="valor" style="color:${d.semClassificacao ? COR.laranja : COR.verde}">${d.semClassificacao}</div><div class="dica">${d.semClassificacao ? 'só entram nas despesas depois de classificados' : 'tudo classificado'}</div></div>
    </div>
    <div class="cartao"><h2 style="margin-top:0">Gastos por categoria</h2><table class="tabela"><tbody>${porCat.map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num" style="color:${COR.vermelho}">${brl(v)}</td><td class="num sutil">${Math.round(v / d.totalGastos * 100)}%</td></tr>`).join('')}</tbody></table></div>
    <div class="topo"><h2>Lançamentos</h2><nav class="abas" id="filtros-car">${[['todos', 'Todos'], ['sem', `Sem classificação (${d.semClassificacao})`], ['parcel', 'Parcelados']].map(([k, n]) => `<a href="#" data-f="${k}" class="${k === filtro ? 'ativo' : ''}">${n}</a>`).join('')}</nav></div>
    <label class="sutil" style="flex-direction:row;display:flex;gap:8px;align-items:center;margin:8px 0"><input type="checkbox" id="semelhantes" style="width:auto" ${semelhantes ? 'checked' : ''}> Ao classificar, aplicar também aos lançamentos parecidos e lembrar nas próximas importações</label>
    <datalist id="cat-sai">${d.categorias.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Compra</th><th>Descrição</th><th>Cartão</th><th class="num">Valor</th><th>Categoria</th></tr></thead><tbody>
      ${vis.map((l) => `<tr><td>${dataBr(l.data)}</td><td>${esc(l.descricao)}${l.parcela_total ? ` <span class="sutil">${l.parcela_atual}/${l.parcela_total}</span>` : ''}${l.cidade ? ` <span class="dica">${esc(l.cidade)}</span>` : ''}</td>
        <td class="sutil">${l.cartao_final ? 'final ' + esc(l.cartao_final) : ''}</td>
        <td class="num" style="color:${l.valor < 0 ? COR.verde : COR.vermelho}">${brl(l.valor)}</td>
        <td>${l.valor > 0 ? `<input data-cat="${l.id}" list="cat-sai" value="${esc(l.categoria ?? '')}" placeholder="Classificar…" ${l.categoria ? '' : 'style="border-color:' + COR.laranja + '"'}>` : '<span class="dica">' + (l.tipo === 'PAGAMENTO' ? 'pagamento da fatura anterior' : 'crédito') + '</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="sutil">Nenhum lançamento neste filtro.</td></tr>'}
    </tbody></table></div>
    <h3>Faturas importadas</h3>
    <table class="tabela"><tbody>${d.faturas.map((f) => `<tr><td>${esc(f.arquivo)}</td><td>vence ${dataBr(f.vencimento)}</td><td class="num">${f.total_fatura != null ? brl(f.total_fatura) : ''}</td><td class="num">${f.qtd} lançamentos</td><td class="num">${podeExcluirRegistros() ? `<a href="#" data-exf="${f.id}">excluir</a>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<div class="vazio">Nenhuma fatura neste mês. Importe o PDF da fatura do cartão, baixado no app ou site do emissor.</div>'}`;
  $('#mes-car').onchange = (ev) => { telaCartao.mes = ev.target.value || mesAtual(); telaCartao(); };
  const arq = $('#arq-car');
  $('#imp-car').onclick = () => arq.click();
  arq.onchange = async () => {
    const f = arq.files[0]; if (!f) return;
    const box = $('#res-car'); box.innerHTML = '<p class="sutil">Lendo a fatura…</p>';
    try {
      const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f); });
      const r = await api('POST', `${base}/importar`, { nome: f.name, pdfBase64: b64 });
      telaCartao.mes = r.vencimento.slice(0, 7);
      await telaCartao();
      $('#res-car').innerHTML = `<div class="banner"><strong>Fatura importada:</strong> ${r.novos} lançamento(s) novo(s)${r.repetidos ? `, ${r.repetidos} já existiam` : ''}${r.totalFatura != null ? `, total ${brl(r.totalFatura)}` : ''}. Os totais do PDF foram conferidos.
        ${r.avisos.map((a) => `<br><span class="erro">⚠ ${esc(a)}</span>`).join('')}</div>`;
    } catch (e) { box.innerHTML = `<p class="erro">${esc(mensagemErro(e))}</p>`; }
    arq.value = '';
  };
  if (!d.lancamentos.length) return;
  const recarregar = async () => { const y = window.scrollY; await telaCartao(); window.scrollTo(0, y); };
  $('#semelhantes').onchange = (ev) => { telaCartao.semelhantes = ev.target.checked; };
  conteudo.querySelectorAll('#filtros-car a').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); telaCartao.filtro = a.dataset.f; telaCartao(); }));
  conteudo.querySelectorAll('[data-cat]').forEach((i) => (i.onchange = async () => {
    try { await api('PUT', `${base}/${i.dataset.cat}`, { categoria: i.value.trim() || null, aplicarSemelhantes: $('#semelhantes').checked }); await recarregar(); }
    catch (e) { aviso(mensagemErro(e)); }
  }));
  conteudo.querySelectorAll('[data-exf]').forEach((a) => (a.onclick = async (ev) => {
    ev.preventDefault();
    if (!confirm('Excluir esta fatura, os lançamentos dela e as despesas geradas?')) return;
    await api('DELETE', `${base}/faturas/${a.dataset.exf}`); await recarregar();
  }));
}

const FORMAS_PGTO = { PIX: 'PIX', DEBITO: 'Débito', CREDITO: 'Crédito', DINHEIRO: 'Dinheiro' };
async function telaDespesas() {
  const mes = telaDespesas.mes ?? mesAtual();
  const base = `/api/empresas/${estado.empresaId}`;
  const [d, fin] = await Promise.all([api('GET', `${base}/despesas?mes=${mes}`), api('GET', `${base}/painel?mes=${mes}`).catch(() => null)]);
  const total = d.despesas.reduce((t, x) => t + x.valor, 0);
  const porCat = Object.entries(d.despesas.reduce((a, x) => ({ ...a, [x.categoria]: (a[x.categoria] ?? 0) + x.valor }), {})).sort((a, b) => b[1] - a[1]);
  const bal = fin?.balanco.at(-1);
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Despesas e balanço</h1><p class="sutil">Receitas = boletos pagos no mês (mais entradas do extrato classificadas como “Outras receitas”). Despesas = o que você lançar aqui + as saídas classificadas em Extrato e conciliação.</p></div>
      <label>Mês <input type="month" id="mes-desp" value="${mes}"></label></div>
    ${bal ? `<div class="resumo">
      <div class="cartao"><div class="sutil">Receitas</div><div class="valor" style="color:${COR.verde}">${compacto(bal.receitas)}</div></div>
      <div class="cartao"><div class="sutil">Despesas</div><div class="valor" style="color:${COR.vermelho}">${compacto(bal.despesas)}</div><div class="dica">${d.despesas.length} lançamento(s)</div></div>
      <div class="cartao"><div class="sutil">Resultado</div><div class="valor" style="color:${bal.resultado < 0 ? COR.vermelho : COR.verde}">${compacto(bal.resultado)}</div><div class="dica">${bal.receitas ? 'margem de ' + Math.round(bal.resultado / bal.receitas * 100) + '%' : 'sem receitas no mês'}</div></div>
    </div>
    <div class="duas-colunas">
      <div class="cartao"><h2 style="margin-top:0">Últimos 6 meses</h2>
        ${graficoBarras(fin.balanco.map((x) => x.mes), [{ cor: COR.verde, valores: fin.balanco.map((x) => x.receitas) }, { cor: COR.vermelho, valores: fin.balanco.map((x) => x.despesas) }], 5)}
        ${legenda([[COR.verde, 'Receitas'], [COR.vermelho, 'Despesas']])}</div>
      <div class="cartao"><h2 style="margin-top:0">Resultado por mês</h2>
        <table class="tabela"><thead><tr><th>Mês</th><th class="num">Receitas</th><th class="num">Despesas</th><th class="num">Resultado</th></tr></thead><tbody>
        ${[...fin.balanco].reverse().map((x) => `<tr><td>${nomeMes(x.mes)}</td><td class="num">${brl(x.receitas)}</td><td class="num">${brl(x.despesas)}</td><td class="num" style="color:${x.resultado < 0 ? COR.vermelho : COR.verde}">${brl(x.resultado)}</td></tr>`).join('')}</tbody></table></div>
    </div>` : ''}
    <div class="topo"><h2>Lançamentos de ${nomeMes(mes)} <span class="sutil">· ${brl(total)}</span></h2>
      <div><button id="cats">Categorias</button> <button class="primario" id="nova-desp">Lançar despesa</button></div></div>
    ${d.despesas.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Data</th><th>Categoria</th><th>Descrição</th><th>Pago com</th><th class="num">Valor</th><th></th></tr></thead><tbody>
      ${d.despesas.map((x) => `<tr><td>${dataBr(x.data)}</td><td>${esc(x.categoria)}</td><td>${esc(x.descricao ?? '')}</td><td>${x.forma_pagamento ? FORMAS_PGTO[x.forma_pagamento] : '<span class="dica">—</span>'}${x.origem === 'MANUAL' && x.extrato_lancamento_id ? ' <span class="dica">· conciliada com o extrato</span>' : ''}${x.origem === 'EXTRATO' ? ' <span class="dica">· extrato</span>' : x.origem === 'CARTAO' ? ' <span class="dica">· fatura</span>' : ''}</td><td class="num">${brl(x.valor)}</td>
        <td class="acoes-linha">${x.origem === 'EXTRATO' ? '<a href="#/extrato" class="dica">ver no extrato</a>' : x.origem === 'CARTAO' ? '<a href="#/cartao" class="dica">ver na fatura</a>' : `<button data-ed="${x.id}">Editar</button> ${podeExcluirRegistros() ? `<button data-ex="${x.id}">Excluir</button>` : ''}`}</td></tr>`).join('')}</tbody></table></div>
      ${porCat.length > 1 ? `<p class="sutil">Por categoria: ${porCat.map(([c, v]) => `${esc(c)} ${brl(v)}`).join(' · ')}</p>` : ''}` : '<div class="vazio">Nenhuma despesa lançada neste mês.</div>'}`;
  $('#mes-desp').onchange = (ev) => { telaDespesas.mes = ev.target.value || mesAtual(); telaDespesas(); };
  const formDespesa = (x) => abrirDialogo(`
    <form id="form-desp"><h2>${x ? 'Editar despesa' : 'Lançar despesa'}</h2>
      <div class="grade">
        <label>Data <input type="date" name="data" required value="${x?.data ?? (mes === mesAtual() ? hoje() : mes + '-01')}"></label>
        <label>Valor (R$) <input name="valor" data-num required inputmode="decimal" value="${x ? String(x.valor).replace('.', ',') : ''}"></label>
        <label>Categoria <input name="categoria" required list="lista-cat" value="${esc(x?.categoria ?? '')}"><datalist id="lista-cat">${d.categorias.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label>Descrição <input name="descricao" maxlength="200" value="${esc(x?.descricao ?? '')}"></label>
        <label>Pago com <select name="forma_pagamento"><option value="">Não informado</option>${Object.entries(FORMAS_PGTO).map(([k, n]) => `<option value="${k}" ${x?.forma_pagamento === k ? 'selected' : ''}>${n}</option>`).join('')}</select><span class="dica">Depois serve para vincular a despesa ao extrato e justificar o gasto.</span></label>
      </div>
      <p class="erro" id="erro-desp"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Fechar</button></div>
    </form>`, (dlg) => {
    $('#form-desp').onsubmit = async (ev) => {
      ev.preventDefault();
      const v = lerForm(ev.target);
      try {
        const corpo = { data: v.data, categoria: v.categoria, descricao: v.descricao, valor: v.valor, forma_pagamento: v.forma_pagamento || null };
        if (x) await api('PUT', `${base}/despesas/${x.id}`, corpo); else await api('POST', `${base}/despesas`, corpo);
        dlg.close(); telaDespesas();
      } catch (e) { $('#erro-desp').textContent = mensagemErro(e); }
    };
  });
  $('#nova-desp').onclick = () => formDespesa(null);
  conteudo.querySelectorAll('[data-ed]').forEach((b) => (b.onclick = () => formDespesa(d.despesas.find((x) => x.id === Number(b.dataset.ed)))));
  conteudo.querySelectorAll('[data-ex]').forEach((b) => (b.onclick = () => abrirDialogo(`
    <form id="form-ex"><h2>Excluir despesa?</h2><p>Esta ação não pode ser desfeita.</p>
      <div class="acoes"><button class="primario" type="submit">Excluir</button><button type="button" data-fechar>Cancelar</button></div></form>`, (dlg) => {
    $('#form-ex').onsubmit = async (ev) => { ev.preventDefault(); await api('DELETE', `${base}/despesas/${b.dataset.ex}`); dlg.close(); telaDespesas(); };
  })));
  $('#cats').onclick = () => abrirDialogo(`
    <form id="form-cats"><h2>Categorias de despesa</h2>
      <p class="sutil">Uma por linha. Despesas já lançadas não mudam.</p>
      <label><textarea name="cats" rows="10">${esc(d.categorias.join('\n'))}</textarea></label>
      <p class="erro" id="erro-cats"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar</button><button type="button" data-fechar>Fechar</button></div></form>`, (dlg) => {
    $('#form-cats').onsubmit = async (ev) => {
      ev.preventDefault();
      try { await api('PUT', `${base}/despesas-categorias`, { categorias: ev.target.cats.value.split('\n') }); dlg.close(); telaDespesas(); }
      catch (e) { $('#erro-cats').textContent = mensagemErro(e); }
    };
  });
}

// ---------------------------------------------------------------------------
// Licença
// ---------------------------------------------------------------------------
/** Aviso de vencimento (15 dias antes): uma janela por dia, além do selo vermelho no menu. */
function avisarVencimentoLicenca(s) {
  if (!s.aviso || !s.permitido || estado.usuario?.tipo !== 'adm' && s.diasRestantes > 3) return;
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  try { if (localStorage.getItem('avisoLicencaDia') === hoje) return; localStorage.setItem('avisoLicencaDia', hoje); } catch { /* sem armazenamento: avisa só nesta abertura */ }
  const teste = s.estado === 'teste';
  const prazo = s.diasRestantes === 0 ? 'vence hoje' : s.diasRestantes === 1 ? 'vence amanhã' : `vence em ${s.diasRestantes} dias`;
  abrirDialogo(`
    <h2>${teste ? 'Seu período de teste está acabando' : 'Sua licença está para vencer'}</h2>
    <p>${teste ? 'O período de teste' : `A licença (até ${dataBr(s.ate)})`} <strong>${prazo}</strong>. Depois disso a emissão de notas fica bloqueada; consultas, downloads e backup continuam funcionando.</p>
    <p>Para ${teste ? 'ativar' : 'renovar'}, envie ao suporte o código deste computador:</p>
    <p><strong style="font-size:1.2em;letter-spacing:1px">${esc(s.codigoComputador)}</strong></p>
    <div class="acoes"><a href="#/config/licenca"><button class="primario" data-fechar>Ir para Licença</button></a><button data-fechar>Lembrar amanhã</button></div>`);
}

async function atualizarLicenca() {
  const el = $('#licenca-info') ?? document.createElement('span'); // a situação da licença fica em Configurações > Licença
  try {
    const s = await api('GET', '/api/licenca');
    estado.licenca = s;
    if (s.estado === 'livre') { el.hidden = true; return s; }
    el.hidden = false;
    el.className = 'licenca-info' + (!s.permitido ? ' bloqueada' : s.aviso ? ' aviso' : '');
    el.textContent = !s.permitido ? 'Licença: emissão bloqueada' : s.estado === 'teste' ? `Teste: ${s.diasRestantes} ${s.diasRestantes === 1 ? 'dia' : 'dias'}` : s.aviso ? `Licença vence em ${s.diasRestantes} dia(s)` : `Licença até ${dataBr(s.ate)}`;
    avisarVencimentoLicenca(s);
    return s;
  } catch { return null; }
}

function textoLimites(s) {
  const pl = (n, um, mais) => (n == null ? `${mais} ilimitados` : n === 1 ? `1 ${um}` : `${n} ${mais}`);
  return `${pl(s.limites.empresas, 'empresa', 'empresas')} e ${pl(s.limites.clientes, 'cliente', 'clientes')}`;
}
function planosHtml(s) {
  const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return `<div class="planos-grade">${['bronze', 'prata', 'ouro', 'diamante'].map((id) => {
    const p = s.planos[id];
    return `<div class="plano ${s.plano === id ? 'atual' : ''}"><h3>${esc(p.nome)}</h3>
      <p class="preco">${p.preco == null ? 'Sob encomenda' : `${brl(p.preco)}<small>/mês</small>`}</p>
      <p class="dica">${esc(p.resumo)}</p>
      ${s.plano === id && s.estado === 'ativa' ? '<p><strong>Plano atual</strong></p>' : `<button type="button" data-plano="${id}">${id === 'diamante' ? 'Pedir orçamento' : 'Quero este plano'}</button>`}</div>`;
  }).join('')}</div><p class="dica">O pedido abre o WhatsApp do suporte já com o código deste computador. Depois do pagamento você recebe o novo código de ativação e o cola abaixo.</p>`;
}

/** Módulo vendido à parte ainda não contratado: apresenta o módulo e abre o pedido no WhatsApp do suporte. */
async function telaNaoContratado(m) {
  const s = estado.licenca ?? await api('GET', '/api/licenca').catch(() => null);
  conteudo.innerHTML = `<div class="topo"><div><h1>${esc(m.nome)}</h1><p class="sutil">Módulo adicional</p></div></div>
    <section class="cartao modulo-contratar"><p>${esc(m.resumo)}</p>
      <p>Este módulo não está incluído na licença deste computador. Depois de contratado, ele é liberado na hora pelo novo código de ativação, sem reinstalar o sistema.</p>
      <div class="acoes"><button class="primario" id="mod-contratar">Quero contratar</button><a href="#/config/licenca"><button type="button">Ver minha licença</button></a></div></section>`;
  $('#mod-contratar').onclick = () => pedirModulo(s, m.nome);
}
function pedirModulo(s, nome) {
  const msg = `Olá! Quero contratar o módulo ${nome} do Kontor Gestão Empresas.\nPlano atual: ${s?.planoNome ?? ''}\nCliente: ${s?.cliente || '(a informar)'}\nCódigo do computador: ${s?.codigoComputador ?? ''}`;
  window.open(`https://wa.me/${s?.suporteWhatsapp ?? ''}?text=${encodeURIComponent(msg)}`, '_blank');
}

async function telaLicenca() {
  const s = await atualizarLicenca() ?? await api('GET', '/api/licenca');
  const admin = estado.usuario.papel === 'admin';
  const titulo = { livre: 'Sem controle de licença', teste: 'Período de teste', ativa: 'Licença ativa', vencida: 'Licença vencida', relogio: 'Data do computador incorreta' }[s.estado];
  corpoConfig().innerHTML = `
    <div class="topo"><div><h1>Licença</h1><p class="sutil">${titulo}</p></div></div>
    <div class="banner ${s.permitido && !s.aviso ? '' : 'teste'}">${esc(s.mensagem)}</div>
    ${s.cliente ? `<p>Licenciado para <strong>${esc(s.cliente)}</strong>.</p>` : ''}
    ${s.estado === 'livre' ? '' : `
    <fieldset><legend>Seu plano</legend>
      <p><strong>${esc(s.planoNome)}</strong> · ${esc(textoLimites(s))} <button type="button" class="primario" id="alterar-plano">Alterar plano</button></p>
      <div id="planos" hidden>${planosHtml(s)}</div>
    </fieldset>
    ${Object.keys(s.modulosPagos ?? {}).length ? `<fieldset><legend>Módulos adicionais</legend>
      <ul class="lista-modulos">${Object.entries(s.modulosPagos).map(([id, m]) => {
        const lib = s.modulos.includes(id);
        const sit = lib ? (s.estado === 'teste' ? 'Liberado durante o teste' : 'Contratado') : 'Não contratado';
        return `<li><div><strong>${esc(m.nome)}</strong><span class="dica">${esc(m.resumo)}</span></div><span class="etiqueta ${lib ? 'ok' : ''}">${sit}</span>${lib && s.estado !== 'teste' ? '' : `<button type="button" data-modulo-pedir="${id}">Quero contratar</button>`}</li>`;
      }).join('')}</ul></fieldset>` : ''}
    <fieldset><legend>Código deste computador</legend>
      <p class="dica">Para renovar, envie este código ao suporte. Você receberá um código de ativação válido apenas neste computador.</p>
      <p><span class="codigo-copia" id="cod-pc">${esc(s.codigoComputador)}</span> <button type="button" id="copiar-cod">Copiar</button></p>
    </fieldset>
    <fieldset><legend>Inserir código de ativação</legend>
      ${admin ? `<form id="form-lic"><label>Código recebido <textarea name="codigo" required placeholder="KG3.…"></textarea></label>
        <p class="erro" id="erro-lic"></p><div class="acoes"><button class="primario" type="submit">Ativar</button></div></form>` : '<p class="dica">Peça a um administrador para inserir o código.</p>'}
    </fieldset>
    <p class="dica">Com a licença vencida, a emissão e os módulos adicionais são bloqueados: consultas, downloads de PDF/XML e backup continuam funcionando.</p>`}`;
  const ap = $('#alterar-plano');
  if (ap) ap.onclick = () => { const b = $('#planos'); b.hidden = !b.hidden; };
  document.querySelectorAll('[data-plano]').forEach((b) => b.onclick = () => {
    const p = s.planos[b.dataset.plano];
    const msg = `Olá! Quero ${s.plano === 'teste' ? 'contratar' : 'alterar para'} o plano ${p.nome} do Kontor Gestão Empresas.\nPlano atual: ${s.planoNome}\nCliente: ${s.cliente || '(a informar)'}\nCódigo do computador: ${s.codigoComputador}`;
    window.open(`https://wa.me/${s.suporteWhatsapp}?text=${encodeURIComponent(msg)}`, '_blank');
  });
  document.querySelectorAll('[data-modulo-pedir]').forEach((b) => b.onclick = () => pedirModulo(s, s.modulosPagos[b.dataset.moduloPedir].nome));
  const copiar = $('#copiar-cod');
  if (copiar) copiar.onclick = async () => { try { await navigator.clipboard.writeText(s.codigoComputador); aviso('Código copiado.'); } catch { aviso('Selecione o código e copie com Ctrl+C.'); } };
  const fl = $('#form-lic');
  if (fl) fl.onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/api/licenca', { codigo: fl.codigo.value.trim() }); aviso('Licença ativada.'); telaLicenca(); }
    catch (e) { $('#erro-lic').textContent = mensagemErro(e); }
  };
}

// ---------------------------------------------------------------------------
// Notas emitidas e detalhe
// ---------------------------------------------------------------------------

async function telaNotas() {
  const f = telaNotas.filtros ??= { mes: mesAtual(), status: '', q: '' };
  const qs = new URLSearchParams({ empresaId: estado.empresaId, ...(f.mes && { mes: f.mes }), ...(f.status && { status: f.status }), ...(f.q && { q: f.q }) });
  const notas = await api('GET', `/api/notas?${qs}`);
  const total = notas.filter((n) => n.status === 'AUTORIZADA').reduce((a, n) => a + n.valor_servico, 0);
  conteudo.innerHTML = `
    <div class="topo">
      <div><h1>Notas emitidas</h1><p class="sutil">${notas.length} notas · ${brl(total)} autorizados</p></div>
      <form class="filtros" id="filtros">
        <label>Competência <input type="month" name="mes" value="${f.mes}"></label>
        <label>Situação <select name="status"><option value="">Todas</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Buscar <input name="q" placeholder="Tomador ou nº da nota" value="${esc(f.q)}"></label>
        <button type="submit">Filtrar</button>
        ${empresa()?.modo_emissao === 'PORTAL' ? '<button type="button" class="primario" id="imp-xml">Importar nota do portal</button><input type="file" id="arq-xml" accept=".xml,text/xml" multiple hidden>' : ''}
        <button type="button" id="lote" ${notas.some((n) => n.chave_acesso) ? '' : 'disabled'}>Baixar em lote</button>
      </form>
    </div>
    ${notas.length ? `<div class="rolagem"><table class="tabela"><thead><tr>
      <th>Nº NFS-e</th><th>DPS</th><th>Competência</th><th>Tomador</th><th class="num">Valor</th><th>Situação</th></tr></thead><tbody>
      ${notas.map((n) => `<tr class="clicavel" data-id="${n.id}"><td>${n.n_nfse ?? '—'}</td><td>${n.serie}/${n.n_dps}</td><td>${dataBr(n.competencia)}</td>
        <td>${esc(n.tomador_nome ?? 'Não identificado')}<br><span class="dica">${esc(n.descricao.slice(0, 70))}</span></td>
        <td class="num">${brl(n.valor_servico)}</td><td>${carimbo(n.status)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="vazio">Nenhuma nota com esses filtros. <a href="#/emitir">Emitir nota</a></div>'}`;
  $('#filtros').onsubmit = (ev) => { ev.preventDefault(); telaNotas.filtros = lerForm(ev.target); for (const k in telaNotas.filtros) telaNotas.filtros[k] ??= ''; telaNotas(); };
  conteudo.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => (location.hash = `#/nota/${tr.dataset.id}`)));
  if ($('#imp-xml')) {
    $('#imp-xml').onclick = () => $('#arq-xml').click();
    $('#arq-xml').onchange = async (ev) => {
      const ok = [], erros = [];
      for (const arq of ev.target.files) {
        try { const r = await api('POST', `/api/empresas/${estado.empresaId}/notas/importar-xml`, { xml: await arq.text() }); ok.push(r); }
        catch (er) { erros.push(`${arq.name}: ${mensagemErro(er)}`); }
      }
      if (ok.length) aviso(`${ok.length} nota(s) importada(s).`);
      if (erros.length) aviso(erros.join(' · '));
      telaNotas();
    };
  }
  $('#lote').onclick = () => abrirDialogo(`
    <form id="form-lote"><h2>Baixar notas em lote</h2>
      <p class="sutil">Gera um arquivo ZIP com as notas emitidas de ${esc(empresa()?.razao_social ?? '')}${f.mes ? ` na competência ${f.mes.split('-').reverse().join('/')}` : ''}${f.status ? ` (situação filtrada)` : ''}.</p>
      <label>Conteúdo <select name="formato"><option value="ambos">XML e PDF</option><option value="xml">Só XML</option><option value="pdf">Só PDF</option></select></label>
      <p class="erro" id="erro-lote"></p>
      <div class="acoes"><button class="primario" type="submit">Baixar ZIP</button><button type="button" data-fechar>Fechar</button></div>
    </form>`, (d) => {
    $('#form-lote').onsubmit = async (ev) => {
      ev.preventDefault();
      const botao = ev.target.querySelector('[type=submit]');
      botao.disabled = true; botao.textContent = 'Gerando…';
      const p = new URLSearchParams({ empresaId: estado.empresaId, formato: ev.target.formato.value, ...(f.mes && { mes: f.mes }), ...(f.status && { status: f.status }) });
      try { await baixar(`/api/notas-lote?${p}`, `notas-${f.mes || 'todas'}.zip`); d.close(); }
      catch (er) { $('#erro-lote').textContent = mensagemErro(er); botao.disabled = false; botao.textContent = 'Baixar ZIP'; }
    };
  });
}

async function telaNota(id) {
  const n = await api('GET', `/api/notas/${id}`);
  const p = n.payload;
  const podeCancelar = n.status === 'AUTORIZADA' && estado.usuario.papel !== 'cliente';
  const podeExcluir = ['REJEITADA', 'ERRO_COMUNICACAO', 'PENDENTE'].includes(n.status) && !n.chave_acesso && estado.usuario.papel !== 'cliente' && podeExcluirRegistros();
  conteudo.innerHTML = `
    <div class="topo"><div>
      <h1>${n.n_nfse ? `NFS-e nº ${n.n_nfse}` : `DPS ${n.serie}/${n.n_dps}`}</h1>
      ${carimbo(n.status, true)}
    </div><a href="#/notas">Voltar para a lista</a></div>
    ${n.ambiente === 2 ? '<div class="banner teste">Emitida em produção restrita (sem valor fiscal).</div>' : ''}
    ${n.status === 'ERRO_COMUNICACAO' ? '<div class="banner teste">A Sefin não respondeu. A nota pode ter sido gerada: use "Consultar na Sefin" antes de reenviar. O reenvio usa o mesmo número de DPS, então não duplica.</div>' : ''}
    ${n.erros.length ? `<h2>Motivo${n.erros.length > 1 ? 's' : ''} da recusa</h2><ul class="lista-erros">${n.erros.map((e) => `<li><strong>${esc(e.codigo)}</strong> ${esc(e.descricao)}${e.complemento ? ` <span class="dica">${esc(e.complemento)}</span>` : ''}</li>`).join('')}</ul>` : ''}
    ${n.alertas.length ? `<h2>Alertas da Sefin</h2><ul>${n.alertas.map((a) => `<li>${esc(a.Descricao ?? a.descricao ?? JSON.stringify(a))}</li>`).join('')}</ul>` : ''}
    <div class="acoes">
      ${n.chave_acesso ? `<button class="primario" id="b-pdf">Abrir DANFSe</button><button id="b-xml">Baixar XML</button><button id="b-portal">Consultar no portal nacional</button>${estado.usuario.papel !== 'cliente' && n.ambiente === 1 ? `<button id="b-email">Enviar por e-mail${n.status === 'CANCELADA' ? ' (aviso de cancelamento)' : ''}</button><button id="b-whats">Enviar por WhatsApp</button>` : ''}` : ''}
      ${n.empresa_id && estado.usuario.modulos.includes('emitir') && estado.usuario.papel !== 'cliente' ? `<a href="#/emitir/clonar-${n.id}"><button type="button" id="b-clonar" title="Abre a emissão já preenchida com os dados desta nota">Clonar nota</button></a>` : ''}
      ${['REJEITADA', 'ERRO_COMUNICACAO', 'PENDENTE'].includes(n.status) ? `<a href="#/emitir/${n.id}"><button type="button">Corrigir e reenviar</button></a><button id="b-reenviar">Reenviar sem alterar</button>` : ''}
      ${n.status === 'ERRO_COMUNICACAO' ? '<button id="b-consultar">Consultar na Sefin</button>' : ''}
      ${podeCancelar ? '<button class="perigo" id="b-cancelar">Cancelar nota</button>' : ''}
      ${podeExcluir ? '<button class="perigo" id="b-excluir">Excluir nota</button>' : ''}
    </div>
    <h2>Dados</h2>
    <dl class="dados">
      <dt>Chave de acesso</dt><dd>${n.chave_acesso ?? '—'}</dd>
      <dt>Id da DPS</dt><dd>${n.id_dps}</dd>
      <dt>Competência</dt><dd>${dataBr(n.competencia)}</dd>
      <dt>Tomador</dt><dd>${esc(n.tomador_nome ?? 'Não identificado')} ${fmtDoc(n.tomador_documento)}</dd>
      <dt>Descrição</dt><dd>${esc(n.descricao)}</dd>
      <dt>Valor do serviço</dt><dd>${brl(n.valor_servico)}</dd>
      <dt>Alíquota ISSQN</dt><dd>${p.aliquota != null ? p.aliquota + '%' : '—'}</dd>
      <dt>Criada em</dt><dd>${dhBr(n.criado_em)}</dd>
      ${n.autorizada_em ? `<dt>Autorizada em</dt><dd>${dhBr(n.autorizada_em)}</dd>` : ''}
      ${n.cancelada_em ? `<dt>Cancelada em</dt><dd>${dhBr(n.cancelada_em)}</dd>` : ''}
    </dl>
    ${n.emails?.length ? `<h2>E-mails enviados</h2><ul>${n.emails.map((m) => `<li>${dhBr(m.criado_em)} — ${esc(m.para)}: ${m.status === 'ENVIADO' ? 'enviado' : '<span class="pendente-txt">falhou</span> ' + esc(m.erro ?? '')}</li>`).join('')}</ul>` : ''}
    ${n.eventos.length ? `<h2>Eventos</h2><ul>${n.eventos.map((e) => `<li>${dhBr(e.criado_em)} — ${e.tipo}: ${e.status} (${esc(e.motivo ?? '')})</li>`).join('')}</ul>` : ''}`;

  $('#b-pdf') && ($('#b-pdf').onclick = () => baixar(`/api/notas/${id}/danfse`, `DANFSe_${n.n_nfse}.pdf`, true));
  $('#b-email') && ($('#b-email').onclick = () => abrirDialogo(`
    <form id="form-email"><h2>${n.status === 'CANCELADA' ? 'Avisar o cancelamento da' : 'Enviar'} NFS-e nº ${n.n_nfse} por e-mail</h2>
      <p class="sutil">Vão em anexo o PDF (DANFSe) e o XML${n.status === 'CANCELADA' ? ' (nota e cancelamento)' : ''}. Separe vários e-mails com vírgula (até 5).</p>
      <label>Para <input name="para" required placeholder="cliente@empresa.com.br" value="${esc(n.tomador_email ?? '')}"></label>
      <p class="erro" id="erro-email"></p>
      <div class="acoes"><button class="primario" type="submit">Enviar</button><button type="button" data-fechar>Fechar</button></div>
    </form>`, (d) => {
    $('#form-email').onsubmit = async (ev) => {
      ev.preventDefault();
      const botao = ev.target.querySelector('[type=submit]');
      botao.disabled = true; botao.textContent = 'Enviando…';
      try {
        await api('POST', `/api/notas/${id}/email`, { para: ev.target.para.value.split(/[,;\s]+/).filter(Boolean), tipo: n.status === 'CANCELADA' ? 'cancelamento' : 'emissao' });
        d.close(); aviso('E-mail enviado.'); telaNota(id);
      } catch (er) { $('#erro-email').textContent = mensagemErro(er); botao.disabled = false; botao.textContent = 'Enviar'; }
    };
  }));
  $('#b-whats') && ($('#b-whats').onclick = () => {
    const link = `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${n.chave_acesso}`;
    const nome = n.empresa_nome?.nome_fantasia || n.empresa_nome?.razao_social || '';
    const texto = n.status === 'CANCELADA'
      ? `Olá${n.tomador_nome ? ', ' + n.tomador_nome : ''}! A NFS-e nº ${n.n_nfse} emitida por ${nome} (${brl(n.valor_servico)}) foi *cancelada* e não tem mais validade. Consulta: ${link}`
      : `Olá${n.tomador_nome ? ', ' + n.tomador_nome : ''}! Segue a NFS-e nº ${n.n_nfse} emitida por ${nome} (${brl(n.valor_servico)}, competência ${dataBr(n.competencia)}). Para ver e baixar o PDF e o XML: ${link}`;
    abrirDialogo(`
      <form id="form-whats"><h2>Enviar NFS-e nº ${n.n_nfse} por WhatsApp</h2>
        <p class="sutil">O WhatsApp abre com a mensagem pronta; você só confirma o envio. O link leva o cliente à nota no portal nacional (PDF e XML). Para mandar o PDF como anexo, baixe-o aqui e anexe na conversa.</p>
        <div class="grade">
          <label>Celular do cliente (com DDD) <input name="fone" required inputmode="tel" placeholder="(47) 99999-9999" value="${esc(n.tomador_fone ?? '')}"></label>
          <label class="largo">Mensagem <textarea name="texto" rows="5">${esc(texto)}</textarea></label>
        </div>
        <p class="erro" id="erro-whats"></p>
        <div class="acoes"><button class="primario" type="submit">Abrir WhatsApp</button><button type="button" id="w-pdf">Baixar PDF para anexar</button><button type="button" data-fechar>Fechar</button></div>
      </form>`, (d) => {
      $('#w-pdf').onclick = () => baixar(`/api/notas/${id}/danfse`, `DANFSe_${n.n_nfse}.pdf`);
      $('#form-whats').onsubmit = (ev) => {
        ev.preventDefault();
        let num = ev.target.fone.value.replace(/\D/g, '');
        if (num.startsWith('0')) num = num.replace(/^0+/, '');
        if (!(num.startsWith('55') && num.length >= 12)) num = '55' + num;
        if (num.length < 12 || num.length > 13) { $('#erro-whats').textContent = 'Número inválido. Informe DDD + número, por exemplo (47) 99999-9999.'; return; }
        window.open(`https://wa.me/${num}?text=${encodeURIComponent(ev.target.texto.value)}`, '_blank');
      };
    });
  });
  $('#b-portal') && ($('#b-portal').onclick = () => window.open(`https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${n.chave_acesso}`, '_blank'));
  $('#b-xml') && ($('#b-xml').onclick = () => baixar(`/api/notas/${id}/xml`, `NFSe_${n.n_nfse}.xml`));
  const acao = (sel, url, ok) => $(sel) && ($(sel).onclick = async (ev) => {
    ev.target.disabled = true;
    try { const r = await api('POST', url, {}); aviso(ok(r)); telaNota(id); } catch (e) { aviso(mensagemErro(e)); ev.target.disabled = false; }
  });
  acao('#b-reenviar', `/api/notas/${id}/reenviar`, (r) => `Situação: ${STATUS[r.status]}.`);
  acao('#b-consultar', `/api/notas/${id}/reconciliar`, (r) => (r.status === 'AUTORIZADA' ? 'A nota já havia sido gerada e foi recuperada.' : 'A Sefin não tem NFS-e para esta DPS. Pode reenviar.'));
  $('#b-excluir') && ($('#b-excluir').onclick = async () => {
    const aviso2 = n.status === 'REJEITADA' ? '' : '\n\nAtenção: a Sefin pode já ter gerado esta nota. Use "Consultar na Sefin" antes, se tiver dúvida.';
    if (!confirm(`Excluir esta nota (DPS ${n.serie}/${n.n_dps})? Ela não foi autorizada e some do sistema. Não dá para desfazer.${aviso2}`)) return;
    try { await api('DELETE', `/api/notas/${id}`); aviso('Nota excluída.'); location.hash = '#/notas'; } catch (e) { aviso(mensagemErro(e)); }
  });
  $('#b-cancelar') && ($('#b-cancelar').onclick = () => abrirDialogo(`
    <form id="form-cancelar"><h2>Cancelar NFS-e nº ${n.n_nfse}</h2>
      <p class="sutil">O cancelamento é registrado na Sefin e não pode ser desfeito. Fora do prazo do seu município, ele pode exigir análise da prefeitura.</p>
      <div class="grade">
        <label>Motivo <select name="cMotivo"><option value="1">Erro na emissão</option><option value="2">Serviço não prestado</option><option value="9">Outros</option></select></label>
        <label class="largo">Justificativa <textarea name="xMotivo" required minlength="15" maxlength="255"></textarea></label>
        ${n.tomador_email && n.ambiente === 1 ? `<label class="largo"><span><input type="checkbox" name="avisar" checked> Avisar o tomador por e-mail (${esc(n.tomador_email)})</span></label>` : ''}
      </div>
      <p class="erro" id="erro-cancelar"></p>
      <div class="acoes"><button class="perigo" type="submit">Cancelar nota</button><button type="button" data-fechar>Voltar</button></div>
    </form>`, (d) => {
    $('#form-cancelar').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('POST', `/api/notas/${id}/cancelar`, { cMotivo: Number(f.cMotivo.value), xMotivo: f.xMotivo.value });
        d.close();
        let msg = 'Nota cancelada.';
        if (f.avisar?.checked) {
          try { await api('POST', `/api/notas/${id}/email`, { para: [n.tomador_email], tipo: 'cancelamento' }); msg += ` Aviso enviado para ${n.tomador_email}.`; }
          catch (e2) { msg += ` O e-mail de aviso não foi enviado: ${mensagemErro(e2)}`; }
        }
        aviso(msg); telaNota(id);
      }
      catch (e) { $('#erro-cancelar').textContent = mensagemErro(e); }
    };
  }));
}

/**
 * Consulta de CNPJ na Receita Federal (via servidor): preenche os campos ainda vazios do formulário.
 * modo 'empresa' também ajusta o regime (MEI / Simples / não optante) quando a base informa.
 */
function ligarConsultaCnpj(form, modo) {
  const btn = form.querySelector('[data-buscar-cnpj]');
  const info = form.querySelector('[data-cnpj-info]');
  const nomeCampo = modo === 'empresa' ? 'razao_social' : 'nome';  // 'tomador' e 'fornecedor' usam o campo nome
  const limpo = () => form.documento.value.replace(/[^0-9A-Za-z]/g, '');
  const dicaPadrao = info.textContent;

  const buscar = async () => {
    if (limpo().length !== 14) { info.className = 'dica erro'; info.textContent = 'O CNPJ tem 14 caracteres.'; return; }
    btn.disabled = true; info.className = 'dica'; info.textContent = 'Consultando a Receita Federal…';
    try {
      const d = await api('GET', `/api/consulta/cnpj/${limpo()}`);
      const preencher = (campo, valor) => { const el = form[campo]; if (el && valor && !el.value.trim()) el.value = valor; };
      preencher(nomeCampo, d.razao_social);
      preencher('nome_fantasia', d.nome_fantasia);
      preencher('email', d.email);
      preencher('fone', d.fone);
      preencher('cep', d.cep);
      preencher('cod_municipio', d.cod_municipio);
      preencher('uf', d.uf);
      preencher('cidade', d.municipio);
      preencher('logradouro', d.logradouro);
      preencher('numero', d.numero);
      preencher('complemento', d.complemento);
      preencher('bairro', d.bairro);
      if (modo === 'tomador' && form.tipo_doc) form.tipo_doc.value = 'CNPJ';
      if (modo === 'empresa' && d.op_simp_nac && form.op_simp_nac) { form.op_simp_nac.value = d.op_simp_nac; form.op_simp_nac.onchange?.(); }
      const mun = form.querySelector('[data-municipio]');
      if (mun && d.municipio) mun.textContent = `${d.municipio}/${d.uf}${d.cod_municipio ? ' — IBGE ' + d.cod_municipio : ''}`;
      const regime = d.op_simp_nac ? ['', 'Não optante', 'MEI', 'Simples ME/EPP'][d.op_simp_nac] : null;
      const faltas = modo === 'fornecedor' ? [] : [!d.cod_municipio && 'código IBGE', !d.logradouro && 'logradouro', !d.numero && 'número', modo === 'empresa' && 'inscrição municipal (não consta na Receita)'].filter(Boolean);
      info.className = d.ativa ? 'dica' : 'dica erro';
      info.textContent = `Receita Federal: ${d.situacao ?? 'situação não informada'}${regime ? ' · ' + regime : ''}.${d.ativa ? '' : ' Atenção: o CNPJ não está ativo.'}${faltas.length ? ' Confira: ' + faltas.join(', ') + '.' : ''}`;
    } catch (e) {
      info.className = 'dica erro'; info.textContent = e.message;
    } finally { btn.disabled = false; }
  };
  btn.onclick = buscar;
  // ao sair do campo com um CNPJ completo e o nome ainda vazio, busca sozinho
  form.documento.addEventListener('blur', () => { if (limpo().length === 14 && !form[nomeCampo].value.trim()) buscar(); });
  form.documento.addEventListener('input', () => { if (info.className !== 'dica') { info.className = 'dica'; info.textContent = dicaPadrao; } });
}

// ---------------------------------------------------------------------------
// Tomadores
// ---------------------------------------------------------------------------

const NOME_MODO = { NOTA: 'Nota', NOTA_BOLETO: 'Nota + boleto', BOLETO: 'Só boleto' };
async function formTomador(t, aoSalvar) {
  const servicosEmpresa = await api('GET', `/api/empresas/${estado.empresaId}/servicos`).catch(() => []);
  t ??= { tipo_doc: 'CNPJ', modo_faturamento: 'NOTA', vencimento_tipo: 'PRAZO', vencimento_valor: 10, enviar_email_auto: 0 };
  abrirDialogo(`
    <form id="form-tomador"><h2>${t.id ? 'Editar cliente' : 'Novo cliente'}</h2>
      <nav class="abas" id="abas-cliente"><a href="#" data-aba="cadastro" class="ativo">Cadastro</a><a href="#" data-aba="servicos">Serviços padrão${t.servicos_padrao?.length ? ' •' : ''}</a><a href="#" data-aba="descontos">Descontos${t.desconto_valor ? ' •' : ''}</a><a href="#" data-aba="descricao">Descrição da nota${t.descricao_modelo ? ' •' : ''}</a></nav>
      <div data-painel="cadastro">
      ${t.conferir ? `<div class="banner teste"><strong>Falta conferir:</strong> ${esc(t.conferir_motivo ?? 'cadastro criado por planilha')}.<br>Complete o que faltar e marque <label class="check" style="display:inline-flex;gap:6px"><input type="checkbox" name="conferido"> Cadastro conferido</label> para tirar a marca.</div>` : ''}
      <fieldset class="sub"><legend>Identificação</legend><div class="grade">
        <label>Tipo <select name="tipo_doc">${['CNPJ', 'CPF', 'SEM'].map((v) => `<option value="${v}" ${t.tipo_doc === v ? 'selected' : ''}>${v === 'SEM' ? 'Sem documento' : v}</option>`).join('')}</select></label>
        <label>CNPJ / CPF <span class="linha-campo"><input name="documento" value="${esc(t.documento ?? '')}"><button type="button" data-buscar-cnpj>Buscar CNPJ</button></span><span class="dica" data-cnpj-info>Digite o CNPJ e clique em Buscar para preencher os dados.</span></label>
        <label class="largo">Nome / Razão social <input name="nome" required value="${esc(t.nome ?? '')}"></label>
        <label>Inscrição municipal <input name="inscricao_municipal" value="${esc(t.inscricao_municipal ?? '')}"></label>
      </div></fieldset>
      <fieldset class="sub"><legend>Contato</legend><div class="grade">
        <label>E-mail principal <input name="email" type="email" value="${esc(t.email ?? '')}"></label>
        <label>Telefone / WhatsApp <input name="fone" value="${esc(t.fone ?? '')}"></label>
      </div></fieldset>
      <fieldset class="sub"><legend>Endereço</legend><div class="grade">
        <label>CEP <input name="cep" value="${esc(t.cep ?? '')}"><span class="dica" data-municipio></span></label>
        <label>Município (IBGE) <input name="cod_municipio" maxlength="7" value="${esc(t.cod_municipio ?? '')}"></label>
        <label>Cidade <input name="cidade" maxlength="60" value="${esc(t.cidade ?? '')}"></label>
        <label>UF <input name="uf" maxlength="2" value="${esc(t.uf ?? '')}"></label>
        <label class="largo">Logradouro <input name="logradouro" value="${esc(t.logradouro ?? '')}"></label>
        <label>Número <input name="numero" value="${esc(t.numero ?? '')}"></label>
        <label>Complemento <input name="complemento" value="${esc(t.complemento ?? '')}"></label>
        <label>Bairro <input name="bairro" value="${esc(t.bairro ?? '')}"></label>
      </div><p class="dica">Endereço é opcional; se preencher, informe CEP, município, logradouro e bairro.</p></fieldset>
      <fieldset class="sub"><legend>Faturamento e cobrança</legend><div class="grade">
        <label class="largo">O que emitir para este cliente
          <select name="modo_faturamento">
            <option value="NOTA" ${t.modo_faturamento === 'NOTA' ? 'selected' : ''}>Somente a nota fiscal</option>
            <option value="NOTA_BOLETO" ${t.modo_faturamento === 'NOTA_BOLETO' ? 'selected' : ''}>Nota fiscal + cobrança</option>
            <option value="BOLETO" ${t.modo_faturamento === 'BOLETO' ? 'selected' : ''}>Somente a cobrança</option>
          </select></label>
        <label class="largo" data-cobranca>Carteira de cobrança
          <select name="forma_cobranca">
            <option value="BOLETO" ${t.forma_cobranca !== 'PIX' ? 'selected' : ''}>Boleto bancário</option>
            <option value="PIX" ${t.forma_cobranca === 'PIX' ? 'selected' : ''}>Pix copia e cola (QR Code no demonstrativo, sem boleto)</option>
          </select><span class="dica" data-dica-pix>No Pix, você gera a cobrança no banco e cola o código em Cobranças; o Kontor monta o demonstrativo com o QR Code.</span></label>
        <label data-cobranca>Vencimento da cobrança
          <select name="vencimento_tipo"><option value="PRAZO" ${t.vencimento_tipo === 'PRAZO' ? 'selected' : ''}>Dias após a emissão</option><option value="DIA_FIXO" ${t.vencimento_tipo === 'DIA_FIXO' ? 'selected' : ''}>Dia fixo do mês</option></select></label>
        <label data-cobranca><span data-rotulo-venc>Quantidade de dias</span> <input name="vencimento_valor" data-num type="number" min="0" max="60" value="${t.vencimento_valor ?? 10}"></label>
        <label class="largo" data-cobranca>E-mails extras para cobrança <input name="email_cobranca" placeholder="financeiro@cliente.com, outro@cliente.com" value="${esc(t.email_cobranca ?? '')}"><span class="dica">Separe por vírgula. Recebem junto com o e-mail principal.</span></label>
        <label class="largo"><span><input type="checkbox" name="enviar_email_auto" ${t.enviar_email_auto ? 'checked' : ''}> Enviar por e-mail automaticamente ao emitir</span><span class="dica">Só em produção. A nota é enviada logo após ser autorizada.</span></label>
      </div><p class="dica" data-aviso-banco>O boleto ainda não está ligado a um banco: ele fica registrado como “aguardando banco” até a integração ser ativada.</p></fieldset>
      </div>
      <div data-painel="servicos" hidden>
        <fieldset class="sub"><legend>Serviços que sempre são cobrados deste cliente</legend>
          <p class="dica">Escolha os serviços e o valor de cada um. Ao selecionar este cliente na emissão, o serviço principal e o valor já vêm preenchidos para a nota e para o boleto. Esses dados também serão a base da emissão agendada.</p>
          <div id="lista-serv-padrao"></div>
          <div class="acoes"><button type="button" id="add-serv-padrao" ${servicosEmpresa.length ? '' : 'disabled'}>Adicionar serviço</button></div>
          ${servicosEmpresa.length ? '' : '<p class="dica">Cadastre antes os serviços da empresa em Serviços.</p>'}
        </fieldset>
      </div>
      <div data-painel="descontos" hidden>
        <fieldset class="sub"><legend>Desconto fixo deste cliente</legend><div class="grade">
          <label>Valor do desconto (R$) <input name="desconto_valor" data-num inputmode="decimal" value="${t.desconto_valor ? String(t.desconto_valor).replace('.', ',') : ''}" placeholder="0,00"></label>
          <label class="largo">Motivo do desconto <input name="desconto_motivo" maxlength="80" value="${esc(t.desconto_motivo ?? '')}" placeholder="ex.: Desconto contratual de fidelidade"></label>
        </div>
        <p class="dica">O valor é abatido de <strong>todos os boletos</strong> deste cliente (emitidos com nota, só boleto ou reemitidos), e o motivo sai nas instruções do boleto. Na emissão da NFS-e o sistema lembra que o cliente tem desconto e deixa você decidir se lança também como desconto na nota. Deixe em branco para não ter desconto.</p></fieldset>
      
        <fieldset class="sub"><legend>Multa, juros e desconto por pontualidade</legend><div class="grade">
          <label>Multa após o vencimento (%) <input name="multa_pct" data-num inputmode="decimal" value="${t.multa_pct != null ? String(t.multa_pct).replace('.', ',') : ''}" placeholder="padrão da empresa"></label>
          <label>Juros de mora ao mês (%) <input name="juros_pct_mes" data-num inputmode="decimal" value="${t.juros_pct_mes != null ? String(t.juros_pct_mes).replace('.', ',') : ''}" placeholder="padrão da empresa"></label>
          <label>Desconto por pagamento antecipado (%) <input name="desc_pontual_pct" data-num inputmode="decimal" value="${t.desc_pontual_pct ? String(t.desc_pontual_pct).replace('.', ',') : ''}" placeholder="sem desconto"></label>
          <label>Válido até quantos dias antes do vencimento <input name="desc_pontual_dias" type="number" min="0" max="60" value="${t.desc_pontual_dias ?? ''}" placeholder="0 = até o vencimento"></label>
        </div>
        <p class="dica">Em branco, valem a multa e os juros dos dados bancários da empresa. O desconto por pontualidade é calculado sobre o valor do boleto, vai na remessa ao banco (desconto até a data) e na instrução impressa; quem paga depois do prazo paga o valor cheio.</p></fieldset>
      </div>
      <div data-painel="descricao" hidden>
        <fieldset class="sub"><legend>Descrição composta (automática)</legend>
          <label class="check"><input type="checkbox" name="dm_ativo"> Montar a descrição da nota automaticamente para este cliente</label>
          <div id="dm-corpo">
            <div class="grade">
              <label class="largo">Texto inicial <input name="dm_texto" maxlength="500" placeholder="Prestação de serviços conforme contrato"></label>
              <label class="check"><input type="checkbox" name="dm_periodo"> Pedir período (data inicial e final)</label>
              <label class="check"><input type="checkbox" name="dm_oc"> Pedir ordem de compra</label>
              <label>Retenção de INSS (%) <input name="dm_cp" data-num inputmode="decimal" size="5"><span class="dica">Aplicada só nas linhas marcadas como "retém INSS".</span></label>
            </div>
            <h4>Linhas de valor</h4>
            <div id="dm-linhas"></div>
            <button type="button" id="dm-add">Adicionar linha</button>
            <p class="dica">Exemplo: "Mão de obra" (retém INSS) e "Aluguel de máquinas". Na emissão, informe o valor de cada linha: o valor da nota é a soma e o INSS é calculado só sobre as linhas marcadas. PIS, COFINS, CSLL e IR seguem o tipo de documento, sobre o valor total.</p>
          </div>
        </fieldset>
      </div>
      <p class="erro" id="erro-tomador"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar cliente</button><button type="button" data-fechar>Fechar</button></div>
    </form>`, (d) => {
    const f = $('#form-tomador');
    f.querySelectorAll('#abas-cliente a').forEach((a) => (a.onclick = (ev) => {
      ev.preventDefault();
      f.querySelectorAll('#abas-cliente a').forEach((x) => x.classList.toggle('ativo', x === a));
      f.querySelectorAll('[data-painel]').forEach((p) => (p.hidden = p.dataset.painel !== a.dataset.aba));
    }));
    // serviços padrão do cliente
    let padroes = (t.servicos_padrao ?? []).map((x) => ({ ...x }));
    const desenharPadroes = () => {
      const box = $('#lista-serv-padrao');
      box.innerHTML = padroes.length ? padroes.map((x, i) => `
        <div class="linha-serv">
          <label>Serviço <select data-sp="servico_id" data-i="${i}">${servicosEmpresa.some((sv) => sv.id === x.servico_id) ? '' : `<option value="${x.servico_id}">(serviço removido)</option>`}${servicosEmpresa.map((sv) => `<option value="${sv.id}" ${sv.id === x.servico_id ? 'selected' : ''}>${esc(sv.nome)}</option>`).join('')}</select></label>
          <label>Valor (R$) <input data-sp="valor" data-i="${i}" inputmode="decimal" value="${x.valor ? String(x.valor).replace('.', ',') : ''}"></label>
          <label class="largo">Texto na nota (opcional) <input data-sp="descricao" data-i="${i}" maxlength="2000" value="${esc(x.descricao ?? '')}" placeholder="vazio = descrição padrão do serviço"></label>
          <label><span><input type="radio" name="sp_principal" data-i="${i}" ${x.padrao ? 'checked' : ''}> Principal</span></label>
          <button type="button" data-sp-del="${i}">Remover</button>
        </div>`).join('') : '<p class="sutil">Nenhum serviço padrão cadastrado.</p>';
      box.querySelectorAll('[data-sp]').forEach((el) => (el.oninput = el.onchange = () => {
        const x = padroes[Number(el.dataset.i)], k = el.dataset.sp;
        x[k] = k === 'servico_id' ? Number(el.value) : k === 'valor' ? (numero(el.value) ?? 0) : el.value;
      }));
      box.querySelectorAll('[name=sp_principal]').forEach((r) => (r.onchange = () => padroes.forEach((x, j) => (x.padrao = j === Number(r.dataset.i)))));
      box.querySelectorAll('[data-sp-del]').forEach((b) => (b.onclick = () => { padroes.splice(Number(b.dataset.spDel), 1); if (padroes.length && !padroes.some((x) => x.padrao)) padroes[0].padrao = true; desenharPadroes(); }));
    };
    $('#add-serv-padrao').onclick = () => {
      const livre = servicosEmpresa.find((sv) => !padroes.some((x) => x.servico_id === sv.id)) ?? servicosEmpresa[0];
      padroes.push({ servico_id: livre.id, valor: livre.valor_padrao ?? 0, descricao: '', padrao: !padroes.length }); desenharPadroes();
    };
    desenharPadroes();
    // descrição composta do cliente
    const dm0 = (() => { try { return t.descricao_modelo ? JSON.parse(t.descricao_modelo) : null; } catch { return null; } })();
    let dmLinhas = (dm0?.linhas ?? [{ rotulo: 'Mão de obra', retem_cp: true }, { rotulo: 'Aluguel de máquinas', retem_cp: false }]).map((x) => ({ ...x }));
    f.dm_ativo.checked = !!dm0?.ativo; f.dm_texto.value = dm0?.texto ?? 'Prestação de serviços'; f.dm_periodo.checked = dm0 ? !!dm0.periodo : true; f.dm_oc.checked = dm0 ? !!dm0.ordem_compra : true;
    f.dm_cp.value = String(dm0?.cp_pct ?? 11).replace('.', ',');
    const desenharDm = () => {
      $('#dm-corpo').hidden = !f.dm_ativo.checked;
      $('#dm-linhas').innerHTML = dmLinhas.map((l, i) => `<div class="linha-serv"><label class="largo">Rótulo <input data-dl="rotulo" data-i="${i}" maxlength="60" value="${esc(l.rotulo)}"></label>
        <label class="check"><input type="checkbox" data-dl="retem_cp" data-i="${i}" ${l.retem_cp ? 'checked' : ''}> Retém INSS</label>${dmLinhas.length > 1 ? `<button type="button" data-dl-del="${i}">Remover</button>` : ''}</div>`).join('');
      $('#dm-linhas').querySelectorAll('[data-dl]').forEach((el) => (el.oninput = el.onchange = () => { const x = dmLinhas[Number(el.dataset.i)]; x[el.dataset.dl] = el.type === 'checkbox' ? el.checked : el.value; }));
      $('#dm-linhas').querySelectorAll('[data-dl-del]').forEach((b) => (b.onclick = () => { dmLinhas.splice(Number(b.dataset.dlDel), 1); desenharDm(); }));
    };
    f.dm_ativo.onchange = desenharDm;
    $('#dm-add').onclick = () => { if (dmLinhas.length < 8) { dmLinhas.push({ rotulo: '', retem_cp: false }); desenharDm(); } };
    desenharDm();
    f.cep.onblur = () => buscarCep(f);
    ligarConsultaCnpj(f, 'tomador');
    const ajustar = () => {
      const comBoleto = f.modo_faturamento.value !== 'NOTA';
      f.querySelectorAll('[data-cobranca]').forEach((x) => (x.hidden = !comBoleto));
      f.querySelector('[data-aviso-banco]').hidden = !comBoleto || f.forma_cobranca.value === 'PIX';
      f.querySelector('[data-dica-pix]').hidden = f.forma_cobranca.value !== 'PIX';
      f.querySelector('[data-rotulo-venc]').textContent = f.vencimento_tipo.value === 'PRAZO' ? 'Quantidade de dias' : 'Dia do mês (1 a 31)';
    };
    f.modo_faturamento.onchange = f.vencimento_tipo.onchange = f.forma_cobranca.onchange = ajustar; ajustar();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        const corpo = lerForm(f);
        corpo.enviar_email_auto = f.enviar_email_auto.checked;
        corpo.vencimento_valor = Number(f.vencimento_valor.value || 0);
        corpo.cidade = f.cidade.value.trim() || null; corpo.uf = f.uf.value.trim().toUpperCase() || null;
        corpo.email_cobranca = f.email_cobranca.value.trim() || null;
        if (padroes.some((x) => !(x.valor > 0))) throw new Error('Informe o valor de cada serviço padrão (aba Serviços padrão).');
        corpo.servicos_padrao = padroes.map((x) => ({ servico_id: x.servico_id, valor: x.valor, descricao: (x.descricao || '').trim() || null, padrao: !!x.padrao }));
        corpo.descricao_modelo = f.dm_ativo.checked
          ? { ativo: true, texto: f.dm_texto.value.trim() || 'Prestação de serviços', periodo: f.dm_periodo.checked, ordem_compra: f.dm_oc.checked, cp_pct: numero(f.dm_cp.value) ?? 11,
              linhas: dmLinhas.filter((l) => String(l.rotulo).trim()).map((l) => ({ rotulo: String(l.rotulo).trim(), retem_cp: !!l.retem_cp })) }
          : null;
        if (corpo.descricao_modelo && !corpo.descricao_modelo.linhas.length) throw new Error('Informe ao menos uma linha de valor na aba Descrição da nota.');
        ['dm_ativo', 'dm_texto', 'dm_periodo', 'dm_oc', 'dm_cp'].forEach((k) => delete corpo[k]);
        corpo.desconto_valor = numero(f.desconto_valor.value) || null; corpo.desconto_motivo = f.desconto_motivo.value.trim() || null;
        corpo.multa_pct = numero(f.multa_pct.value); corpo.juros_pct_mes = numero(f.juros_pct_mes.value); corpo.desc_pontual_pct = numero(f.desc_pontual_pct.value) || null; corpo.desc_pontual_dias = f.desc_pontual_dias.value === '' ? null : Number(f.desc_pontual_dias.value);
        const r = t.id ? await api('PUT', `/api/tomadores/${t.id}`, corpo) : await api('POST', `/api/empresas/${estado.empresaId}/tomadores`, corpo);
        d.close(); aviso('Cliente salvo.');
        aoSalvar?.(t.id ?? r.id);
      } catch (e) { $('#erro-tomador').textContent = mensagemErro(e); }
    };
  });
}

async function telaTomadores() {
  const lista = await api('GET', `/api/empresas/${estado.empresaId}/tomadores`);
  const aConferir = lista.filter((t) => t.conferir).length;
  const filtro = aConferir ? (telaTomadores.filtro ?? 'todos') : 'todos';
  const vis = filtro === 'conferir' ? lista.filter((t) => t.conferir) : lista;
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Clientes (tomadores)</h1><p class="sutil">Clientes de ${esc(empresa().razao_social)}.</p></div>
      <div><button id="imp-planilha">Importar planilha</button> <button class="primario" id="novo">Cadastrar cliente</button></div></div>
    ${aConferir ? `<nav class="abas" id="filtros-cli"><a href="#" data-f="todos" class="${filtro === 'todos' ? 'ativo' : ''}">Todos (${lista.length})</a><a href="#" data-f="conferir" class="${filtro === 'conferir' ? 'ativo' : ''}">Falta conferir (${aConferir})</a></nav>` : ''}
    ${vis.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Nome</th><th>Documento</th><th>E-mail</th><th>Faturamento</th><th>Desconto</th></tr></thead><tbody>
      ${vis.map((t, i) => `<tr class="clicavel" data-i="${i}"><td>${esc(t.nome)}${t.conferir ? ` <span class="selo-conferir" title="${esc(t.conferir_motivo ?? '')}">Conferir</span>` : ''}</td><td>${fmtDoc(t.documento)}</td><td>${esc(t.email ?? '')}</td><td>${NOME_MODO[t.modo_faturamento] ?? 'Nota'}</td><td>${t.desconto_valor ? brl(t.desconto_valor) : '<span class="dica">—</span>'}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="vazio">Nenhum tomador cadastrado.</div>'}`;
  $('#novo').onclick = () => formTomador(null, telaTomadores);
  $('#imp-planilha').onclick = () => importarPlanilhaClientes();
  conteudo.querySelectorAll('#filtros-cli a').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); telaTomadores.filtro = a.dataset.f; telaTomadores(); }));
  conteudo.querySelectorAll('tr[data-i]').forEach((tr) => (tr.onclick = () => formTomador(vis[tr.dataset.i], telaTomadores)));
}

/** Importa clientes de uma planilha (xlsx/csv) com CNPJ e, se houver, o nome; o sistema consulta cada CNPJ e deixa o cadastro marcado para conferir. */
function importarPlanilhaClientes() {
  const base = `/api/empresas/${estado.empresaId}/tomadores/planilha`;
  abrirDialogo(`<div class="imp-planilha"><h2>Importar clientes de planilha</h2>
    <p class="sutil">Envie um arquivo Excel (.xlsx) ou .csv com o <strong>CNPJ</strong> (ou CPF) e, se quiser, o nome do cliente, em qualquer coluna. Para cada CNPJ o sistema consulta a Receita Federal e preenche o cadastro, que fica marcado como <em>Falta conferir</em>. CPF precisa do nome na planilha.</p>
    <input type="file" id="pl-arq" accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
    <div id="pl-corpo"></div>
    <div class="acoes"><button type="button" data-fechar>Fechar</button></div></div>`, (dlg) => {
    const corpo = dlg.querySelector('#pl-corpo');
    dlg.querySelector('#pl-arq').onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      corpo.innerHTML = '<p class="sutil">Lendo a planilha…</p>';
      try {
        const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f); });
        const a = await api('POST', `${base}/analisar`, { nome: f.name, base64: b64 });
        const r = a.resumo, novos = a.linhas.filter((l) => l.situacao === 'NOVO');
        const ROT = { NOVO: 'Novo', EXISTE: 'Já cadastrado', REPETIDO: 'Repetido', INVALIDO: 'Inválido' };
        corpo.innerHTML = `<p><strong>${r.novos}</strong> novo(s) · ${r.existentes} já cadastrado(s) · ${r.repetidos} repetido(s) · ${r.invalidos} inválido(s)</p>
          ${a.linhas.length ? `<div class="rolagem" style="max-height:260px"><table class="tabela"><thead><tr><th>Linha</th><th>Documento</th><th>Nome na planilha</th><th>Situação</th></tr></thead><tbody>
            ${a.linhas.map((l) => `<tr><td>${l.linha}</td><td>${l.documento ? fmtDoc(l.documento) : '<span class="dica">—</span>'}</td><td>${esc(l.nome ?? '')}</td><td class="${l.situacao === 'NOVO' ? 'cor-verde' : l.situacao === 'INVALIDO' ? 'cor-vermelho' : 'dica'}">${ROT[l.situacao]}${l.motivo && l.situacao !== 'EXISTE' ? ' — ' + esc(l.motivo) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="vazio">Nenhum CNPJ ou CPF encontrado na planilha.</p>'}
          ${novos.length ? `<div class="acoes"><button class="primario" id="pl-ir">Importar ${novos.length} cliente(s)</button></div><div id="pl-prog"></div>` : ''}`;
        const ir = corpo.querySelector('#pl-ir');
        if (ir) ir.onclick = async () => {
          ir.disabled = true; const prog = corpo.querySelector('#pl-prog'); const res = [];
          for (let i = 0; i < novos.length; i += 5) {
            prog.innerHTML = `<p class="sutil">Consultando a Receita e cadastrando… ${Math.min(i + 5, novos.length)} de ${novos.length}</p>`;
            try { res.push(...(await api('POST', `${base}/importar`, { itens: novos.slice(i, i + 5).map((l) => ({ documento: l.documento, nome: l.nome })) })).resultados); }
            catch (e) { novos.slice(i, i + 5).forEach((l) => res.push({ documento: l.documento, ok: false, mensagem: mensagemErro(e) })); }
          }
          const ok = res.filter((x) => x.ok);
          prog.innerHTML = `<div class="banner"><strong>${ok.length} cliente(s) criado(s)</strong>${res.length - ok.length ? `, ${res.length - ok.length} com problema` : ''}. Todos ficam marcados como <em>Falta conferir</em>.</div>
            <div class="rolagem" style="max-height:220px"><table class="tabela"><tbody>${res.map((x) => `<tr><td>${fmtDoc(x.documento)}</td><td>${esc(x.nome ?? '')}</td><td class="${x.ok ? 'cor-verde' : 'cor-vermelho'}">${esc(x.mensagem)}</td></tr>`).join('')}</tbody></table></div>
            <div class="acoes"><button class="primario" id="pl-ver">Ver clientes a conferir</button></div>`;
          prog.querySelector('#pl-ver').onclick = () => { telaTomadores.filtro = 'conferir'; dlg.close(); telaTomadores(); };
        };
      } catch (e) { corpo.innerHTML = `<p class="erro">${esc(mensagemErro(e))}</p>`; }
    };
  });
}

// ---------------------------------------------------------------------------
// Serviços
// ---------------------------------------------------------------------------

let tabelaServicosNac = null;
const semAcento = (v) => String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Busca na Lista Nacional de Serviços (Anexo B do SN-NFS-e) e preenche código + descrição sugerida. */
function ligarBuscaServicos(f) {
  const busca = $('#busca-serv'), lista = $('#res-serv');
  const carregar = async () => {
    if (tabelaServicosNac) return tabelaServicosNac;
    try {
      const r = await fetch('/servicos-nacionais.json');
      tabelaServicosNac = (await r.json()).map((o) => ({ ...o, _k: semAcento(`${o.c} ${o.i} ${o.t} ${o.s} ${o.g}`) }));
    } catch { tabelaServicosNac = []; }
    return tabelaServicosNac;
  };
  const mostrar = async () => {
    const termos = semAcento(busca.value).split(/\s+/).filter(Boolean);
    if (!termos.length) { lista.hidden = true; return; }
    const achados = (await carregar()).filter((o) => termos.every((t) => o._k.includes(t))).slice(0, 30);
    lista.innerHTML = achados.length
      ? achados.map((o) => `<li data-c="${o.c}"><b>${o.c}</b> <span class="sutil">item ${o.i}</span><br>${esc(o.t)}${o.s && o.s !== o.t ? `<br><small class="sutil">${esc(o.s)}</small>` : ''}</li>`).join('')
      : '<li class="sutil">Nenhum serviço encontrado.</li>';
    lista.hidden = false;
  };
  busca.oninput = mostrar;
  lista.onclick = (ev) => {
    const li = ev.target.closest('li[data-c]');
    if (!li) return;
    const o = tabelaServicosNac.find((x) => x.c === li.dataset.c);
    f.elements.c_trib_nac.value = o.c;
    if (!f.elements.descricao.value.trim()) f.elements.descricao.value = o.t;
    if (!f.elements.nome.value.trim()) f.elements.nome.value = o.t.replace(/\.$/, '').slice(0, 80);
    busca.value = `${o.c} — ${o.t}`;
    lista.hidden = true;
  };
}

let tabelaNbs = null;
function ligarBuscaNbs(f) {
  const busca = $('#busca-nbs'), lista = $('#res-nbs');
  const mostrar = async () => {
    const termos = semAcento(busca.value).split(/\s+/).filter(Boolean);
    if (!termos.length) { lista.hidden = true; return; }
    if (!tabelaNbs) {
      try { tabelaNbs = (await (await fetch('/nbs.json')).json()).map((o) => ({ ...o, _k: semAcento(`${o.c} ${o.t}`) })); } catch { tabelaNbs = []; }
    }
    const achados = tabelaNbs.filter((o) => termos.every((t) => o._k.includes(t))).slice(0, 30);
    lista.innerHTML = achados.length
      ? achados.map((o) => `<li data-c="${o.c}"><b>${o.c}</b><br>${esc(o.t)}</li>`).join('')
      : '<li class="sutil">Nenhum NBS encontrado.</li>';
    lista.hidden = false;
  };
  busca.oninput = mostrar;
  lista.onclick = (ev) => {
    const li = ev.target.closest('li[data-c]');
    if (!li) return;
    f.elements.c_nbs.value = li.dataset.c;
    busca.value = `${li.dataset.c} — ${tabelaNbs.find((x) => x.c === li.dataset.c).t}`;
    lista.hidden = true;
  };
}

function formServico(s) {
  s ??= {};
  abrirDialogo(`
    <form id="form-servico"><h2>${s.id ? 'Editar serviço' : 'Novo serviço'}</h2>
      <div class="busca-servico">
        <label>Buscar na lista nacional de serviços (338 códigos)
          <input id="busca-serv" type="search" autocomplete="off" placeholder="Digite o código ou parte da descrição: contab, software, 17.19…"></label>
        <ul id="res-serv" class="res-serv" hidden></ul>
      </div>
      <div class="grade">
        <label class="largo">Nome interno <input name="nome" required placeholder="Ex.: Honorários contábeis mensais" value="${esc(s.nome ?? '')}"></label>
        <label class="largo">Descrição padrão na nota <textarea name="descricao" required>${esc(s.descricao ?? '')}</textarea></label>
        <label>Código de tributação nacional <input name="c_trib_nac" required placeholder="171901" value="${esc(s.c_trib_nac ?? '')}">
          <span class="dica">6 dígitos: item, subitem e desdobro da LC 116</span></label>
        <label>Código municipal <input name="c_trib_mun" maxlength="3" value="${esc(s.c_trib_mun ?? '')}"><span class="dica">Só se o município usar desdobro</span></label>
        <label class="largo">Buscar NBS (lista oficial) <input id="busca-nbs" type="search" autocomplete="off" placeholder="Digite parte da descrição: asseio, limpeza, contabilidade…"></label>
        <ul id="res-nbs" class="res-serv largo" hidden></ul>
        <label>Código NBS <input name="c_nbs" maxlength="9" pattern="\\d{9}" placeholder="9 dígitos" value="${esc(s.c_nbs ?? '')}"><span class="dica">Obrigatório quando informar IBS/CBS</span></label>
        <label>Valor padrão (R$) <input name="valor_padrao" data-num value="${s.valor_padrao ?? ''}"></label>
      </div>
      <fieldset style="margin-top:16px"><legend>Tributação</legend>
        <label>Tributação <select name="tipo_documento_id"><option value="">Padrão da empresa</option></select></label>
        <p class="dica">Alíquota do ISS, retenções, ISSQN, imunidade e IBS/CBS ficam em <a href="#/tributacao/perfis">Tributação</a>: aqui só se escolhe qual vale para este serviço. Ao emitir, tudo vem dela e ainda pode ser trocado na nota.</p>
      </fieldset>
      <p class="erro" id="erro-servico"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar serviço</button>
        ${s.id && podeExcluirRegistros() ? '<button type="button" class="perigo" id="excluir">Desativar</button>' : ''}<button type="button" data-fechar>Fechar</button></div>
    </form>`, (d) => {
    const f = $('#form-servico');
    ligarBuscaServicos(f);
    ligarBuscaNbs(f);
    api('GET', `/api/empresas/${estado.empresaId}/tributacao/tipos`).then((r) => {
      f.tipo_documento_id.insertAdjacentHTML('beforeend', r.tipos.filter((t) => t.sentido === 'SAIDA').map((t) => `<option value="${t.id}" ${s.tipo_documento_id === t.id ? 'selected' : ''}>${esc(t.nome)}${t.perfil_nome && t.perfil_nome !== t.nome ? ' — ' + esc(t.perfil_nome) : ''}</option>`).join(''));
    }).catch(() => { f.tipo_documento_id.closest('fieldset').hidden = true; });
    $('#excluir') && ($('#excluir').onclick = async () => { await api('DELETE', `/api/servicos/${s.id}`); d.close(); telaServicos(); });
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const x = lerForm(f);
      const corpo = {
        nome: x.nome, descricao: x.descricao, c_trib_nac: x.c_trib_nac, c_trib_mun: x.c_trib_mun, c_nbs: x.c_nbs,
        valor_padrao: x.valor_padrao, tipo_documento_id: x.tipo_documento_id ? Number(x.tipo_documento_id) : null,
      };
      try {
        s.id ? await api('PUT', `/api/servicos/${s.id}`, corpo) : await api('POST', `/api/empresas/${estado.empresaId}/servicos`, corpo);
        d.close(); aviso('Serviço salvo.'); telaServicos();
      } catch (e) { $('#erro-servico').textContent = mensagemErro(e); }
    };
  });
}

function resumoTributacao(s) {
  const t = s.tributacao ?? {}, p = [];
  p.push({ 1: 'Tributável', 2: 'Imunidade', 3: 'Exportação', 4: 'Não incidência' }[t.tribISSQN ?? 1]);
  if ((t.issRetido ?? 1) !== 1) p.push('ISS retido');
  const r = [['PIS', t.pPis], ['COFINS', t.pCofins], ['CSLL', t.pCsll], ['IRRF', t.pIrrf], ['CP', t.pCp]].filter(([, v]) => v);
  if (r.length) p.push('Ret.: ' + r.map(([n]) => n).join('/'));
  if (s.ibscbs) p.push('IBS/CBS ' + s.ibscbs.cClassTrib);
  return esc(p.join(' · '));
}

async function telaServicos() {
  const lista = await api('GET', `/api/empresas/${estado.empresaId}/servicos`);
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Serviços</h1><p class="sutil">Modelos com código de tributação e alíquota, para emitir em poucos cliques.</p></div>
      <button class="primario" id="novo">Cadastrar serviço</button></div>
    ${lista.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Nome</th><th>Código nacional</th><th>NBS</th><th>Tributação</th><th class="num">Alíquota</th><th class="num">Valor padrão</th></tr></thead><tbody>
      ${lista.map((s, i) => `<tr class="clicavel" data-i="${i}"><td>${esc(s.nome)}</td><td>${s.c_trib_nac}${s.c_trib_mun ? ' / ' + s.c_trib_mun : ''}</td><td>${s.c_nbs ?? ''}</td><td>${resumoTributacao(s)}</td>
        <td class="num">${s.aliquota != null ? s.aliquota + '%' : '—'}</td><td class="num">${s.valor_padrao ? brl(s.valor_padrao) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="vazio">Cadastre os serviços que esta empresa presta.</div>'}`;
  $('#novo').onclick = () => formServico();
  conteudo.querySelectorAll('tr[data-i]').forEach((tr) => (tr.onclick = () => formServico(lista[tr.dataset.i])));
}

// ---------------------------------------------------------------------------
// Empresas e certificados
// ---------------------------------------------------------------------------

function formEmpresa(e) {
  e ??= { op_simp_nac: 3, reg_ap_trib_sn: 1, reg_esp_trib: 0, ambiente: 2, serie: '1' };
  abrirDialogo(`
    <form id="form-empresa"><h2>${e.id ? 'Editar empresa' : 'Nova empresa'}</h2>
      <div class="grade">
        <label>CNPJ / CPF <span class="linha-campo"><input name="documento" required value="${esc(e.documento ?? '')}"><button type="button" data-buscar-cnpj>Buscar CNPJ</button></span><span class="dica" data-cnpj-info>Digite o CNPJ e clique em Buscar para preencher os dados.</span></label>
        <label class="largo">Razão social <input name="razao_social" required value="${esc(e.razao_social ?? '')}"></label>
        <label>Nome fantasia <input name="nome_fantasia" value="${esc(e.nome_fantasia ?? '')}"></label>
        <label>Inscrição municipal <input name="inscricao_municipal" value="${esc(e.inscricao_municipal ?? '')}"></label>
        <label>CEP (para achar o município) <input name="cep"><span class="dica" data-municipio></span></label>
        <label>Município (IBGE) <input name="cod_municipio" required maxlength="7" value="${esc(e.cod_municipio ?? '')}"></label>
        <label>UF <input name="uf" maxlength="2" value="${esc(e.uf ?? '')}"></label>
        <label>E-mail <input name="email" type="email" value="${esc(e.email ?? '')}"></label>
        <label>Simples Nacional <select name="op_simp_nac" data-num>
          <option value="3">Optante ME/EPP</option><option value="2">MEI</option><option value="1">Não optante</option></select></label>
        <label>Apuração no Simples <select name="reg_ap_trib_sn" data-num>
          <option value="1">Tributos federais e municipal pelo SN</option><option value="2">Federais pelo SN, ISSQN fora</option><option value="3">Federais e ISSQN fora do SN</option></select></label>
        <label>Regime especial <select name="reg_esp_trib" data-num>
          <option value="0">Nenhum</option><option value="1">Ato cooperado</option><option value="2">Estimativa</option><option value="3">Microempresa municipal</option>
          <option value="4">Notário ou registrador</option><option value="5">Profissional autônomo</option><option value="6">Sociedade de profissionais</option></select></label>
        <label>% aproximado de tributos (Simples) <input name="p_tot_trib_sn" data-num value="${e.p_tot_trib_sn ?? ''}"><span class="dica">Lei 12.741 — opcional</span></label>
        <label>Ambiente <select name="ambiente" data-num><option value="2">Produção restrita (testes)</option><option value="1">Produção</option></select></label>
        <label>Série da DPS <input name="serie" maxlength="5" value="${esc(e.serie)}"></label>
        <label class="largo">Como esta empresa emite as notas?
          <select name="modo_emissao"><option value="CERTIFICADO">Pelo sistema, com certificado digital A1</option><option value="PORTAL">Pelo portal do Emissor Nacional (CNPJ e senha), sem certificado</option></select></label>
        <div class="largo" id="bloco-portal" hidden>
          <p class="dica">Sem certificado o sistema não assina nem envia a nota. A nota é emitida no portal e o XML é importado aqui (Notas emitidas → Importar nota do portal), para gerar boletos, cobrança e contabilidade. A senha fica guardada criptografada neste computador e nunca aparece na tela.</p>
          <div class="grade">
            <label>Usuário do portal (CNPJ) <input name="portal_login" autocomplete="off" value="${esc(e.portal_login ?? '')}"></label>
            <label>Senha do portal <input name="portal_senha" type="password" autocomplete="new-password" placeholder="${e.tem_senha_portal ? 'Senha guardada — digite só para trocar' : ''}"></label>
          </div>
        </div>
      </div>
      <p class="erro" id="erro-empresa"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar empresa</button><button type="button" data-fechar>Fechar</button></div>
    </form>`, (d) => {
    const f = $('#form-empresa');
    for (const c of ['op_simp_nac', 'reg_ap_trib_sn', 'reg_esp_trib', 'ambiente']) if (e[c] != null) f[c].value = e[c];
    f.modo_emissao.value = e.modo_emissao ?? 'CERTIFICADO';
    const modo = () => ($('#bloco-portal').hidden = f.modo_emissao.value !== 'PORTAL');
    f.modo_emissao.onchange = modo; modo();
    f.cep.onblur = () => buscarCep(f);
    ligarConsultaCnpj(f, 'empresa');
    const sn = () => (f.reg_ap_trib_sn.disabled = f.op_simp_nac.value !== '3');
    f.op_simp_nac.onchange = sn; sn();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const corpo = lerForm(f);
      delete corpo.cep;
      if (corpo.ambiente === 1 && e.ambiente !== 1 && !confirm('Mudar para PRODUÇÃO? As próximas notas terão valor fiscal.')) return;
      try {
        e.id ? await api('PUT', `/api/empresas/${e.id}`, corpo) : await api('POST', '/api/empresas', corpo);
        d.close(); aviso('Empresa salva.'); await carregarEmpresas(); telaEmpresas();
      } catch (er) { $('#erro-empresa').textContent = mensagemErro(er); }
    };
  });
}

function formLogo(e) {
  abrirDialogo(`
    <form id="form-logo"><h2>Logo — ${esc(e.razao_social)}</h2>
      <p class="sutil">Aparece no cabeçalho do PDF (DANFSe) das notas desta empresa. PNG ou JPG, até 1 MB; fundo claro/transparente funciona melhor.</p>
      <label>Imagem <input type="file" name="arquivo" accept="image/png,image/jpeg" ${e.tem_logo ? '' : 'required'}></label>
      <p class="erro" id="erro-logo"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar logo</button>
        ${e.tem_logo ? '<button type="button" class="perigo" id="rm-logo">Remover logo</button>' : ''}<button type="button" data-fechar>Fechar</button></div>
    </form>`, (d) => {
    const pronto = async (msg) => { d.close(); aviso(msg); await carregarEmpresas(); telaEmpresas(); };
    $('#rm-logo') && ($('#rm-logo').onclick = async () => { await api('DELETE', `/api/empresas/${e.id}/logo`); pronto('Logo removida.'); });
    $('#form-logo').onsubmit = async (ev) => {
      ev.preventDefault();
      const arq = ev.target.arquivo.files[0];
      if (!arq) return d.close();
      const fd = new FormData(); fd.append('arquivo', arq);
      try { await api('POST', `/api/empresas/${e.id}/logo`, fd); pronto('Logo salva.'); }
      catch (er) { $('#erro-logo').textContent = mensagemErro(er); }
    };
  });
}

function formCertificado(e) {
  abrirDialogo(`
    <form id="form-cert"><h2>Certificado A1 — ${esc(e.razao_social)}</h2>
      <p class="sutil">Arquivo .pfx ou .p12 do e-CNPJ. Ele é guardado criptografado e usado apenas para assinar e transmitir as notas desta empresa.</p>
      <div class="grade">
        <label class="largo">Arquivo <input type="file" name="arquivo" accept=".pfx,.p12" required></label>
        <label>Senha do certificado <input type="password" name="senha" required autocomplete="off"></label>
      </div>
      <p class="erro" id="erro-cert"></p>
      <div class="acoes"><button class="primario" type="submit">Enviar certificado</button><button type="button" data-fechar>Fechar</button></div>
    </form>`, (d) => {
    $('#form-cert').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const fd = new FormData();
      fd.append('senha', f.senha.value);
      fd.append('arquivo', f.arquivo.files[0]);
      try {
        const r = await api('POST', `/api/empresas/${e.id}/certificado`, fd);
        d.close(); aviso(`Certificado de ${r.titular} válido até ${new Date(r.validade).toLocaleDateString('pt-BR')}.`);
        await carregarEmpresas(); telaEmpresas();
      } catch (er) { $('#erro-cert').textContent = mensagemErro(er); }
    };
  });
}

async function telaEmpresas() {
  await carregarEmpresas();
  const lista = estado.empresas;
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Empresas</h1><p class="sutil">Prestadores que emitem pelo escritório. Cada um com seu certificado A1.</p></div>
      <button class="primario" id="novo">Cadastrar empresa</button></div>
    ${lista.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Empresa</th><th>Documento</th><th>Regime</th><th>Ambiente</th><th>Certificado</th><th></th></tr></thead><tbody>
      ${lista.map((e, i) => `<tr><td>${esc(e.razao_social)}</td><td>${fmtDoc(e.documento)}</td><td>${['', 'Não optante', 'MEI', 'Simples ME/EPP'][e.op_simp_nac]}</td>
        <td>${e.ambiente === 1 ? 'Produção' : 'Testes'}</td><td>${e.modo_emissao === 'PORTAL' ? 'Portal (CNPJ e senha)' : e.tem_certificado ? `até ${dataBr(e.cert_validade)}` : '<span class="pendente-txt">Falta enviar</span>'}</td>
        <td><button data-editar="${i}">Editar</button> ${e.modo_emissao === 'PORTAL' ? '' : `<button data-cert="${i}">Certificado</button>`} <button data-logo="${i}">${e.tem_logo ? 'Logo ✓' : 'Logo'}</button> <button data-banco="${i}">Dados bancários</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="vazio">Cadastre a primeira empresa cliente do escritório.</div>'}`;
  $('#novo').onclick = () => formEmpresa();
  conteudo.querySelectorAll('[data-editar]').forEach((b) => (b.onclick = () => formEmpresa(lista[b.dataset.editar])));
  conteudo.querySelectorAll('[data-cert]').forEach((b) => (b.onclick = () => formCertificado(lista[b.dataset.cert])));
  conteudo.querySelectorAll('[data-logo]').forEach((b) => (b.onclick = () => formLogo(lista[b.dataset.logo])));
  conteudo.querySelectorAll('[data-banco]').forEach((b) => (b.onclick = () => {
    estado.empresaId = lista[b.dataset.banco].id; localStorage.setItem('empresaId', estado.empresaId);
    api('PUT', '/api/me/empresa', { id: estado.empresaId }).catch(() => {});
    $('#empresa-atual').value = estado.empresaId; infoEmpresa(); location.hash = '#/banco';
  }));
}

// ---------------------------------------------------------------------------
// Usuários
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Configurações (usuários e acessos, e-mail, backup, licença, atualizações)
// ---------------------------------------------------------------------------

const corpoConfig = () => $('#cfg-corpo') ?? conteudo;

async function telaConfig(aba) {
  const adm = estado.usuario.tipo === 'adm';
  const abas = [
    ['conta', 'Minha conta', true], ['usuarios', 'Usuários e acessos', adm], ['email', 'E-mail', adm], ['modelos', 'Modelos de e-mail', adm],
    ['aparencia', 'Aparência', true], ['backup', 'Backup', adm], ['contabilidade', 'Contabilidade', adm], ['licenca', 'Licença', true], ['atualizacoes', 'Atualizações', true],
  ].filter((x) => x[2]);
  if (!abas.some((x) => x[0] === aba)) aba = abas[0][0];
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Configurações</h1><p class="sutil">Ajustes gerais do sistema${adm ? '' : ' e da sua conta'}.</p></div></div>
    <nav class="abas" aria-label="Configurações">${abas.map(([k, nome]) => `<a href="#/config/${k}" class="${k === aba ? 'ativo' : ''}">${nome}</a>`).join('')}</nav>
    <div id="cfg-corpo"></div>`;
  const tela = { conta: telaMinhaConta, usuarios: telaUsuarios, email: telaEmail, modelos: telaModelosEmail, aparencia: telaAparencia, backup: telaBackup, contabilidade: telaContabilidade, licenca: telaLicenca, atualizacoes: telaAtualizacoes }[aba];
  await tela();
}

function telaMinhaConta() {
  const u = estado.usuario;
  corpoConfig().innerHTML = `
    <h2>Minha conta</h2>
    <div class="cartao">
      <div class="conta-avatar">${avatarSvg(u.avatar, 56) || `<span class="avatar-iniciais">${esc(iniciaisDoUsuario())}</span>`}<div>
      <p><strong>${esc(u.nome)}</strong> · usuário <strong>${esc(u.login)}</strong></p>
      <p class="sutil">Perfil: ${u.tipo === 'adm' ? 'Administrador (acesso total)' : 'Normal'}${u.email ? ' · ' + esc(u.email) : ' · sem e-mail cadastrado (a recuperação de senha por e-mail não fica disponível)'}</p></div></div>
      ${u.tipo === 'adm' ? '' : `<p class="sutil">Funcionalidades liberadas: ${u.modulos.length ? u.modulos.map((m) => esc(u.todosModulos[m])).join(', ') : 'nenhuma'}.</p>`}
      <div class="acoes"><button class="primario" id="alterar-senha">Alterar minha senha</button><button type="button" id="trocar-avatar">Escolher avatar</button></div>
    </div>`;
  $('#alterar-senha').onclick = () => trocarSenha();
  $('#trocar-avatar').onclick = () => escolherAvatar(() => telaMinhaConta());
}

const TEMAS = [
  { id: 'preto-laranja', nome: 'Preto e laranja', cores: ['#0f0f0f', '#0a0a0a', '#fb923d'] },
  { id: 'branco-laranja', nome: 'Branco e laranja', cores: ['#ffffff', '#f6f3ef', '#d9600c'] },
  { id: 'azul-dourado', nome: 'Azul e dourado', cores: ['#060d1d', '#091226', '#dcb25a'] },
  { id: 'azul-roxo', nome: 'Azul e roxo', cores: ['#070b22', '#0a0f2b', '#a78bfa'] },
  { id: 'verde-esmeralda', nome: 'Verde petróleo e esmeralda', cores: ['#071918', '#091e1e', '#10B981'] },
  { id: 'grafite-azul', nome: 'Grafite e azul elétrico', cores: ['#10131f', '#131726', '#38BDF8'] },
  { id: 'marrom-champagne', nome: 'Marrom e champagne', cores: ['#211915', '#271e19', '#D6A77A'] },
  { id: 'roxo-rosa', nome: 'Roxo e rosa', cores: ['#191627', '#1e1b30', '#E879A9'] },
];
function aplicarTema(id) {
  document.documentElement.dataset.tema = id;
  try { localStorage.setItem('tema', id); } catch { /* sem armazenamento: vale só nesta sessão */ }
}

function telaAparencia() {
  const atual = document.documentElement.dataset.tema || 'preto-laranja';
  corpoConfig().innerHTML = `
    <h2>Aparência</h2>
    <div class="cartao"><p class="sutil">Escolha as cores do sistema. A escolha vale para este computador e é guardada para as próximas vezes.</p>
      <div class="temas">${TEMAS.map((t) => `<button type="button" class="tema-opcao ${t.id === atual ? 'ativo' : ''}" data-tema="${t.id}" aria-pressed="${t.id === atual}">
        <span class="tema-amostra" style="background:${t.cores[1]}"><i style="background:${t.cores[0]}"></i><b style="background:${t.cores[2]}"></b></span>
        <strong>${t.nome}</strong></button>`).join('')}</div></div>`;
  corpoConfig().querySelectorAll('[data-tema]').forEach((b) => (b.onclick = () => { aplicarTema(b.dataset.tema); telaAparencia(); }));
}

/** E-mail da contabilidade e envio automático do fechamento do mês anterior no dia escolhido. */
async function carregarFechamento() {
  const box = $('#cartao-fechamento'); if (!box || !estado.empresaId) { if (box) box.innerHTML = ''; return; }
  const url = `/api/empresas/${estado.empresaId}/contabilidade`;
  let c; try { c = await api('GET', `${url}/config`); } catch (e) { box.innerHTML = `<p class="erro">${esc(mensagemErro(e))}</p>`; return; }
  const hoje = new Date(Date.now() - 3 * 3600e3), ant = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  box.innerHTML = `<h3 style="margin-top:0">Fechamento mensal automático</h3>
    <p class="sutil">Guarda o e-mail da contabilidade e, no dia escolhido, envia sozinho o pacote completo (notas emitidas, notas de entrada, extrato em OFX e planilhas) do <strong>mês anterior</strong>. Usa o e-mail do escritório configurado em <em>E-mail</em>. Se o sistema estiver fechado no dia, o envio sai na primeira vez que for aberto depois.</p>
    <form id="form-fech" class="grade">
      <label class="largo">E-mail da contabilidade <span class="dica">(até 5, separados por vírgula)</span><input name="emails" value="${esc(c.emails)}" placeholder="contador@escritorio.com.br"></label>
      <label class="largo"><span><input type="checkbox" name="ativo" ${c.ativo ? 'checked' : ''}> Enviar automaticamente todo mês</span></label>
      <label>No dia <select name="dia">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${c.dia === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
      <p class="dica largo">${c.resultado ? `Último envio${c.em ? ' (' + dataHoraBr(c.em.replace(' ', 'T') + 'Z') + ')' : ''}: ${esc(c.resultado)}${c.ultimo ? ' · mês fechado ' + c.ultimo.split('-').reverse().join('/') : ''}` : 'Nenhum envio feito ainda.'}</p>
      <p class="erro largo" id="erro-fech"></p>
      <div class="acoes largo"><button class="primario" type="submit">Salvar</button>
        <label style="display:inline-flex;gap:6px;align-items:center">Enviar agora o mês <input type="month" id="fech-mes" value="${ant}" style="width:auto"></label>
        <button type="button" id="fech-agora">Enviar agora</button></div>
    </form>`;
  const f = $('#form-fech');
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('PUT', `${url}/config`, { emails: f.emails.value, ativo: f.ativo.checked, dia: Number(f.dia.value) }); aviso('Fechamento automático salvo.'); carregarFechamento(); }
    catch (e) { $('#erro-fech').textContent = mensagemErro(e); }
  };
  $('#fech-agora').onclick = async (ev) => {
    const b = ev.target; b.disabled = true; b.textContent = 'Enviando…'; $('#erro-fech').textContent = '';
    try {
      await api('PUT', `${url}/config`, { emails: f.emails.value, ativo: f.ativo.checked, dia: Number(f.dia.value) });
      const r = await api('POST', `${url}/enviar`, { mes: $('#fech-mes').value }); aviso(`Fechamento enviado para ${r.para.join(', ')}.`);
    } catch (e) { $('#erro-fech').textContent = mensagemErro(e); }
    carregarFechamento();
  };
}

async function telaContabilidade() {
  const e = empresa();
  const hoje0 = new Date(Date.now() - 3 * 3600e3), ini = new Date(Date.UTC(hoje0.getUTCFullYear(), hoje0.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const fim = new Date(Date.UTC(hoje0.getUTCFullYear(), hoje0.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  corpoConfig().innerHTML = `
    <h2>Exportar para a contabilidade</h2>
    <div class="cartao">
      <p class="sutil">Gera um único arquivo ZIP para enviar ao contador, da empresa selecionada${e ? ': <strong>' + esc(e.razao_social) + '</strong>' : ''}. Para trocar a empresa, use o seletor no topo.</p>
      <form id="form-contab" class="grade">
        <label>De <input type="date" name="de" required value="${ini}"></label>
        <label>Até <input type="date" name="ate" required value="${fim}"></label>
        <label class="largo"><span><input type="checkbox" name="xml" checked> XML das notas emitidas</span></label>
        <label class="largo"><span><input type="checkbox" name="pdf" checked> PDF (DANFSe) das notas emitidas</span></label>
        <label class="largo"><span><input type="checkbox" name="entradas" checked> XML das notas de entrada lançadas em Compras</span></label>
        <label class="largo"><span><input type="checkbox" name="sefaz" checked> XML das notas recebidas da SEFAZ ainda não lançadas</span>
          <span class="dica">Entradas pela data de emissão, com uma planilha (fornecedor, valor, chave, parcelas). As não lançadas e as canceladas pelo fornecedor vêm marcadas.</span></label>
        <label class="largo"><span><input type="checkbox" name="ofx" checked> Extrato em OFX (do extrato importado; sem ele, boletos recebidos e despesas lançadas)</span>
          <span class="dica">Também vai uma planilha com a mesma movimentação, e outra com a lista das notas. As notas são escolhidas pela competência.</span></label>
        <p class="erro" id="erro-contab"></p>
        <div class="acoes largo"><button class="primario" type="submit" ${e ? '' : 'disabled'}>Gerar pacote (ZIP)</button></div>
      </form>
    </div>
    <div class="cartao" id="cartao-fechamento"><h3 style="margin-top:0">Fechamento mensal automático</h3><p class="sutil">Carregando…</p></div>`;
  carregarFechamento();
  $('#form-contab').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target, b = f.querySelector('[type=submit]');
    b.disabled = true; b.textContent = 'Gerando…'; $('#erro-contab').textContent = '';
    const p = new URLSearchParams({ empresaId: estado.empresaId, de: f.de.value, ate: f.ate.value, xml: +f.xml.checked, pdf: +f.pdf.checked, ofx: +f.ofx.checked, entradas: +f.entradas.checked, sefaz: +f.sefaz.checked });
    try { await baixar(`/api/contabilidade/exportar?${p}`, `contabilidade_${f.de.value}_${f.ate.value}.zip`); } finally { b.disabled = false; b.textContent = 'Gerar pacote (ZIP)'; }
  };
}

async function telaAtualizacoes() {
  const ponte = window.nfseDesktop;
  const st = await fetch('/api/setup/status').then((r) => r.json()).catch(() => ({}));
  const desc = (e) => {
    if (!e || e.situacao === 'nunca') return 'Ainda não verificado nesta sessão.';
    if (e.situacao === 'nova') return `Nova versão ${e.versao} disponível.`;
    if (e.situacao === 'erro') return e.erro;
    if (e.situacao === 'nao_configurado') return 'Atualização automática não configurada.';
    if (e.situacao === 'sem_release') return 'Nenhuma versão publicada ainda.';
    if (e.situacao === 'sem_instalador') return `A versão ${e.versao} foi publicada, mas o instalador ainda não está disponível. Tente de novo em alguns minutos.`;
    return 'Você está na versão mais recente.';
  };
  corpoConfig().innerHTML = `
    <h2>Atualizações</h2>
    <div class="cartao">
      <p>Versão instalada: <strong>${esc(st.versao ?? '')}</strong></p>
      ${ponte?.verificarAtualizacao ? `
        <p class="sutil">O sistema procura versões novas sozinho ao abrir, a cada hora e quando você volta à janela. Quando houver uma, aparece um aviso no topo da tela.</p>
        <p id="atu-status" class="sutil">Consultando…</p>
        <div id="atu-notas" class="novidades-caixa" hidden></div>
        <div class="acoes"><button class="primario" id="atu-verificar">Verificar agora</button><button id="atu-instalar" hidden>Atualizar agora</button>${ponte.baixarAtualizacao ? '<button id="atu-baixar-fechar" hidden>Baixar e instalar ao fechar</button><button id="atu-baixar" hidden>Só baixar</button>' : ''}</div>`
        : '<p class="sutil">A busca automática de atualizações funciona no aplicativo instalado no Windows. Neste modo de uso, a atualização é feita com o instalador novo.</p>'}
    </div>`;
  if (!ponte?.verificarAtualizacao) return;
  const mostrar = (e) => {
    $('#atu-status').textContent = desc(e) + (e?.em ? ` (verificado às ${new Date(e.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})` : '');
    $('#atu-instalar').hidden = e?.situacao !== 'nova';
    $('#atu-baixar') && ($('#atu-baixar').hidden = $('#atu-baixar-fechar').hidden = e?.situacao !== 'nova');
    const n = $('#atu-notas'); n.hidden = !(e?.situacao === 'nova' && e.notas);
    if (!n.hidden) n.innerHTML = `<strong>Novidades da versão ${esc(e.versao)}</strong><br>${esc(e.notas).replace(/\n/g, '<br>')}`;
  };
  mostrar(await ponte.estadoAtualizacao().catch(() => null));
  $('#atu-verificar').onclick = async (ev) => {
    ev.target.disabled = true; ev.target.textContent = 'Verificando…';
    try { mostrar(await ponte.verificarAtualizacao()); } catch { $('#atu-status').textContent = 'Não foi possível verificar agora.'; }
    ev.target.disabled = false; ev.target.textContent = 'Verificar agora';
  };
  const baixarAtu = (aoFechar) => async (ev) => {
    ev.target.disabled = true; const t = ev.target.textContent; ev.target.textContent = 'Baixando…';
    const r = await ponte.baixarAtualizacao(aoFechar);
    ev.target.disabled = false; ev.target.textContent = t;
    if (!r?.ok) return aviso(r?.erro ?? 'Não foi possível baixar agora.');
    $('#atu-status').textContent = aoFechar ? `Versão ${r.versao} baixada: será instalada quando você fechar o Kontor.` : `Versão ${r.versao} baixada. Use "Atualizar agora" para instalar quando quiser.`;
    $('#atu-instalar').textContent = 'Instalar agora';
  };
  $('#atu-baixar') && ($('#atu-baixar').onclick = baixarAtu(false));
  $('#atu-baixar-fechar') && ($('#atu-baixar-fechar').onclick = baixarAtu(true));
  $('#atu-instalar').onclick = async (ev) => {
    ev.target.disabled = true; ev.target.textContent = 'Baixando…';
    const r = await ponte.instalarAtualizacao();
    if (!r?.ok) { ev.target.disabled = false; ev.target.textContent = 'Atualizar agora'; aviso(r?.erro ?? 'Não foi possível atualizar agora.'); }
  };
}

async function telaUsuarios() {
  const lista = await api('GET', '/api/usuarios');
  const nomeEmpresa = (id) => esc(estado.empresas.find((e) => e.id === Number(id))?.razao_social ?? id);
  corpoConfig().innerHTML = `
    <div class="topo"><div><h2>Usuários e acessos</h2>
      <p class="sutil"><strong>Administrador</strong> tem acesso total e redefine senhas. <strong>Normal</strong> acessa só as funcionalidades marcadas para ele.</p></div>
      <button class="primario" id="novo">Adicionar usuário</button></div>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Usuário</th><th>Nome</th><th>Perfil</th><th>Acessos</th><th>Empresas</th><th></th></tr></thead><tbody>
      ${lista.map((x) => `<tr class="${x.ativo ? '' : 'inativo'}"><td><strong>${esc(x.login)}</strong>${x.mestre ? ' <span class="sutil">(master Kontor)</span>' : ''}${x.ativo ? '' : ' <span class="sutil">(inativo)</span>'}</td>
        <td>${esc(x.nome)}${x.email ? `<br><span class="sutil">${esc(x.email)}</span>` : ''}</td>
        <td>${x.tipo === 'adm' ? 'Administrador' : 'Normal'}${x.trocar_senha ? '<br><span class="sutil">senha provisória</span>' : ''}</td>
        <td>${x.tipo === 'adm' ? 'Tudo' : x.modulos.length ? x.modulos.map((m) => esc(estado.usuario.todosModulos[m])).join(', ') : '—'}</td>
        <td>${x.tipo !== 'adm' && x.empresas ? x.empresas.split(',').map(nomeEmpresa).join(', ') : 'Todas'}</td>
        <td class="acoes-linha">${x.mestre ? '' : `<button data-editar="${x.id}">Editar</button> <button data-reset="${x.id}">Redefinir senha</button>`}</td></tr>`).join('')}
    </tbody></table></div>`;
  $('#novo').onclick = () => formUsuario(null, lista);
  corpoConfig().querySelectorAll('[data-editar]').forEach((b) => (b.onclick = () => formUsuario(lista.find((x) => x.id === Number(b.dataset.editar)), lista)));
  corpoConfig().querySelectorAll('[data-reset]').forEach((b) => (b.onclick = () => {
    const x = lista.find((y) => y.id === Number(b.dataset.reset));
    abrirDialogo(`<form id="form-reset"><h2>Redefinir senha</h2>
      <p>O sistema vai gerar uma senha provisória para <strong>${esc(x.login)}</strong> (${esc(x.nome)}), que você entrega à pessoa. Ela terá de criar uma senha nova no próximo acesso e será desconectada agora.</p>
      <p class="erro" id="erro-reset"></p>
      <div class="acoes"><button class="primario" type="submit">Redefinir</button><button type="button" data-fechar>Cancelar</button></div></form>`, (d) => {
      $('#form-reset').onsubmit = async (ev) => {
        ev.preventDefault();
        try { const r = await api('POST', `/api/usuarios/${x.id}/redefinir-senha`, {}); d.close(); telaUsuarios(); mostrarSenhaProvisoria(x.login, r.senhaProvisoria); }
        catch (e) { $('#erro-reset').textContent = mensagemErro(e); }
      };
    });
  }));
}

/** Mostra a senha provisória uma única vez (ela não fica guardada em lugar nenhum). */
function mostrarSenhaProvisoria(login, senha) {
  abrirDialogo(`<div><h2>Senha provisória</h2>
    <p>Entregue esta senha a <strong>${esc(login)}</strong> por um canal reservado. Ela só aparece agora, e a pessoa terá de criar uma senha nova no primeiro acesso.</p>
    <p style="font-family:ui-monospace,monospace;font-size:22px;letter-spacing:1px;user-select:all;padding:10px 14px;border:1px solid var(--borda, #444);border-radius:8px;display:inline-block">${esc(senha)}</p>
    <div class="acoes"><button type="button" class="primario" id="copiar-provisoria">Copiar</button><button type="button" data-fechar>Fechar</button></div></div>`, () => {
    $('#copiar-provisoria').onclick = async () => { try { await navigator.clipboard.writeText(senha); aviso('Senha copiada.'); } catch { aviso('Selecione a senha e copie manualmente.'); } };
  });
}

function formUsuario(x, lista) {
  const novo = !x;
  const modulos = estado.usuario.todosModulos;
  const marcado = (m) => (x ? x.modulos.includes(m) : ['painel', 'emitir', 'notas'].includes(m));
  const vinculadas = new Set((x?.empresas ?? '').split(',').filter(Boolean).map(Number));
  abrirDialogo(`
    <form id="form-usuario"><h2>${novo ? 'Novo usuário' : 'Editar usuário'}</h2>
      <div class="grade">
        <label>Usuário (login) <input name="login" required minlength="3" maxlength="30" pattern="[A-Za-z0-9._\-]+" style="text-transform:uppercase" ${novo ? '' : 'disabled'} value="${esc(x?.login ?? '')}">
          <span class="dica">${novo ? 'Definido agora e não muda depois. Sem espaços nem acentos; fica em MAIÚSCULAS.' : 'O usuário não pode ser alterado.'}</span></label>
        <label>Nome <input name="nome" required value="${esc(x?.nome ?? '')}"></label>
        <label>E-mail <input name="email" type="email" value="${esc(x?.email ?? '')}"><span class="dica">Necessário para o "esqueci minha senha".</span></label>
        <label>Perfil <select name="tipo"><option value="normal" ${x?.tipo !== 'adm' ? 'selected' : ''}>Normal (acessos marcados abaixo)</option><option value="adm" ${x?.tipo === 'adm' ? 'selected' : ''}>Administrador (acesso total)</option></select></label>
        ${novo ? '<label>Senha inicial <input name="senha" type="password" minlength="8" autocomplete="new-password"><span class="dica">Em branco = o sistema gera uma senha provisória, e a pessoa será obrigada a trocá-la no primeiro acesso.</span></label>' : `<label class="largo"><span><input type="checkbox" name="ativo" ${x.ativo ? 'checked' : ''}> Usuário ativo (desmarque para bloquear o acesso)</span></label>`}
      </div>
      <fieldset id="grupo-modulos" style="margin-top:16px"><legend>Funcionalidades liberadas</legend>
        ${Object.entries(modulos).map(([k, nome]) => `<label><span><input type="checkbox" name="mod" value="${k}" ${marcado(k) ? 'checked' : ''}> ${esc(nome)}</span></label>`).join('')}
        <p class="dica">Configurações (usuários, e-mail, backup, ativação de licença) são sempre exclusivas de administradores.</p>
      </fieldset>
      <fieldset id="grupo-empresas" style="margin-top:12px"><legend>Empresas que este usuário pode acessar</legend>
        ${estado.empresas.map((e) => `<label><span><input type="checkbox" name="emp" value="${e.id}" ${vinculadas.has(e.id) ? 'checked' : ''}> ${esc(e.razao_social)}</span></label>`).join('')}
        <p class="dica">Sem nenhuma marcada, o usuário enxerga todas as empresas.</p>
      </fieldset>
      <p class="erro" id="erro-usuario"></p>
      <div class="acoes"><button class="primario" type="submit">${novo ? 'Adicionar usuário' : 'Salvar'}</button><button type="button" data-fechar>Fechar</button></div>
    </form>`, (d) => {
    const f = $('#form-usuario');
    const ajustar = () => { const adm = f.tipo.value === 'adm'; $('#grupo-modulos').hidden = adm; $('#grupo-empresas').hidden = adm; };
    f.tipo.onchange = ajustar; ajustar();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const permissoes = [...f.querySelectorAll('[name=mod]:checked')].map((c) => c.value);
      const empresas = [...f.querySelectorAll('[name=emp]:checked')].map((c) => Number(c.value));
      try {
        if (novo) {
          const r = await api('POST', '/api/usuarios', { login: f.login.value.trim().toUpperCase(), nome: f.nome.value, email: f.email.value, senha: f.senha.value, tipo: f.tipo.value, permissoes, empresas });
          if (r.senhaProvisoria) { d.close(); telaUsuarios(); mostrarSenhaProvisoria(r.login ?? f.login.value.trim().toUpperCase(), r.senhaProvisoria); return; }
          aviso('Usuário criado.');
        } else {
          await api('PUT', `/api/usuarios/${x.id}`, { nome: f.nome.value, email: f.email.value, tipo: f.tipo.value, permissoes, empresas, ativo: f.ativo.checked });
          aviso('Usuário atualizado.');
        }
        d.close(); telaUsuarios();
      } catch (e) { $('#erro-usuario').textContent = mensagemErro(e); }
    };
  });
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

const PROVEDORES = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true, dica: 'Gmail: ative a verificação em duas etapas e crie uma "senha de app" em myaccount.google.com/apppasswords. Use essa senha aqui, não a senha normal.' },
  outlook: { host: 'smtp.office365.com', port: 587, secure: false, dica: 'Outlook/Microsoft 365: use uma senha de aplicativo (ou habilite SMTP autenticado na conta).' },
  outro: { host: '', port: 587, secure: false, dica: 'Peça ao provedor do e-mail (ou ao responsável pelo domínio) o servidor SMTP, a porta e o tipo de segurança.' },
};

async function telaEmail() {
  const c = (await api('GET', '/api/email/config')) ?? { host: '', port: 587, secure: false, usuario: '', remetente_nome: estado.usuario.nome ? '' : '', remetente_email: '' };
  corpoConfig().innerHTML = `
    <div class="topo"><div><h1>E-mail</h1><p class="sutil">Servidor usado para enviar a NFS-e (PDF e XML) ao tomador. A senha fica criptografada neste computador.</p></div></div>
    <form id="form-smtp" class="cartao">
      <div class="grade">
        <label>Provedor <select id="provedor"><option value="gmail">Gmail</option><option value="outlook">Outlook / Microsoft 365</option><option value="outro" ${c.host && !/gmail|office365/.test(c.host) ? 'selected' : ''}>Outro</option></select></label>
        <label>Servidor SMTP <input name="host" required value="${esc(c.host)}"></label>
        <label>Porta <input name="port" data-num required value="${c.port}"></label>
        <label>Segurança <select name="secure"><option value="0">STARTTLS (porta 587)</option><option value="1" ${c.secure ? 'selected' : ''}>SSL (porta 465)</option></select></label>
        <label>Usuário (e-mail de login) <input name="usuario" required autocomplete="off" value="${esc(c.usuario)}"></label>
        <label>Senha (ou senha de aplicativo) <input name="senha" type="password" autocomplete="new-password" placeholder="${c.tem_senha ? 'já salva — deixe em branco para manter' : ''}" ${c.tem_senha ? '' : 'required'}></label>
        <label>Nome do remetente <input name="remetente_nome" required placeholder="Escritório Silva Contabilidade" value="${esc(c.remetente_nome)}"></label>
        <label>E-mail do remetente <input name="remetente_email" type="email" required value="${esc(c.remetente_email)}"></label>
      </div>
      <p class="dica" id="dica-provedor"></p>
      <p class="erro" id="erro-smtp"></p>
      <div class="acoes"><button class="primario" type="submit">Salvar</button>
        <button type="button" id="testar" ${c.host ? '' : 'disabled'}>Enviar e-mail de teste</button></div>
    </form>
    <p class="sutil">O e-mail sai em nome do escritório e o cliente responde para o e-mail cadastrado da empresa emitente. Só notas em <b>Produção</b> podem ser enviadas. O texto de cada e-mail é editável na aba <a href="#/config/modelos">Modelos de e-mail</a>.</p>`;
  const f = $('#form-smtp');
  const dica = () => ($('#dica-provedor').textContent = PROVEDORES[$('#provedor').value].dica);
  $('#provedor').onchange = () => { const p = PROVEDORES[$('#provedor').value]; if (p.host) { f.host.value = p.host; f.port.value = p.port; f.secure.value = p.secure ? '1' : '0'; } dica(); };
  dica();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = lerForm(f);
    try {
      await api('PUT', '/api/email/config', { host: d.host, port: d.port, secure: d.secure === '1', usuario: d.usuario, senha: d.senha || null, remetente_nome: d.remetente_nome, remetente_email: d.remetente_email });
      aviso('Configuração de e-mail salva.'); telaEmail();
    } catch (e) { $('#erro-smtp').textContent = mensagemErro(e); }
  };
  // window.prompt() não existe no aplicativo instalado (Electron): usa uma janela própria
  $('#testar').onclick = () => abrirDialogo(`
    <form id="form-teste"><h2>E-mail de teste</h2>
      <p class="sutil">Envia uma mensagem simples com a configuração salva para conferir se está tudo certo.</p>
      <label>Enviar para <input name="para" type="email" required value="${esc(estado.usuario.email ?? '')}"></label>
      <p class="erro" id="erro-teste"></p>
      <div class="acoes"><button class="primario" type="submit">Enviar teste</button><button type="button" data-fechar>Fechar</button></div>
    </form>`, (d) => {
    $('#form-teste').onsubmit = async (ev) => {
      ev.preventDefault();
      const botao = ev.target.querySelector('[type=submit]');
      botao.disabled = true; botao.textContent = 'Enviando…';
      try { await api('POST', '/api/email/testar', { para: ev.target.para.value }); d.close(); aviso('E-mail de teste enviado. Confira a caixa de entrada (e o spam).'); }
      catch (e) { $('#erro-teste').textContent = mensagemErro(e); botao.disabled = false; botao.textContent = 'Enviar teste'; }
    };
  });
  // Assinatura no fim dos e-mails
  corpoConfig().insertAdjacentHTML('beforeend', `<section class="cartao" style="margin-top:16px"><h2 style="margin-top:0">Assinatura dos e-mails</h2>
    <p class="sutil">A imagem vai no fim de todos os e-mails que o Kontor manda aos clientes: notas, cancelamentos, boletos, Pix, fechamentos e o e-mail de teste. Use PNG ou JPG com até uns 800 pixels de largura (no máximo 600 KB).</p>
    <div id="ass-previa"></div>
    <div class="acoes"><label class="botao-arquivo"><input type="file" id="ass-arquivo" accept="image/png,image/jpeg,image/gif" hidden><span class="botao">Escolher imagem…</span></label><button type="button" id="ass-remover" hidden>Remover assinatura</button></div>
    <p class="erro" id="ass-erro"></p></section>`);
  const previaAss = async () => {
    try {
      const r = await api('GET', '/api/email/assinatura');
      if (!r.tem) throw 0;
      $('#ass-previa').innerHTML = `<img src="${r.imagem}" alt="Assinatura" class="ass-img">`; $('#ass-remover').hidden = false;
    } catch { $('#ass-previa').innerHTML = '<p class="dica">Nenhuma assinatura cadastrada.</p>'; $('#ass-remover').hidden = true; }
  };
  $('#ass-arquivo').onchange = (ev) => {
    const arq = ev.target.files[0]; if (!arq) return;
    const leitor = new FileReader();
    leitor.onload = async () => { try { await api('PUT', '/api/email/assinatura', { imagem: leitor.result }); $('#ass-erro').textContent = ''; aviso('Assinatura salva. Mande um e-mail de teste para ver como fica.'); previaAss(); } catch (e) { $('#ass-erro').textContent = mensagemErro(e); } };
    leitor.readAsDataURL(arq); ev.target.value = '';
  };
  $('#ass-remover').onclick = async () => { await api('PUT', '/api/email/assinatura', { imagem: null }); aviso('Assinatura removida.'); previaAss(); };
  previaAss();
}

async function telaModelosEmail(chaveInicial) {
  let modelos;
  try { modelos = await api('GET', '/api/email/modelos'); } catch (e) { corpoConfig().innerHTML = `<p class="erro">${esc(mensagemErro(e))}</p>`; return; }
  let atual = modelos.find((m) => m.chave === chaveInicial) ?? modelos[0];
  const grupos = [...new Set(modelos.map((m) => m.grupo))];
  corpoConfig().innerHTML = `
    <div class="me-topo"><div><h2>Modelos de e-mail</h2>
      <p class="sutil">Escreva cada e-mail do jeito da sua empresa. Os campos entre chaves (como <code>{{cliente}}</code>) são preenchidos sozinhos em cada envio. Enquanto não houver personalização, vale o texto sugerido pelo Kontor.</p></div></div>
    <div class="me">
      <aside class="me-lista" aria-label="E-mails do sistema">${grupos.map((g) => `<p class="me-grupo">${esc(g)}</p>${modelos.filter((m) => m.grupo === g).map((m) => `
        <button type="button" class="me-item" data-chave="${m.chave}"><span class="me-nome">${esc(m.nome)}</span><span class="me-selo ${m.personalizado ? 'pers' : ''}" data-selo>${m.personalizado ? 'Personalizado' : 'Sugerido'}</span></button>`).join('')}`).join('')}
      </aside>
      <section class="me-editor" id="me-editor"></section>
    </div>`;
  const editor = $('#me-editor');
  let previaT = 0, sujo = false;
  const marcar = (v) => { sujo = v; estado.naoSalvo = v ? { hash: location.hash } : null; const s = $('#me-salvar'); if (s) s.disabled = !v; const st = $('#me-estado'); if (st) st.textContent = v ? 'Alterações não salvas' : ''; };
  const trocar = (m) => {
    if (m === atual && editor.innerHTML) return;
    if (sujo && !confirm('Há alterações não salvas neste e-mail. Descartar e abrir outro?')) return;
    atual = m; marcar(false); abrir();
  };
  corpoConfig().querySelectorAll('.me-item').forEach((b) => (b.onclick = () => trocar(modelos.find((m) => m.chave === b.dataset.chave))));

  function abrir() {
    corpoConfig().querySelectorAll('.me-item').forEach((b) => b.classList.toggle('ativo', b.dataset.chave === atual.chave));
    editor.innerHTML = `
      <header class="me-cab"><div><h3>${esc(atual.nome)}</h3><p class="sutil">${esc(atual.descricao)}</p></div>
        <span class="me-selo grande ${atual.personalizado ? 'pers' : ''}">${atual.personalizado ? 'Texto personalizado' : 'Texto sugerido pelo Kontor'}</span></header>
      <div class="me-colunas">
        <div class="me-form">
          <label>Assunto <input id="me-assunto" maxlength="200" value="${esc(atual.assunto)}"></label>
          <div class="me-rotulo"><span>Mensagem</span><button type="button" class="me-mini" id="me-negrito" title="Negrito: marque o trecho e clique (fica entre **asteriscos**)"><b>N</b> Negrito</button></div>
          <textarea id="me-corpo" rows="16" spellcheck="true">${esc(atual.corpo)}</textarea>
          <div class="me-campos"><p class="me-campos-tit">Campos automáticos <span class="sutil">· clique para inserir onde está o cursor</span></p>
            <div class="me-chips">${atual.campos.map((c) => `<button type="button" class="me-chip ${c.lista ? 'lista' : ''}" data-campo="${c.nome}" title="${esc(c.descricao)}${c.lista ? ' (deixe sozinho na linha: vira um quadro)' : ''}">{{${c.nome}}}</button>`).join('')}</div>
            <p class="dica" id="me-desc-campo">Passe o mouse sobre um campo para ver o que ele traz.</p>
          </div>
          <details class="me-regras"><summary>Como funciona</summary><ul>
            <li>Linha em branco separa parágrafos.</li>
            <li><b>**texto**</b> sai em negrito.</li>
            <li>Campos com borda tracejada são quadros (guias, documentos, débitos): deixe-os sozinhos na linha.</li>
            <li>Se um campo estiver vazio em um envio, a linha dele não é enviada. Ex.: sem linha digitável, a frase da linha digitável some.</li>
            <li>A assinatura cadastrada em <a href="#/config/email">E-mail</a> entra sozinha no fim.</li></ul></details>
          <p class="erro" id="me-erro"></p>
          <div class="acoes me-acoes"><button class="primario" type="button" id="me-salvar" disabled>Salvar texto</button>
            <button type="button" id="me-teste">Enviar teste para mim</button>
            <button type="button" id="me-restaurar" ${atual.personalizado ? '' : 'hidden'}>Restaurar texto sugerido</button>
            <span class="me-estado" id="me-estado" aria-live="polite"></span></div>
        </div>
        <div class="me-previa"><p class="me-previa-tit">Prévia <span class="sutil">· com dados de exemplo</span></p>
          <div class="me-caixa"><div class="me-cab-email"><span class="me-lbl">Assunto</span><strong id="me-prev-assunto"></strong></div>
            <iframe id="me-prev" title="Prévia do e-mail" sandbox=""></iframe></div>
          <p class="aviso-campo" id="me-desconhecidos" hidden></p></div>
      </div>`;
    const ass = $('#me-assunto'), corpo = $('#me-corpo');
    let foco = corpo;
    ass.onfocus = () => (foco = ass); corpo.onfocus = () => (foco = corpo);
    const mudou = () => { marcar(ass.value !== atual.assunto || corpo.value !== atual.corpo); clearTimeout(previaT); previaT = setTimeout(previa, 250); };
    ass.oninput = mudou; corpo.oninput = mudou;
    const inserir = (txt, envolver) => {
      const el = foco, i = el.selectionStart ?? el.value.length, f = el.selectionEnd ?? i;
      const sel = el.value.slice(i, f);
      const novo = envolver ? `**${sel || 'texto'}**` : txt;
      el.value = el.value.slice(0, i) + novo + el.value.slice(f);
      el.focus(); const pos = envolver && !sel ? i + 2 : i + novo.length; el.setSelectionRange(pos, envolver && !sel ? pos + 5 : pos);
      mudou();
    };
    editor.querySelectorAll('.me-chip').forEach((b) => {
      const c = atual.campos.find((x) => x.nome === b.dataset.campo);
      b.onmouseenter = b.onfocus = () => ($('#me-desc-campo').textContent = `{{${c.nome}}}: ${c.descricao}${c.lista ? '. Deixe sozinho na linha: vira um quadro no e-mail.' : '.'}`);
      b.onmousedown = (ev) => ev.preventDefault(); // não tira o cursor do texto
      b.onclick = () => inserir(c.lista && foco === corpo ? `\n{{${c.nome}}}\n` : `{{${c.nome}}}`);
    });
    $('#me-negrito').onmousedown = (ev) => ev.preventDefault();
    $('#me-negrito').onclick = () => { foco = corpo; inserir('', true); };
    const atualizarLista = () => { const b = corpoConfig().querySelector(`.me-item[data-chave="${atual.chave}"] [data-selo]`); b.textContent = atual.personalizado ? 'Personalizado' : 'Sugerido'; b.classList.toggle('pers', atual.personalizado); };
    $('#me-salvar').onclick = async () => {
      $('#me-erro').textContent = '';
      try {
        await api('PUT', `/api/email/modelos/${atual.chave}`, { assunto: ass.value, corpo: corpo.value });
        atual.assunto = ass.value; atual.corpo = corpo.value;
        atual.personalizado = !(ass.value === atual.padrao.assunto && corpo.value === atual.padrao.corpo);
        marcar(false); atualizarLista(); abrir(); aviso('Texto salvo. Os próximos envios já saem assim.');
      } catch (e) { $('#me-erro').textContent = mensagemErro(e); }
    };
    $('#me-restaurar').onclick = () => abrirDialogo(`<h2>Restaurar texto sugerido?</h2>
      <p>O assunto e a mensagem de <b>${esc(atual.nome)}</b> voltam para o texto sugerido pelo Kontor. O seu texto atual será descartado.</p>
      <div class="acoes"><button class="primario" type="button" id="me-ok">Restaurar</button><button type="button" data-fechar>Cancelar</button></div>`, (d) => {
      $('#me-ok').onclick = async () => {
        try { await api('DELETE', `/api/email/modelos/${atual.chave}`); } catch (e) { d.close(); return aviso(mensagemErro(e)); }
        d.close(); Object.assign(atual, atual.padrao, { personalizado: false }); marcar(false); atualizarLista(); abrir(); aviso('Texto sugerido restaurado.');
      };
    });
    $('#me-teste').onclick = () => abrirDialogo(`
      <form id="form-me-teste"><h2>Enviar teste</h2>
        <p class="sutil">Envia o texto que está na tela agora (mesmo sem salvar), com dados de exemplo e o assunto começando por [Teste].</p>
        <label>Enviar para <input name="para" type="email" required value="${esc(estado.usuario.email ?? '')}"></label>
        <p class="erro" id="erro-me-teste"></p>
        <div class="acoes"><button class="primario" type="submit">Enviar teste</button><button type="button" data-fechar>Fechar</button></div>
      </form>`, (d) => {
      $('#form-me-teste').onsubmit = async (ev) => {
        ev.preventDefault();
        const botao = ev.target.querySelector('[type=submit]'); botao.disabled = true; botao.textContent = 'Enviando…';
        try { await api('POST', `/api/email/modelos/${atual.chave}/teste`, { assunto: ass.value, corpo: corpo.value, para: ev.target.para.value }); d.close(); aviso('Teste enviado. Confira a caixa de entrada (e o spam).'); }
        catch (e) { $('#erro-me-teste').textContent = mensagemErro(e); botao.disabled = false; botao.textContent = 'Enviar teste'; }
      };
    });
    previa();
  }

  async function previa() {
    const ass = $('#me-assunto'), corpo = $('#me-corpo');
    if (!ass) return;
    try {
      const r = await api('POST', `/api/email/modelos/${atual.chave}/previa`, { assunto: ass.value, corpo: corpo.value });
      $('#me-prev-assunto').textContent = r.assunto || '(sem assunto)';
      $('#me-prev').srcdoc = `<!doctype html><meta charset="utf-8"><style>body{margin:0}</style>${r.html}`;
      const aviso2 = $('#me-desconhecidos');
      aviso2.hidden = !r.desconhecidos.length;
      aviso2.textContent = r.desconhecidos.length ? `Campo que não existe neste e-mail: ${r.desconhecidos.map((n) => `{{${n}}}`).join(', ')}. Confira a grafia ou use os campos da lista.` : '';
    } catch { /* a prévia não interrompe a edição */ }
  }
  abrir();
}

async function telaBackup() {
  const b = await api('GET', '/api/backup');
  const tam = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  corpoConfig().innerHTML = `
    <div class="topo"><div><h1>Backup</h1>
      <p class="sutil">Neste modelo, o computador é o único lugar onde as notas ficam guardadas. Faça uma cópia de tempos em tempos e guarde fora dele (pen drive, nuvem).</p></div>
      <button class="primario" id="baixar">Baixar backup agora</button></div>
    <div class="banner teste">O backup guarda cadastros, notas e XML. Os certificados A1 ficam protegidos por uma chave deste computador: ao restaurar em outro, será preciso enviar o arquivo .pfx de cada empresa novamente.</div>
    <h2>Cópias automáticas</h2>
    ${b.pasta ? `<p class="sutil">O sistema salva uma cópia por dia e mantém as últimas 30 em <strong>${esc(b.pasta)}</strong>.</p>` : '<p class="sutil">Backup automático não está ativo nesta instalação.</p>'}
    ${b.automaticos.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Arquivo</th><th>Gerado em</th><th class="num">Tamanho</th></tr></thead><tbody>
      ${b.automaticos.map((x) => `<tr><td>${esc(x.nome)}</td><td>${new Date(x.data).toLocaleString('pt-BR')}</td><td class="num">${tam(x.bytes)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${window.nfseDesktop ? `<h2>Restaurar</h2><p class="sutil">Para voltar a uma cópia, use o menu <strong>Arquivo > Restaurar backup…</strong>. O sistema guarda os dados atuais antes de substituí-los.</p>` : ''}`;
  $('#baixar').onclick = () => baixar('/api/backup/baixar', `nfse-backup-${hoje()}.db`);
}

// ---------------------------------------------------------------------------
(async function iniciarApp() {
  try {
    const st = await fetch('/api/setup/status').then((r) => r.json());
    if (st.versao) $('#versao').textContent = 'Versão ' + st.versao;
    if (!st.configurado) return mostrarSetup();
  } catch { /* servidor indisponível: segue para o login */ }
  if (estado.token) iniciar(); else sair();
})();


// ---------------------------------------------------------------------------
// Aviso fixo de nova versão (aplicativo instalado)
// ---------------------------------------------------------------------------
(function avisoDeVersao() {
  const ponte = window.nfseDesktop;
  if (!ponte || typeof ponte.versaoPendente !== 'function') return;
  const faixa = document.getElementById('aviso-versao');
  let dispensado = false;
  const esconder = () => { faixa.hidden = true; document.body.classList.remove('com-aviso-versao'); };
  const mostrar = (info) => {
    if (!info || dispensado) return;
    const pronta = !!info.baixada && typeof ponte.baixarAtualizacao === 'function';
    faixa.innerHTML = `<span><strong>${pronta ? `Versão ${esc(info.versao)} baixada.` : `Nova versão ${esc(info.versao)} disponível.`}</strong>
      ${pronta ? (info.aoFechar ? 'Será instalada quando você fechar o Kontor.' : 'Pronta para instalar.') : 'Seus dados são preservados e uma cópia de segurança é feita antes de atualizar.'}
      ${info.notas ? `<details class="novidades"><summary>Ver novidades</summary><div>${esc(info.notas).replace(/\n/g, '<br>')}</div></details>` : ''}</span>
      <span class="acoes-faixa">${pronta
        ? `<button class="primario" id="av-atualizar">Instalar agora</button><label class="check av-fechar"><input type="checkbox" id="av-aofechar" ${info.aoFechar ? 'checked' : ''}> Instalar ao fechar o Kontor</label>`
        : `<button class="primario" id="av-atualizar">Atualizar agora</button>${typeof ponte.baixarAtualizacao === 'function' ? '<button id="av-baixar-fechar" title="Baixa agora e instala sozinho quando você fechar o Kontor">Baixar e instalar ao fechar</button><button id="av-baixar" title="Baixa agora; você instala quando quiser">Só baixar</button>' : ''}`}
        <button id="av-depois">Depois</button></span>`;
    faixa.hidden = false;
    document.body.classList.add('com-aviso-versao');
    document.getElementById('av-depois').onclick = () => { dispensado = true; esconder(); };
    document.getElementById('av-atualizar').onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = pronta ? 'Abrindo o instalador…' : 'Baixando…';
      const r = await ponte.instalarAtualizacao();
      if (!r?.ok) { ev.target.disabled = false; ev.target.textContent = pronta ? 'Instalar agora' : 'Atualizar agora'; aviso(r?.erro ?? 'Não foi possível atualizar agora.'); }
    };
    const baixar = (aoFechar) => async (ev) => {
      faixa.querySelectorAll('button').forEach((b) => (b.disabled = true)); ev.target.textContent = 'Baixando…';
      const r = await ponte.baixarAtualizacao(aoFechar);
      if (!r?.ok) { aviso(r?.erro ?? 'Não foi possível baixar agora.'); return mostrar(info); }
      aviso(aoFechar ? `Versão ${r.versao} baixada: será instalada quando você fechar o Kontor.` : `Versão ${r.versao} baixada. Instale quando quiser.`);
      mostrar(r);
    };
    document.getElementById('av-baixar-fechar') && (document.getElementById('av-baixar-fechar').onclick = baixar(true));
    document.getElementById('av-baixar') && (document.getElementById('av-baixar').onclick = baixar(false));
    const cf = document.getElementById('av-aofechar');
    if (cf) cf.onchange = async () => mostrar(await ponte.instalarAoFechar(cf.checked));
  };
  ponte.aoHaverAtualizacao(mostrar);
  ponte.versaoPendente().then(mostrar).catch(() => {});
})();

// ---------------------------------------------------------------------------
// Ícones (traço fino, herdam a cor do tema), menu com ícones, sininho e usuário no topo
// ---------------------------------------------------------------------------
const ICONES = {
  'o-busca': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  'o-mais': 'M12 5v14M5 12h14',
  'o-lixo': 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  'o-users': 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.5-3.6 3-5.5 6.5-5.5s6 1.9 6.5 5.5M16 4.5a3.2 3.2 0 0 1 0 6.2M18 14.8c2 .6 3.2 2.2 3.5 5.2',
  'o-caixa': 'M12 3 20 7.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  'o-cal': 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4',
  'o-tag': 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  'o-lista': 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  'o-moedas': 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  'o-ok': 'M5 12.5l4.5 4.5L19 7',
  'o-voltar': 'M15 5l-7 7 7 7',
  'o-predio': 'M5 21V4h10v17M15 9h4v12M3 21h18M8 8h4M8 12h4M8 16h4',
  'o-email': 'M3 6h18v12H3zM3 7l9 7 9-7',
  'o-zap': 'M4 20l1.2-4.1A8 8 0 1 1 8.2 19zM9 9c0 3 3 6 6 6l1-1.5-2-1-1 .8c-1-.4-2-1.4-2.4-2.4l.8-1-1-2z',
  orcamentos: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  inicio: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  visao: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  painel: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  monitor: 'M5 20v-8M10 20V5M15 20v-6M20 20V9M3 20h18',
  carteira: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.87M16 4.13a3 3 0 0 1 0 5.75',
  tomadores: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.87M16 4.13a3 3 0 0 1 0 5.75',
  obrigacoes: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h2M12 14h2M8 17h2',
  certificados: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  controle: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M9 15l2 2 4-4',
  senhas: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 15v2',
  honorarios: 'M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6',
  captura: 'M7 18a4.5 4.5 0 0 1-.9-8.9A6 6 0 0 1 17.6 8 4 4 0 0 1 17 18M12 12v8M9 15l3-3 3 3',
  emitir: 'M14 3H6v18h12V7zM14 3v4h4M12 11v6M9 14h6',
  agenda: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M12 13v3l2 1',
  notas: 'M15 3H8v14h11V7zM15 3v4h4M5 7v14h11',
  cobrancas: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  compras: 'M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.7a1 1 0 0 0 1-.8L20 8H6M9 20h.01M17 20h.01',
  'nfe-sefaz': 'M12 4v11M7 10l5 5 5-5M4 20h16',
  despesas: 'M4 7h15a1 1 0 0 1 1 1v11H5a1 1 0 0 1-1-1zM4 7l11-3v3M16 13h1',
  extrato: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  cartao: 'M3 6h18v12H3zM3 10h18M7 15h3',
  relatorios: 'M21 12a9 9 0 1 1-9-9v9zM15 3.5A9 9 0 0 1 20.5 9H15z',
  servicos: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16',
  tributacao: 'M19 5 5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  empresas: 'M4 21V5l8-2v18M12 9h8v12M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2M3 21h18',
  banco: 'M3 10h18L12 4zM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18',
  config: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 13.5l2 1-2 3.5-2.2-.7a7 7 0 0 1-1.8 1L14.5 21h-5L9 18.3a7 7 0 0 1-1.8-1L5 18l-2-3.5 2-1a7 7 0 0 1 0-3l-2-1L5 6l2.2.7A7 7 0 0 1 9 5.7L9.5 3h5l.5 2.7a7 7 0 0 1 1.8 1L19 6l2 3.5-2 1a7 7 0 0 1 0 3z',
  documentacao: 'M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM4 21V5M8 7h8',
  sair: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  sino: 'M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9M10.3 20.5a1.9 1.9 0 0 0 3.4 0',
  lampada: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  sol: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  calendario: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  seta: 'M5 12h14M13 6l6 6-6 6',
  ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.7 2.7L16 10',
  alerta: 'M12 3 2 20h20zM12 9v5M12 17h.01',
  usuario: 'M20 21v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  chevron: 'M6 9l6 6 6-6',
  raio: 'M13 2 4 14h7l-1 8 9-12h-7z',
  foguete: 'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 13l2 2M14.5 4.5c2.5-1.5 5-1.5 5.5-1s.5 3-1 5.5l-6 6-4.5-4.5zM9 9H5l-2 3 4 1M15 15v4l-3 2-1-4M15 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
};
const icone = (k, cls = 'ico') => (ICONES[k] ? `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONES[k]}"/></svg>` : '');

function iconesMenu() {
  document.querySelectorAll('#menu a').forEach((a) => {
    if (a.querySelector('svg.ico')) return;
    const chave = a.id === 'menu-doc' ? 'documentacao' : (a.getAttribute('href') || '').replace('#/', '').split('/')[0];
    if (ICONES[chave]) a.insertAdjacentHTML('afterbegin', icone(chave));
  });
  document.querySelectorAll('.lateral-rodape [data-icone]').forEach((el) => { if (!el.querySelector('svg.ico')) el.insertAdjacentHTML('afterbegin', icone(el.dataset.icone)); });
}

// ---------------------------------------------------------------------------
// Abas no topo: cada funcionalidade aberta pelo menu fica numa aba, como no navegador
// ---------------------------------------------------------------------------
const abas = { lista: [], ativa: null, pendente: null, seq: 0 };
const ABAS_MAX = 10;
const chaveAbas = () => `kontor-abas:${estado.usuario?.id ?? ''}`;
const telaDoHash = (h) => (String(h || '').split('/')[1] || 'painel');
function tituloDaAba(h) {
  const [, nome = 'painel', param] = String(h || '').split('/');
  if (nome === 'relatorios' && param === 'documentacao') return 'Documentação';
  if (nome === 'config') return 'Configurações';
  const a = document.querySelector(`#menu a[href="#/${nome}"]`);
  const t = a?.textContent.trim();
  return t || { inicio: 'Início', nota: 'Nota', painel: 'Visão geral' }[nome] || nome.replace(/-/g, ' ').replace(/^./, (x) => x.toUpperCase());
}
function guardarAbas() { try { localStorage.setItem(chaveAbas(), JSON.stringify({ lista: abas.lista, ativa: abas.ativa })); } catch {} }
function carregarAbas() {
  try {
    const g = JSON.parse(localStorage.getItem(chaveAbas()) || 'null');
    if (g && Array.isArray(g.lista)) {
      abas.lista = g.lista.filter((x) => x && typeof x.hash === 'string' && x.hash.startsWith('#/')).slice(0, ABAS_MAX);
      abas.ativa = abas.lista.some((x) => x.id === g.ativa) ? g.ativa : abas.lista[0]?.id ?? null;
      abas.seq = Math.max(0, ...abas.lista.map((x) => Number(x.id) || 0));
    }
  } catch {}
}
function novaAba(hash) {
  if (abas.lista.length >= ABAS_MAX) { const i = abas.lista.findIndex((x) => x.id !== abas.ativa); abas.lista.splice(i < 0 ? 0 : i, 1); } // limite: sai a mais antiga
  const aba = { id: ++abas.seq, hash };
  abas.lista.push(aba);
  return aba;
}
/** Chamado a cada troca de tela: a aba ativa (ou a escolhida no clique) passa a mostrar o endereço atual. */
function abasNavegou() {
  if (!$('#abas-app')) return;
  const h = location.hash || '#/';
  let alvo = null;
  if (abas.pendente === 'nova' || abas.pendente === 'vazia') { alvo = novaAba(h); alvo.vazia = abas.pendente === 'vazia'; }
  else if (abas.pendente != null) alvo = abas.lista.find((x) => x.id === abas.pendente) ?? null;
  abas.pendente = null;
  alvo ??= abas.lista.find((x) => x.id === abas.ativa) ?? novaAba(h);
  if (alvo.vazia && alvo.hash !== h) delete alvo.vazia; // usou a aba nova por um link da tela
  alvo.hash = h; abas.ativa = alvo.id;
  pintarAbas(); guardarAbas();
}
function irParaAba(aba) {
  if (aba.hash === location.hash) { abas.ativa = aba.id; pintarAbas(); guardarAbas(); return; }
  abas.pendente = aba.id; location.hash = aba.hash;
}
function abrirEmAba(hash) {
  const tela = telaDoHash(hash);
  const ja = abas.lista.find((x) => telaDoHash(x.hash) === tela);
  if (ja) return irParaAba(ja);
  const atual = abas.lista.find((x) => x.id === abas.ativa);
  if (atual?.vazia) { delete atual.vazia; abas.pendente = atual.id; location.hash = hash; return; } // aba nova (+) ainda sem uso: abre nela
  if (hash === location.hash) { const a = novaAba(hash); abas.ativa = a.id; pintarAbas(); guardarAbas(); return; }
  abas.pendente = 'nova'; location.hash = hash;
}
function fecharAba(id) {
  const i = abas.lista.findIndex((x) => x.id === id);
  if (i < 0) return;
  abas.lista.splice(i, 1);
  if (abas.ativa !== id) { pintarAbas(); guardarAbas(); return; }
  const prox = abas.lista[Math.min(i, abas.lista.length - 1)];
  if (prox) irParaAba(prox);
  else { abas.pendente = 'nova'; abas.ativa = null; if (location.hash === '#/inicio') abasNavegou(); else location.hash = '#/inicio'; }
}
function pintarAbas() {
  const caixa = $('#abas-app'); if (!caixa) return;
  caixa.innerHTML = abas.lista.map((a) => `<div class="aba-app ${a.id === abas.ativa ? 'ativa' : ''}" data-aba="${a.id}" title="${esc(tituloDaAba(a.hash))}">
      <button type="button" class="aba-ir">${esc(tituloDaAba(a.hash))}</button>${abas.lista.length > 1 ? `<button type="button" class="aba-fechar" data-fechar-aba="${a.id}" aria-label="Fechar aba">×</button>` : ''}</div>`).join('')
    + '<button type="button" class="aba-nova" id="aba-nova" title="Nova aba (Início)" aria-label="Nova aba">+</button>';
  caixa.querySelectorAll('[data-aba]').forEach((el) => {
    const aba = abas.lista.find((x) => x.id === Number(el.dataset.aba));
    el.querySelector('.aba-ir').onclick = () => irParaAba(aba);
    el.onauxclick = (ev) => { if (ev.button === 1 && abas.lista.length > 1) { ev.preventDefault(); fecharAba(aba.id); } }; // botão do meio fecha
  });
  caixa.querySelectorAll('[data-fechar-aba]').forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); fecharAba(Number(b.dataset.fecharAba)); }));
  $('#aba-nova').onclick = () => { abas.pendente = 'vazia'; if (location.hash === '#/inicio') abasNavegou(); else location.hash = '#/inicio'; };
  caixa.querySelector('.aba-app.ativa')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function iniciarAbas() {
  const barra = $('#barra-topo');
  if (!barra || $('#abas-app')) return;
  barra.insertAdjacentHTML('afterbegin', '<div class="abas-app" id="abas-app" role="tablist" aria-label="Telas abertas"></div>');
  carregarAbas();
  // menu lateral e rodapé: abre a funcionalidade numa aba (ou volta para a aba dela, se já estiver aberta)
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('#menu a[href^="#/"], .lateral-rodape a[href^="#/"]');
    if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    abrirEmAba(a.getAttribute('href'));
  });
  // a aba ativa guardada abre no lugar da tela inicial
  const ativa = abas.lista.find((x) => x.id === abas.ativa);
  if (ativa && ativa.hash !== location.hash) { abas.pendente = ativa.id; location.hash = ativa.hash; } else abasNavegou();
}

/** Barra do topo: sininho com os lembretes do usuário e o menu do usuário. */
function iniciarTopo() {
  if ($('#barra-topo')) return;
  const nome = String(estado.usuario?.nome ?? '').trim();
  const iniciais = nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
  const coluna = document.querySelector('.coluna-principal');
  coluna.insertAdjacentHTML('afterbegin', `<header class="barra-topo" id="barra-topo">
    <div class="topo-sino-caixa"><button type="button" class="topo-sino" id="topo-sino" aria-label="Lembretes" aria-haspopup="true" aria-expanded="false">${icone('sino')}<span class="topo-badge" id="topo-badge" hidden></span></button>
      <div class="topo-painel" id="topo-painel" hidden></div></div>
    <div class="topo-usuario-caixa"><button type="button" class="topo-usuario" id="topo-usuario" aria-haspopup="true" aria-expanded="false"><span class="topo-avatar" id="topo-avatar">${esc(iniciais)}</span><span class="topo-ola">Olá, <b>${esc(nome.split(' ')[0] || 'usuário')}</b></span>${icone('chevron', 'ico ico-p')}</button>
      <div class="topo-menu" id="topo-menu" hidden>
        <p class="topo-menu-nome">${esc(nome)}<br><span class="dica">${esc(estado.usuario?.login ?? '')}</span></p>
        <button type="button" id="topo-trocar-avatar">${icone('usuario')}Trocar avatar</button>
        <a href="#/config/conta">${icone('usuario')}Minha conta</a><a href="#/config/aparencia">${icone('sol')}Aparência</a>
        <button type="button" id="topo-sair">${icone('sair')}Sair</button>
      </div></div>
  </header>`);
  const alternar = (botao, painel, abrir) => { const ab = abrir ?? painel.hidden; painel.hidden = !ab; botao.setAttribute('aria-expanded', String(ab)); };
  $('#topo-sino').onclick = (ev) => { ev.stopPropagation(); alternar($('#topo-usuario'), $('#topo-menu'), false); alternar($('#topo-sino'), $('#topo-painel')); if (!$('#topo-painel').hidden) atualizarSino(true); };
  $('#topo-usuario').onclick = (ev) => { ev.stopPropagation(); alternar($('#topo-sino'), $('#topo-painel'), false); alternar($('#topo-usuario'), $('#topo-menu')); };
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.topo-sino-caixa')) alternar($('#topo-sino'), $('#topo-painel'), false);
    if (!ev.target.closest('.topo-usuario-caixa')) alternar($('#topo-usuario'), $('#topo-menu'), false);
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { alternar($('#topo-sino'), $('#topo-painel'), false); alternar($('#topo-usuario'), $('#topo-menu'), false); } });
  $('#topo-menu').querySelectorAll('a').forEach((a) => (a.onclick = () => alternar($('#topo-usuario'), $('#topo-menu'), false)));
  $('#topo-sair').onclick = () => $('#sair').click();
  $('#topo-trocar-avatar').onclick = () => { alternar($('#topo-usuario'), $('#topo-menu'), false); escolherAvatar(); };
  pintarAvatarTopo();
  window.addEventListener('hashchange', () => { alternar($('#topo-sino'), $('#topo-painel'), false); alternar($('#topo-usuario'), $('#topo-menu'), false); atualizarSino(); });
  atualizarSino(true);
}

const COR_LEMBRETE = { ATENCAO: 'var(--g-atencao)', PENDENTE: 'var(--g-pend)', INFO: 'var(--g-proc)' };
const listaLembretes = (lembretes) => (lembretes.length
  ? `<ul class="inicio-lembretes">${lembretes.map((l) => `<li><a href="${esc(l.link)}"><i style="background:${COR_LEMBRETE[l.nivel]}"></i><span>${esc(l.texto)}</span>${icone('seta', 'ico ico-p')}</a></li>`).join('')}</ul>`
  : '<p class="dica">Nada pendente por aqui. Aproveite o dia!</p>');
let sinoEm = 0;
async function atualizarSino(forcar = false) {
  if (!$('#topo-badge') || (!forcar && Date.now() - sinoEm < 60e3)) return;
  sinoEm = Date.now();
  let lembretes;
  try { ({ lembretes } = await api('GET', '/api/inicio')); } catch { return; }
  const n = lembretes.filter((l) => l.nivel !== 'INFO').length;
  $('#topo-badge').hidden = !n; $('#topo-badge').textContent = n > 9 ? '9+' : String(n);
  $('#topo-sino').classList.toggle('tem-atencao', lembretes.some((l) => l.nivel === 'ATENCAO'));
  $('#topo-painel').innerHTML = `<header><b>Lembretes de hoje</b></header>${listaLembretes(lembretes)}`;
  $('#topo-painel').querySelectorAll('a').forEach((a) => (a.onclick = () => { $('#topo-painel').hidden = true; $('#topo-sino').setAttribute('aria-expanded', 'false'); }));
}

// ---------------------------------------------------------------------------
// Início: boas-vindas, acesso rápido, dica e mensagem do dia (os lembretes ficam no sininho do topo)
// ---------------------------------------------------------------------------
async function telaInicio() {
  const agora = new Date();
  const h = agora.getHours();
  const saudacao = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const dia = Math.floor((Date.now() - agora.getTimezoneOffset() * 6e4) / 864e5);
  const nome = String(estado.usuario?.nome ?? '').split(' ')[0];
  const dataLonga = agora.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const pode = (m) => m.split(' ').some((x) => estado.usuario.modulos.includes(x));
  const acessos = INICIO.acessos.filter((a) => pode(a.modulo)).slice(0, 4);
  const cartao = (ic, titulo, corpo, cls = '') => `<section class="cartao inicio-cartao ${cls}"><header class="inicio-cab"><span class="inicio-ic">${icone(ic)}</span><h2>${titulo}</h2></header>${corpo}</section>`;
  conteudo.innerHTML = `
    <div class="inicio2">
      <div class="inicio2-principal">
        <section class="inicio-hero">
          <div class="inicio-hero-texto">
            <p class="inicio-hero-data">${icone('calendario')}${esc(dataLonga.charAt(0).toUpperCase() + dataLonga.slice(1))}</p>
            <h1>${saudacao}${nome ? `, <span>${esc(nome)}</span>` : ''}!</h1>
            <p class="inicio-hero-sub">${esc(INICIO.subtitulo)}</p>
            <span class="inicio-traco2" aria-hidden="true"></span>
          </div>
          <img src="/logo.svg" alt="${esc(INICIO.produto)}" class="inicio-logo inicio-hero-logo">
        </section>
        ${acessos.length ? `<section class="inicio-acessos"><h2>${icone('raio')}Acesso rápido</h2>
          <div class="inicio-acessos-grade">${acessos.map((a) => `<a class="inicio-atalho" href="${a.href}"><span class="inicio-ic">${icone(a.icone)}</span><strong>${esc(a.titulo)}</strong><span class="inicio-atalho-sub">${esc(a.sub)}</span>${icone('seta', 'ico ico-p inicio-atalho-seta')}</a>`).join('')}</div></section>` : ''}
        <a class="inicio-banner" href="#/relatorios/documentacao">
          <span class="inicio-banner-ic">${icone('foguete')}</span>
          <span class="inicio-banner-texto"><strong>Sua rotina ainda mais <span>simples.</span></strong><span>Conheça todas as funcionalidades do ${esc(INICIO.produto)} no manual.</span></span>
          <span class="inicio-banner-botao">Ver o manual ${icone('seta', 'ico ico-p')}</span>
        </a>
      </div>
      <aside class="inicio2-lado">
        ${cartao('lampada', 'Dica do dia', `<p>${esc(INICIO.dicas[dia % INICIO.dicas.length])}</p>`)}
        ${cartao('sol', 'Para o seu dia', `<p>${esc(INICIO.mensagens[dia % INICIO.mensagens.length])}</p>`, 'inicio-mensagem')}
        <p class="dica inicio-dica-sino">${icone('sino', 'ico ico-p')} Os lembretes do dia ficam no sininho, no alto da tela.</p>
      </aside>
    </div>`;
}

const INICIO = {
  produto: 'Kontor Gestão Empresas',
  subtitulo: 'Aqui você encontra tudo o que precisa para emitir, cobrar e acompanhar o caixa da sua empresa.',
  acessos: [
    { href: '#/emitir', icone: 'emitir', titulo: 'Emitir nota', sub: 'NFS-e em poucos cliques', modulo: 'emitir' },
    { href: '#/notas', icone: 'notas', titulo: 'Notas emitidas', sub: 'Consulte e envie', modulo: 'notas' },
    { href: '#/cobrancas', icone: 'cobrancas', titulo: 'Cobranças', sub: 'Boletos e Pix', modulo: 'cobrancas' },
    { href: '#/painel', icone: 'painel', titulo: 'Painel do mês', sub: 'Faturado e recebido', modulo: 'painel' },
    { href: '#/tomadores', icone: 'tomadores', titulo: 'Clientes', sub: 'Cadastro e cobrança', modulo: 'tomadores' },
    { href: '#/despesas', icone: 'despesas', titulo: 'Despesas e balanço', sub: 'Receitas × despesas', modulo: 'despesas' },
  ],
  dicas: [
    'Na Emissão automática, as notas e boletos do mês ficam prontos na data de cada cliente: é só conferir e confirmar.',
    'Cadastre os serviços padrão de cada cliente: na emissão, o serviço e o valor já vêm preenchidos.',
    'Clientes que pagam por Pix ficam na carteira Pix: cole o código copia e cola e o demonstrativo sai com o QR Code.',
    'Em Configurações > Modelos de e-mail, ajuste o texto de cada e-mail que vai para os clientes.',
    'O extrato em PDF pode ser importado e ligado aos boletos: o que foi pago já aparece como recebido.',
    'Lance as despesas fixas do mês: o balanço mostra o lucro de verdade, e não só a receita.',
    'Pressione F2 no campo do cliente para buscar por nome, CNPJ ou e-mail.',
    'O sininho no alto da tela mostra as cobranças vencidas e as notas com erro.',
    'Em Configurações > Aparência você escolhe as cores do sistema.',
    'Faça backup com frequência em Configurações > Backup.',
  ],
  mensagens: [
    'Um passo de cada vez: o dia rende mais quando a primeira tarefa é a mais importante.',
    'Pequenas organizações diárias evitam grandes correrias no fim do mês.',
    'Cliente bem atendido é o melhor marketing que existe.',
    'Faça uma pausa curta, respire fundo e volte com a cabeça leve.',
    'Nota emitida no dia certo é dinheiro entrando no dia certo.',
    'Um café, uma lista e foco: o dia está nas suas mãos.',
    'Organização não é fazer mais, é fazer o certo na hora certa.',
    'Celebre as pequenas vitórias: elas somam muito no fim do mês.',
    'Caixa organizado é decisão mais tranquila.',
    'Termine o dia anotando a primeira tarefa de amanhã: a manhã começa mais fácil.',
  ],
};

// ---------------------------------------------------------------------------
// Avatares: desenhos próprios (pessoas variadas e alguns bichos e personagens), escolhidos pelo usuário
// ---------------------------------------------------------------------------
const PELE = ['#f6d3b3', '#e8b48e', '#c68863', '#9a6142', '#6b4029', '#f1c7a5'];
const PESSOAS = [
  // fundo, pele, cabelo, cor do cabelo, roupa, extras
  ['#3b82f6', 1, 'curto', '#2b1d14', '#1e3a8a', ''],
  ['#ec4899', 0, 'longo', '#8b4513', '#9d174d', 'brinco'],
  ['#10b981', 3, 'cacheado', '#1a120c', '#065f46', ''],
  ['#f59e0b', 2, 'coque', '#3b2414', '#92400e', 'oculos'],
  ['#8b5cf6', 4, 'careca', '#1a120c', '#4c1d95', 'barba'],
  ['#ef4444', 0, 'franja', '#e0b04a', '#7f1d1d', ''],
  ['#14b8a6', 5, 'curto', '#5a3a22', '#134e4a', 'oculos barba'],
  ['#6366f1', 3, 'longo', '#120c08', '#312e81', ''],
  ['#f97316', 1, 'cacheado', '#a0522d', '#7c2d12', 'oculos'],
  ['#0ea5e9', 4, 'coque', '#120c08', '#0c4a6e', 'brinco'],
  ['#84cc16', 0, 'curto', '#b9b9b9', '#365314', 'oculos barba'],
  ['#d946ef', 2, 'franja', '#2b1d14', '#701a75', ''],
];
const BICHOS = ['gato', 'cachorro', 'raposa', 'coruja', 'panda', 'robo', 'astronauta', 'leao'];
const AVATARES = [...PESSOAS.map((_, i) => `pessoa-${i + 1}`), ...BICHOS];
const NOME_AVATAR = { gato: 'Gato', cachorro: 'Cachorro', raposa: 'Raposa', coruja: 'Coruja', panda: 'Panda', robo: 'Robô', astronauta: 'Astronauta', leao: 'Leão' };

function svgPessoa([fundo, pele, cabelo, corCabelo, roupa, extras]) {
  const sk = PELE[pele];
  const atras = cabelo === 'longo' ? `<path fill="${corCabelo}" d="M17 30c0-12 6-19 15-19s15 7 15 19v20h-7V32H24v18h-7z"/>` : '';
  const topo = {
    curto: `<path fill="${corCabelo}" d="M19.5 27c0-10 5.5-16 12.5-16s12.5 6 12.5 16c-2-5-6-8-12.5-8s-10.5 3-12.5 8z"/>`,
    longo: `<path fill="${corCabelo}" d="M19.5 27c1-9 6-14.5 12.5-14.5S43.5 18 44.5 27c-4-5-8-7-12.5-7s-8.5 2-12.5 7z"/>`,
    coque: `<circle cx="32" cy="10.5" r="6" fill="${corCabelo}"/><path fill="${corCabelo}" d="M19.5 27c0-10 5.5-15.5 12.5-15.5S44.5 17 44.5 27c-2-5-6-7.5-12.5-7.5S21.5 22 19.5 27z"/>`,
    cacheado: [[21, 22], [25, 16], [31, 13.5], [37.5, 15], [42.5, 20.5], [44, 27], [20, 28]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.6" fill="${corCabelo}"/>`).join(''),
    careca: `<path fill="${corCabelo}" opacity=".55" d="M19.8 29c0-3 .5-5 1.5-7l1 6zM44.2 29c0-3-.5-5-1.5-7l-1 6z"/>`,
    franja: `<path fill="${corCabelo}" d="M19.5 28c0-11 5.5-17 12.5-17s12.5 6 12.5 16c-7 0-15-3-19-9-1.6 3.6-3.6 7.2-6 10z"/>`,
  }[cabelo];
  const oculos = extras.includes('oculos') ? `<g fill="none" stroke="#1f2937" stroke-width="1.6"><circle cx="26.8" cy="29.5" r="4"/><circle cx="37.2" cy="29.5" r="4"/><path d="M30.8 29.5h2.4"/></g>` : '';
  const barba = extras.includes('barba') ? `<path fill="${corCabelo}" d="M20.5 31c1 9 5.5 13.5 11.5 13.5S42.5 40 43.5 31c-2.5 3.6-6.4 5.4-11.5 5.4S23 34.6 20.5 31z"/>` : '';
  const brinco = extras.includes('brinco') ? `<circle cx="19.6" cy="34" r="1.6" fill="#fbbf24"/><circle cx="44.4" cy="34" r="1.6" fill="#fbbf24"/>` : '';
  return `<circle cx="32" cy="32" r="32" fill="${fundo}"/>${atras}
    <path fill="${roupa}" d="M9 64c2-12 11-19 23-19s21 7 23 19z"/><rect x="27.5" y="38" width="9" height="9" rx="3" fill="${sk}"/><path fill="#000" opacity=".12" d="M27.5 41h9v3c-3 1.4-6 1.4-9 0z"/>
    <ellipse cx="32" cy="29" rx="12.5" ry="14" fill="${sk}"/><ellipse cx="19.8" cy="30" rx="2" ry="3" fill="${sk}"/><ellipse cx="44.2" cy="30" rx="2" ry="3" fill="${sk}"/>
    ${topo}${barba}<circle cx="26.8" cy="29.5" r="1.7" fill="#1f2937"/><circle cx="37.2" cy="29.5" r="1.7" fill="#1f2937"/>
    <path d="M28.2 36q3.8 3 7.6 0" fill="none" stroke="#7a3b2e" stroke-width="1.6" stroke-linecap="round"/><circle cx="24.5" cy="34" r="2.2" fill="#f87171" opacity=".25"/><circle cx="39.5" cy="34" r="2.2" fill="#f87171" opacity=".25"/>
    ${oculos}${brinco}`;
}
const olhos = (y = 30, d = 6, r = 2) => `<circle cx="${32 - d}" cy="${y}" r="${r}" fill="#1f2937"/><circle cx="${32 + d}" cy="${y}" r="${r}" fill="#1f2937"/>`;
const SVG_BICHO = {
  gato: `<circle cx="32" cy="32" r="32" fill="#fde68a"/><path fill="#f59e0b" d="M15 22l4-12 9 7zM49 22l-4-12-9 7z"/><circle cx="32" cy="34" r="17" fill="#f59e0b"/><path fill="#fcd9a5" d="M22 40c2-6 6-8 10-8s8 2 10 8c-3 5-7 7-10 7s-7-2-10-7z"/>${olhos(31, 6.5, 2.2)}<path fill="#be185d" d="M30 37h4l-2 2.4z"/><path stroke="#92400e" stroke-width="1" d="M18 38h8M18 41l8-1.5M46 38h-8M46 41l-8-1.5" fill="none"/>`,
  cachorro: `<circle cx="32" cy="32" r="32" fill="#bfdbfe"/><ellipse cx="17" cy="30" rx="6" ry="11" fill="#78350f"/><ellipse cx="47" cy="30" rx="6" ry="11" fill="#78350f"/><circle cx="32" cy="33" r="16" fill="#d6a067"/><ellipse cx="32" cy="40" rx="8" ry="6" fill="#f3d3ac"/>${olhos(30, 6, 2.2)}<ellipse cx="32" cy="37" rx="3" ry="2.2" fill="#1f2937"/><path d="M29 42q3 2 6 0" stroke="#1f2937" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  raposa: `<circle cx="32" cy="32" r="32" fill="#fed7aa"/><path fill="#ea580c" d="M14 14l12 10-4 6zM50 14L38 24l4 6z"/><path fill="#ea580c" d="M14 26c4-6 10-9 18-9s14 3 18 9l-18 24z"/><path fill="#fff" d="M18 31l14 19-6-17zM46 31L32 50l6-17z"/>${olhos(31, 6, 2)}<circle cx="32" cy="46" r="2.4" fill="#1f2937"/>`,
  coruja: `<circle cx="32" cy="32" r="32" fill="#c7d2fe"/><path fill="#7c5a3a" d="M16 22l6 4 10-4 10 4 6-4v24c0 8-7 12-16 12s-16-4-16-12z"/><circle cx="25" cy="31" r="7" fill="#fff"/><circle cx="39" cy="31" r="7" fill="#fff"/><circle cx="25" cy="31" r="3.4" fill="#1f2937"/><circle cx="39" cy="31" r="3.4" fill="#1f2937"/><path fill="#f59e0b" d="M30 37h4l-2 4z"/><path fill="#a0784f" d="M24 46q8 4 16 0-8 8-16 0z"/>`,
  panda: `<circle cx="32" cy="32" r="32" fill="#bbf7d0"/><circle cx="19" cy="19" r="6" fill="#111827"/><circle cx="45" cy="19" r="6" fill="#111827"/><circle cx="32" cy="34" r="17" fill="#fff"/><ellipse cx="25" cy="32" rx="4.5" ry="5.5" fill="#111827" transform="rotate(-20 25 32)"/><ellipse cx="39" cy="32" rx="4.5" ry="5.5" fill="#111827" transform="rotate(20 39 32)"/><circle cx="25.5" cy="32" r="1.6" fill="#fff"/><circle cx="38.5" cy="32" r="1.6" fill="#fff"/><ellipse cx="32" cy="39" rx="2.6" ry="1.8" fill="#111827"/><path d="M29.5 42q2.5 1.8 5 0" stroke="#111827" stroke-width="1.3" fill="none"/>`,
  robo: `<circle cx="32" cy="32" r="32" fill="#a5f3fc"/><path stroke="#475569" stroke-width="2" d="M32 10v7"/><circle cx="32" cy="9" r="3" fill="#ef4444"/><rect x="16" y="17" width="32" height="28" rx="8" fill="#94a3b8"/><rect x="20" y="23" width="24" height="12" rx="5" fill="#0f172a"/><circle cx="26.5" cy="29" r="2.8" fill="#22d3ee"/><circle cx="37.5" cy="29" r="2.8" fill="#22d3ee"/><rect x="25" y="38" width="14" height="3" rx="1.5" fill="#475569"/><rect x="12" y="26" width="4" height="10" rx="2" fill="#64748b"/><rect x="48" y="26" width="4" height="10" rx="2" fill="#64748b"/><path fill="#64748b" d="M22 64v-14h20v14z"/>`,
  astronauta: `<circle cx="32" cy="32" r="32" fill="#1e293b"/><circle cx="12" cy="14" r="1" fill="#fff"/><circle cx="52" cy="10" r="1.2" fill="#fff"/><circle cx="50" cy="50" r="1" fill="#fff"/><path fill="#e5e7eb" d="M12 64c2-11 10-16 20-16s18 5 20 16z"/><circle cx="32" cy="30" r="17" fill="#f3f4f6"/><rect x="19" y="21" width="26" height="18" rx="9" fill="#0f172a"/><path fill="#60a5fa" opacity=".55" d="M24 25c3-2 7-2 9-1-4 1-7 3-9 6z"/><circle cx="32" cy="55" r="3" fill="#f97316"/>`,
  leao: `<circle cx="32" cy="32" r="32" fill="#fef3c7"/><circle cx="32" cy="32" r="22" fill="#b45309"/>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<circle cx="${32 + 20 * Math.cos(a * Math.PI / 180)}" cy="${32 + 20 * Math.sin(a * Math.PI / 180)}" r="6" fill="#92400e"/>`).join('')}<circle cx="32" cy="33" r="14" fill="#fbbf24"/><circle cx="21" cy="22" r="3.5" fill="#fbbf24"/><circle cx="43" cy="22" r="3.5" fill="#fbbf24"/>${olhos(31, 5, 1.9)}<path fill="#78350f" d="M29.5 36h5l-2.5 2.6z"/><path d="M29 40q3 2 6 0" stroke="#78350f" stroke-width="1.3" fill="none"/>`,
};
function avatarSvg(id, tam = 36) {
  const m = /^pessoa-(\d+)$/.exec(id ?? '');
  const corpo = m ? (PESSOAS[Number(m[1]) - 1] && svgPessoa(PESSOAS[Number(m[1]) - 1])) : SVG_BICHO[id];
  if (!corpo) return '';
  return `<svg class="avatar-svg" viewBox="0 0 64 64" width="${tam}" height="${tam}" aria-hidden="true"><defs><clipPath id="av-${id}-${tam}"><circle cx="32" cy="32" r="32"/></clipPath></defs><g clip-path="url(#av-${id}-${tam})">${corpo}</g></svg>`;
}
const iniciaisDoUsuario = () => String(estado.usuario?.nome ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
function pintarAvatarTopo() {
  const el = $('#topo-avatar'); if (!el) return;
  const svg = avatarSvg(estado.usuario?.avatar, 34);
  el.innerHTML = svg || esc(iniciaisDoUsuario());
  el.classList.toggle('com-desenho', !!svg);
}
function escolherAvatar(aoMudar) {
  const atual = estado.usuario?.avatar ?? null;
  abrirDialogo(`<div class="dlg-largo"><h2>Escolha o seu avatar</h2>
    <p class="sutil">Aparece no alto da tela, ao lado do sininho. Vale só para o seu usuário.</p>
    <div class="avatares-grade">
      <button type="button" class="avatar-opcao ${!atual ? 'ativo' : ''}" data-av=""><span class="avatar-iniciais">${esc(iniciaisDoUsuario())}</span><span>Iniciais</span></button>
      ${AVATARES.map((id) => `<button type="button" class="avatar-opcao ${id === atual ? 'ativo' : ''}" data-av="${id}" aria-label="${esc(NOME_AVATAR[id] ?? 'Pessoa')}">${avatarSvg(id, 60)}<span>${esc(NOME_AVATAR[id] ?? '')}</span></button>`).join('')}
    </div>
    <p class="erro" id="erro-avatar"></p>
    <div class="acoes"><button type="button" data-fechar>Fechar</button></div></div>`, (d) => {
    d.querySelectorAll('[data-av]').forEach((b) => (b.onclick = async () => {
      const avatar = b.dataset.av || null;
      try { await api('PUT', '/api/me/avatar', { avatar }); estado.usuario.avatar = avatar; pintarAvatarTopo(); d.close(); aviso('Avatar atualizado.'); aoMudar?.(); }
      catch (e) { $('#erro-avatar').textContent = mensagemErro(e); }
    }));
  });
}

// ---------------------------------------------------------------------------
// Orçamentos de serviços: propostas ao cliente que viram nota fiscal (inclusive em partes)
// ---------------------------------------------------------------------------
const ROTULO_ORC = { RASCUNHO: 'Rascunho', ENVIADO: 'Enviado', APROVADO: 'Aprovado', RECUSADO: 'Recusado', VENCIDO: 'Vencido', PARCIAL: 'Faturado em parte', FATURADO: 'Faturado' };
const COR_ORC = { RASCUNHO: 'var(--tinta-2, #8a8a8a)', ENVIADO: 'var(--ambar)', APROVADO: 'var(--verde)', RECUSADO: 'var(--vermelho)', VENCIDO: 'var(--vermelho)', PARCIAL: 'var(--ambar)', FATURADO: 'var(--verde)' };
const seloOrc = (s) => `<span class="selo-estado" style="--c:${COR_ORC[s] ?? 'var(--laranja)'}">${ROTULO_ORC[s] ?? s}</span>`;

async function telaOrcamentos() {
  const e = empresa();
  const lista = await api('GET', `/api/empresas/${e.id}/orcamentos`);
  const f = (telaOrcamentos.filtro ??= { sit: '', q: '' });
  const abertos = lista.filter((o) => ['ENVIADO', 'APROVADO', 'PARCIAL'].includes(o.situacao));
  conteudo.innerHTML = `
    <div class="topo"><div><h1>Orçamentos</h1><p class="sutil">${esc(e.razao_social)}: propostas de serviço que viram nota fiscal.</p></div>
      <button type="button" class="primario" id="novo-orc">Novo orçamento</button></div>
    ${lista.length ? `<p class="sutil">${abertos.length} em andamento, somando ${brl(abertos.reduce((s, o) => s + o.saldo, 0))} ainda por faturar.</p>
    <div class="filtros"><label>Situação <select id="orc-sit"><option value="">Todas</option>${Object.entries(ROTULO_ORC).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label>Buscar <input id="orc-q" type="search" placeholder="Cliente ou número" value="${esc(f.q)}"></label></div>` : ''}
    <div id="orc-lista"></div>`;
  $('#novo-orc').onclick = () => { location.hash = '#/orcamento/novo'; };
  const pintar = () => {
    const q = f.q.trim().toLowerCase();
    const l = lista.filter((o) => (!f.sit || o.situacao === f.sit) && (!q || String(o.numero) === q || (o.cliente ?? '').toLowerCase().includes(q)));
    $('#orc-lista').innerHTML = l.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Nº</th><th>Cliente</th><th>Criado em</th><th>Validade</th><th class="num">Total</th><th class="num">A faturar</th><th>Situação</th></tr></thead><tbody>
      ${l.map((o) => `<tr class="clicavel" data-orc="${o.id}"><td>${o.numero}</td><td>${esc(o.cliente ?? '')}</td><td>${dataBr(o.criado_em)}</td><td>${dataBr(o.validade) || '—'}</td><td class="num">${brl(o.total)}</td><td class="num">${o.situacao === 'RECUSADO' ? '—' : brl(o.saldo)}</td><td>${seloOrc(o.situacao)}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="vazio"><p>${lista.length ? 'Nenhum orçamento com este filtro.' : 'Nenhum orçamento ainda. Monte o primeiro e, quando o cliente aprovar, transforme em nota fiscal.'}</p></div>`;
    $('#orc-lista').querySelectorAll('[data-orc]').forEach((tr) => (tr.onclick = () => { location.hash = `#/orcamento/${tr.dataset.orc}`; }));
  };
  if ($('#orc-sit')) { $('#orc-sit').value = f.sit; $('#orc-sit').onchange = (ev) => { f.sit = ev.target.value; pintar(); }; $('#orc-q').oninput = (ev) => { f.q = ev.target.value; pintar(); }; }
  pintar();
}

async function telaOrcamento(param) {
  const e = empresa();
  const novo = !param || param === 'novo';
  const [tomadores, servicos, o] = await Promise.all([
    api('GET', `/api/empresas/${e.id}/tomadores`), api('GET', `/api/empresas/${e.id}/servicos`),
    novo ? null : api('GET', `/api/empresas/${e.id}/orcamentos/${param}`),
  ]);
  const travado = !!o?.notas.length; // com notas emitidas o orçamento não muda mais
  const mais = (d) => new Date(Date.parse(hoje()) + d * 864e5).toISOString().slice(0, 10);
  const base = `/api/empresas/${e.id}/orcamentos`;
  const itens0 = o?.itens.length ? o.itens : [];
  const num = (v) => (v === '' || v == null ? '' : String(v).replace('.', ','));

  const tomOpc = (t) => `${t.nome}${t.documento ? ' — ' + fmtDoc(t.documento) : ''}`;
  const tomAtual = o?.tomador_id ? tomadores.find((t) => t.id === o.tomador_id) : null;
  const cabeca = (ic, titulo, sub, extra = '') => `<header class="orc-cab"><span class="orc-ico">${icone(ic)}</span><div class="orc-tit"><h2>${titulo}</h2><p>${sub}</p></div>${extra}</header>`;

  conteudo.innerHTML = `
    <div class="orc-topo"><span class="orc-ico grande">${icone('orcamentos')}</span><div>
      <h1>${novo ? 'Novo orçamento' : `Orçamento nº ${o.numero}`} ${o ? seloOrc(o.situacao) : ''}</h1>
      <p class="sutil">${novo ? 'Crie um orçamento de forma rápida e organizada' : `${esc(e.razao_social)} · criado em ${dataBr(o.criado_em)}${o.enviado_em ? ` · enviado em ${dataBr(o.enviado_em)}` : ''}${o.motivo_recusa ? ` · motivo da recusa: ${esc(o.motivo_recusa)}` : ''}`}</p>
    </div></div>
    ${o ? `<div class="acoes" id="orc-acoes">
      <button type="button" id="o-pdf">Ver PDF</button><button type="button" id="o-email">Enviar por e-mail</button><button type="button" id="o-wa">WhatsApp</button>
      ${!travado && o.situacao_base === 'RASCUNHO' ? '<button type="button" id="o-enviado">Marcar como enviado</button>' : ''}
      ${!travado && ['RASCUNHO', 'ENVIADO'].includes(o.situacao_base) ? '<button type="button" id="o-aprovado">Cliente aprovou</button>' : ''}
      ${!travado && o.situacao_base !== 'RECUSADO' ? '<button type="button" id="o-recusado">Cliente recusou</button>' : ''}
      ${!travado && o.situacao_base !== 'RASCUNHO' ? '<button type="button" id="o-reabrir">Voltar a rascunho</button>' : ''}
      ${o.saldo > 0 && o.situacao_base !== 'RECUSADO' ? '<button type="button" class="primario" id="o-converter">Converter em nota</button>' : ''}
      <button type="button" id="o-duplicar">Duplicar</button>
      ${!travado ? '<button type="button" class="perigo" id="o-excluir">Excluir</button>' : ''}</div>` : ''}
    ${travado ? '<div class="banner">Este orçamento já tem notas emitidas e não pode mais ser alterado. Para uma nova proposta, use <strong>Duplicar</strong>.</div>' : ''}
    <form id="form-orc"><fieldset class="orc-fs" ${travado ? 'disabled' : ''}>
      <section class="orc-card">
        ${cabeca('o-users', 'Cliente', 'Selecione ou cadastre um cliente')}
        <div class="orc-busca">
          <label class="orc-campo orc-pesq">${icone('o-busca')}<input id="orc-cli" list="orc-cli-lista" autocomplete="off" placeholder="Buscar cliente por nome ou CNPJ…" value="${esc(tomAtual ? tomOpc(tomAtual) : '')}" aria-label="Buscar cliente"></label>
          <a class="orc-ouro" href="#/tomadores">${icone('o-mais')} Novo cliente</a>
        </div>
        <datalist id="orc-cli-lista">${tomadores.map((t) => `<option value="${esc(tomOpc(t))}"></option>`).join('')}</datalist>
        <input type="hidden" name="tomadorId" value="${o?.tomador_id ?? ''}">
        <div class="orc-info">
          <label>${icone('o-predio')}<span><small>Nome</small><input name="clienteNome" maxlength="200" value="${esc(o?.cliente_nome ?? '')}" placeholder="Quem recebe o orçamento"></span></label>
          <label>${icone('o-email')}<span><small>E-mail</small><input name="clienteEmail" type="email" value="${esc(o?.cliente_email ?? '')}" placeholder="cliente@empresa.com.br"></span></label>
          <label>${icone('o-zap')}<span><small>WhatsApp</small><input name="clienteFone" value="${esc(o?.cliente_fone ?? '')}" placeholder="(47) 99999-9999"></span></label>
        </div>
        <p class="dica">Para emitir a nota é preciso um cliente cadastrado; se ainda não existe, use <strong>Novo cliente</strong> e escolha-o aqui.</p>
      </section>
      <section class="orc-card">
        ${cabeca('o-caixa', 'Serviços', 'Adicione os serviços que serão orçados', `<div class="orc-add"><label class="orc-campo orc-pesq">${icone('o-busca')}<input id="orc-serv" list="orc-serv-lista" autocomplete="off" placeholder="Buscar serviço…" aria-label="Buscar serviço"></label><button type="button" id="orc-add" class="orc-ouro">${icone('o-mais')} Adicionar serviço</button></div>`)}
        <datalist id="orc-serv-lista">${servicos.map((sv) => `<option value="${esc(sv.nome)}"></option>`).join('')}</datalist>
        <div class="rolagem"><table class="orc-tab" id="orc-itens"><thead><tr><th>Serviço</th><th>Descrição</th><th class="c">Qtd.</th><th class="num">Valor unit. (R$)</th><th class="num">Total (R$)</th><th class="c">Ações</th></tr></thead><tbody></tbody></table></div>
        <p class="orc-vazio" id="orc-vazio">Nenhum serviço adicionado ainda. Busque um serviço acima ou clique em “Adicionar serviço” para um item livre.</p>
      </section>
      <section class="orc-resumo">
        <label class="orc-r">${icone('o-cal')}<span><small>Validade da proposta</small><input type="date" name="validade" value="${o ? o.validade ?? '' : mais(15)}"></span></label>
        <label class="orc-r">${icone('o-tag')}<span><small>Desconto (R$)</small><input name="desconto" data-num inputmode="decimal" value="${num(o?.desconto || '')}" placeholder="0,00"></span></label>
        <div class="orc-r">${icone('o-lista')}<span><small>Itens</small><strong id="orc-n">0</strong></span></div>
        <div class="orc-r orc-tot">${icone('o-moedas')}<span><small>Total do orçamento</small><strong id="orc-total"></strong></span></div>
      </section>
      <details class="orc-card orc-cond" ${o?.condicoes || o?.observacoes ? 'open' : ''}><summary>Condições de pagamento e observações</summary><div class="grade">
        <label class="largo">Condições de pagamento e prazo <textarea name="condicoes" rows="3" maxlength="2000" placeholder="Ex.: 50% na aprovação e o restante na entrega">${esc(o?.condicoes ?? '')}</textarea></label>
        <label class="largo">Observações <textarea name="observacoes" rows="3" maxlength="2000">${esc(o?.observacoes ?? '')}</textarea></label></div></details>
      </fieldset>
      <p class="erro" id="erro-orc"></p>
      <div class="orc-rodape"><a class="orc-cancelar" href="#/orcamentos">${icone('o-voltar')} ${travado ? 'Voltar' : 'Cancelar'}</a>
        ${travado ? '' : `<button type="submit" class="orc-salvar">${icone('o-ok')} ${novo ? 'Salvar orçamento' : 'Salvar alterações'}</button>`}</div>
    </form>
    ${o?.notas.length ? `<h2>Notas emitidas deste orçamento</h2><div class="rolagem"><table class="tabela"><thead><tr><th>Nota</th><th>Competência</th><th class="num">Valor</th><th>Situação</th></tr></thead><tbody>
      ${o.notas.map((n) => `<tr class="clicavel" data-nota="${n.id}"><td>${n.n_nfse ? `NFS-e ${n.n_nfse}` : `DPS ${n.n_dps}`}</td><td>${dataBr(n.competencia)}</td><td class="num">${brl(n.valor)}</td><td>${carimbo(n.status)}</td></tr>`).join('')}</tbody></table></div>
      <p class="sutil">Faturado ${brl(o.faturado)} de ${brl(o.total)}${o.saldo > 0 ? ` · falta ${brl(o.saldo)}` : ''}. Nota rejeitada ou cancelada devolve o valor ao saldo.</p>` : ''}`;

  const f = $('#form-orc'), corpoTabela = $('#orc-itens tbody');
  const totais = () => {
    let bruto = 0;
    const linhas = corpoTabela.querySelectorAll('tr');
    linhas.forEach((tr) => {
      const q = numero(tr.querySelector('[name=quantidade]').value) || 0, v = numero(tr.querySelector('[name=valorUnitario]').value) || 0;
      const t = Math.round((q * v + Number.EPSILON) * 100) / 100; bruto += t; tr.querySelector('.t-item').textContent = brl(t);
    });
    const desc = numero(f.desconto.value) || 0;
    $('#orc-n').textContent = linhas.length; $('#orc-total').textContent = brl(Math.max(0, bruto - desc));
    $('#orc-vazio').hidden = linhas.length > 0; $('#orc-itens').hidden = linhas.length === 0;
  };
  const addItem = (i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><select name="servicoId" aria-label="Serviço"><option value="">Livre</option>${servicos.map((sv) => `<option value="${sv.id}" ${i.servico_id === sv.id ? 'selected' : ''}>${esc(sv.nome)}</option>`).join('')}</select></td>
      <td><input name="descricao" maxlength="500" required value="${esc(i.descricao)}" aria-label="Descrição"></td>
      <td class="c"><div class="orc-qtd"><button type="button" data-menos aria-label="Diminuir">−</button><input name="quantidade" data-num inputmode="decimal" value="${num(i.quantidade)}" required aria-label="Quantidade"><button type="button" data-mais aria-label="Aumentar">+</button></div></td>
      <td class="num"><input name="valorUnitario" data-num inputmode="decimal" value="${num(i.valor_unitario)}" required class="orc-val" aria-label="Valor unitário"></td>
      <td class="num t-item"></td><td class="c"><button type="button" class="orc-lixo" data-rm title="Remover serviço" aria-label="Remover serviço">${icone('o-lixo')}</button></td>`;
    const q = tr.querySelector('[name=quantidade]');
    tr.querySelector('[name=servicoId]').onchange = (ev) => {
      const sv = servicos.find((x) => x.id === Number(ev.target.value)); if (!sv) return;
      tr.querySelector('[name=descricao]').value = sv.descricao; if (sv.valor_padrao) tr.querySelector('[name=valorUnitario]').value = num(sv.valor_padrao); totais();
    };
    tr.querySelector('[data-menos]').onclick = () => { q.value = num(Math.max(1, (numero(q.value) || 1) - 1)); totais(); };
    tr.querySelector('[data-mais]').onclick = () => { q.value = num((numero(q.value) || 0) + 1); totais(); };
    tr.querySelector('[data-rm]').onclick = () => { tr.remove(); totais(); };
    tr.oninput = totais;
    corpoTabela.appendChild(tr);
    return tr;
  };
  itens0.forEach(addItem);
  $('#orc-add').onclick = () => {
    const campo = $('#orc-serv'), sv = servicos.find((x) => x.nome.toLowerCase() === campo.value.trim().toLowerCase());
    const tr = addItem(sv ? { servico_id: sv.id, descricao: sv.descricao, quantidade: 1, valor_unitario: sv.valor_padrao ?? '' } : { servico_id: null, descricao: '', quantidade: 1, valor_unitario: '' });
    campo.value = ''; totais(); tr.querySelector(sv ? '[name=quantidade]' : '[name=descricao]').focus();
  };
  // escolher o cliente cadastrado preenche nome, e-mail e WhatsApp; apagar a busca solta o vínculo
  const campoCli = $('#orc-cli');
  campoCli.oninput = () => {
    const t = tomadores.find((x) => tomOpc(x) === campoCli.value);
    if (t) { f.tomadorId.value = t.id; f.clienteNome.value = t.nome; f.clienteEmail.value = t.email ?? ''; f.clienteFone.value = t.fone ?? ''; }
    else if (!campoCli.value.trim()) f.tomadorId.value = '';
  };
  f.desconto.oninput = totais; totais();

  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = lerForm(f);
    const itens = [...corpoTabela.querySelectorAll('tr')].map((tr) => ({
      servicoId: tr.querySelector('[name=servicoId]').value ? Number(tr.querySelector('[name=servicoId]').value) : null,
      descricao: tr.querySelector('[name=descricao]').value.trim(), quantidade: numero(tr.querySelector('[name=quantidade]').value), valorUnitario: numero(tr.querySelector('[name=valorUnitario]').value) ?? 0,
    }));
    if (!itens.length) { $('#erro-orc').textContent = 'Adicione ao menos um serviço.'; return; }
    const corpo = { tomadorId: d.tomadorId ? Number(d.tomadorId) : null, clienteNome: d.clienteNome, clienteEmail: d.clienteEmail ?? '', clienteFone: d.clienteFone, validade: d.validade ?? '', condicoes: d.condicoes, observacoes: d.observacoes, desconto: d.desconto ?? 0, itens };
    try {
      const r = novo ? await api('POST', base, corpo) : await api('PUT', `${base}/${o.id}`, corpo);
      aviso(novo ? `Orçamento nº ${r.numero} criado.` : 'Orçamento salvo.');
      location.hash = `#/orcamento/${r.id}`; if (!novo) telaOrcamento(String(r.id));
    } catch (err) { $('#erro-orc').textContent = mensagemErro(err); }
  };
  if (!o) return;

  const recarregar = () => telaOrcamento(String(o.id));
  const mudar = async (acao, motivo) => { try { await api('POST', `${base}/${o.id}/situacao`, { acao, motivo }); recarregar(); } catch (err) { aviso(mensagemErro(err)); } };
  conteudo.querySelectorAll('[data-nota]').forEach((tr) => (tr.onclick = () => { location.hash = `#/nota/${tr.dataset.nota}`; }));
  $('#o-pdf').onclick = () => baixar(`${base}/${o.id}/pdf`, `Orcamento_${o.numero}.pdf`, true);
  $('#o-enviado') && ($('#o-enviado').onclick = () => mudar('ENVIADO'));
  $('#o-aprovado') && ($('#o-aprovado').onclick = () => mudar('APROVADO'));
  $('#o-reabrir') && ($('#o-reabrir').onclick = () => mudar('REABRIR'));
  $('#o-recusado') && ($('#o-recusado').onclick = () => { const m = prompt('Motivo da recusa (opcional):'); if (m !== null) mudar('RECUSADO', m); });
  $('#o-duplicar').onclick = async () => { try { const r = await api('POST', `${base}/${o.id}/duplicar`); aviso(`Orçamento nº ${r.numero} criado a partir deste.`); location.hash = `#/orcamento/${r.id}`; } catch (err) { aviso(mensagemErro(err)); } };
  $('#o-excluir') && ($('#o-excluir').onclick = async () => {
    if (!confirm(`Excluir o orçamento nº ${o.numero}?`)) return;
    try { await api('DELETE', `${base}/${o.id}`); aviso('Orçamento excluído.'); location.hash = '#/orcamentos'; } catch (err) { aviso(mensagemErro(err)); }
  });
  $('#o-email').onclick = () => abrirDialogo(`<form id="form-oe"><h2>Enviar orçamento nº ${o.numero} por e-mail</h2>
    <p class="sutil">O PDF segue em anexo, com o e-mail do escritório configurado.</p>
    <label>Para <input name="para" required value="${esc(o.email ?? '')}" placeholder="cliente@empresa.com"></label>
    <p class="erro" id="erro-oe"></p><div class="acoes"><button type="submit" class="primario">Enviar</button><button type="button" id="oe-cancelar">Cancelar</button></div></form>`, (d) => {
    $('#oe-cancelar').onclick = () => d.close();
    $('#form-oe').onsubmit = async (ev) => {
      ev.preventDefault(); const b = ev.submitter ?? ev.target.querySelector('[type=submit]'); b.disabled = true; b.textContent = 'Enviando…';
      try { await api('POST', `${base}/${o.id}/email`, { para: ev.target.para.value.split(/[,;\s]+/).filter(Boolean) }); d.close(); aviso('Orçamento enviado por e-mail.'); recarregar(); }
      catch (err) { $('#erro-oe').textContent = mensagemErro(err); b.disabled = false; b.textContent = 'Enviar'; }
    };
  });
  $('#o-wa').onclick = () => abrirDialogo(`<form id="form-ow"><h2>WhatsApp para ${esc(o.cliente ?? '')}</h2>
    <p class="sutil">O WhatsApp abre com a mensagem pronta. Baixe o PDF antes e anexe na conversa.</p>
    <label>WhatsApp do cliente (com DDD) <input name="fone" required value="${esc(o.fone ?? '')}" placeholder="(47) 99999-9999"></label>
    <label>Mensagem <textarea name="msg" rows="6">${esc(`Olá${o.cliente ? `, ${o.cliente}` : ''}! Segue o orçamento nº ${o.numero} da ${e.nome_fantasia || e.razao_social}, no valor de ${brl(o.total)}.${o.validade ? ` Ele vale até ${dataBr(o.validade)}.` : ''}\nQualquer dúvida, é só me chamar.`)}</textarea></label>
    <div class="acoes"><button type="button" id="ow-pdf">Baixar o PDF</button><button type="submit" class="primario">Abrir o WhatsApp</button><button type="button" id="ow-cancelar">Cancelar</button></div></form>`, (d) => {
    $('#ow-cancelar').onclick = () => d.close();
    $('#ow-pdf').onclick = () => baixar(`${base}/${o.id}/pdf`, `Orcamento_${o.numero}.pdf`);
    $('#form-ow').onsubmit = async (ev) => {
      ev.preventDefault();
      let fone = ev.target.fone.value.replace(/\D/g, ''); if (fone.length <= 11) fone = '55' + fone;
      window.open(`https://wa.me/${fone}?text=${encodeURIComponent(ev.target.msg.value)}`, '_blank');
      d.close(); if (o.situacao_base === 'RASCUNHO') mudar('ENVIADO');
    };
  });
  $('#o-converter') && ($('#o-converter').onclick = () => {
    const livres = o.itens.filter((i) => i.total - i.faturado > 0.004);
    abrirDialogo(`<form id="form-oc"><h2>Converter o orçamento nº ${o.numero} em nota</h2>
      <p class="sutil">Falta faturar <strong>${brl(o.saldo)}</strong>. A tela de emissão abre preenchida para você conferir antes de emitir.</p>
      <label class="linha"><input type="radio" name="modo" value="todos" checked> Uma nota somando os serviços do orçamento</label>
      ${livres.length > 1 || (livres.length === 1 && o.itens.length > 1) ? livres.map((i) => `<label class="linha"><input type="radio" name="modo" value="${i.id}"> Só o item: ${esc(i.descricao.slice(0, 60))} (falta ${brl(i.total - i.faturado)})</label>`).join('') : ''}
      <label>Valor desta nota (R$) <input name="valor" data-num inputmode="decimal" value="${num(o.saldo)}"></label>
      <p class="dica">Para faturar em partes (por exemplo, 50% de sinal), reduza o valor. O resto continua disponível neste orçamento.</p>
      <div class="acoes"><button type="submit" class="primario">Abrir a emissão</button><button type="button" id="oc-cancelar">Cancelar</button></div></form>`, (d) => {
      const valor = $('#form-oc').valor, modo = () => $('#form-oc').querySelector('[name=modo]:checked').value;
      $('#form-oc').querySelectorAll('[name=modo]').forEach((r) => (r.onchange = () => { const i = o.itens.find((x) => String(x.id) === modo()); valor.value = num(i ? Math.min(i.total - i.faturado, o.saldo) : o.saldo); }));
      $('#oc-cancelar').onclick = () => d.close();
      $('#form-oc').onsubmit = (ev) => { ev.preventDefault(); const v = numero(valor.value); d.close(); location.hash = `#/emitir/orc-${o.id}:${modo() === 'todos' ? '' : modo()}:${v ?? ''}`; };
    });
  });
}
