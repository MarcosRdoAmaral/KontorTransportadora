// Processo principal do aplicativo de desktop (Windows).
// Sobe o servidor do sistema em 127.0.0.1 (só este computador acessa) e abre a janela.
import { app, BrowserWindow, Menu, dialog, shell, safeStorage, net, ipcMain } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { buscarNovaVersao, urlPermitida } from './atualizador.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NOME = 'Kontor Gestão Transportadora';
const NOME_DADOS = 'Kontor Gestão Transportadora'; // nome interno: define a pasta de dados (%APPDATA%\Kontor Gestão Transportadora). Não mudar, senão os dados "somem".
const PORTA_PREFERIDA = 38271;

app.setName(NOME_DADOS);
if (!app.requestSingleInstanceLock()) app.quit();

const raizApp = app.getAppPath();
const pastaUsuario = app.getPath('userData'); // %APPDATA%\Kontor Gestão Transportadora
const pastaDados = path.join(pastaUsuario, 'dados');
const arquivoBanco = path.join(pastaDados, 'nfse.db');
const pendente = path.join(pastaUsuario, 'restaurar.pendente.db');

let janela = null;
let servidor = null;
let banco = null;
let urlLocal = '';

// ---------------- Segredos: protegidos pelo cofre do Windows (DPAPI) ----------------
async function carregarSegredos() {
  fs.mkdirSync(pastaUsuario, { recursive: true });
  const cifrado = path.join(pastaUsuario, 'segredos.bin');
  const aberto = path.join(pastaUsuario, 'segredos.json'); // somente se o cofre do sistema não existir
  if (fs.existsSync(cifrado)) return JSON.parse((await safeStorage.decryptStringAsync(fs.readFileSync(cifrado))).result);
  if (fs.existsSync(aberto)) return JSON.parse(fs.readFileSync(aberto, 'utf8'));
  const novos = { masterKey: crypto.randomBytes(32).toString('base64'), sessionSecret: crypto.randomBytes(48).toString('base64') };
  if (await safeStorage.isAsyncEncryptionAvailable()) fs.writeFileSync(cifrado, await safeStorage.encryptStringAsync(JSON.stringify(novos)));
  else fs.writeFileSync(aberto, JSON.stringify(novos), { mode: 0o600 });
  return novos;
}

// ---------------- Restauração de backup (aplicada na próxima abertura) ----------------
function aplicarRestauracaoPendente() {
  if (!fs.existsSync(pendente)) return;
  fs.mkdirSync(pastaDados, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(arquivoBanco)) {
    fs.copyFileSync(arquivoBanco, path.join(pastaDados, `antes-da-restauracao-${carimbo}.db`));
  }
  for (const sufixo of ['', '-wal', '-shm']) fs.rmSync(arquivoBanco + sufixo, { force: true });
  fs.renameSync(pendente, arquivoBanco);
}

function ehSqlite(arquivo) {
  const fd = fs.openSync(arquivo, 'r');
  const buf = Buffer.alloc(15);
  fs.readSync(fd, buf, 0, 15, 0);
  fs.closeSync(fd);
  return buf.toString() === 'SQLite format 3';
}

// Identificação do computador (Windows: MachineGuid). Só o hash sai daqui.
function idDaMaquina() {
  try {
    if (process.platform === 'win32') {
      const saida = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true });
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{16,})/.exec(saida);
      if (m) return m[1].toLowerCase();
    }
  } catch { /* usa o código gerado pelo próprio sistema */ }
  return '';
}

// ---------------- Servidor local ----------------
async function iniciarServidor() {
  const segredos = await carregarSegredos();
  aplicarRestauracaoPendente();
  Object.assign(process.env, {
    NFSE_DESKTOP: '1',
    KONTOR_EMPACOTADO: '1', // o servidor ignora variáveis que trocariam a chave de licença
    NFSE_MACHINE_ID: idDaMaquina(),
    HOST: '127.0.0.1',
    MASTER_KEY: segredos.masterKey,
    SESSION_SECRET: segredos.sessionSecret,
    DATABASE_PATH: arquivoBanco,
    STORAGE_DIR: path.join(pastaDados, 'arquivos'),
    BACKUP_DIR: path.join(pastaDados, 'backups'),
    SEFIN_URL_TESTE: process.env.NFSE_TESTE_SEFIN ?? '',
  });
  if (!process.env.SEFIN_URL_TESTE) delete process.env.SEFIN_URL_TESTE;
  delete process.env.LICENCA_CHAVE_PUBLICA;
  delete process.env.KONTOR_MARCAS;

  const carregar = (arq) => import(pathToFileURL(path.join(raizApp, 'dist', arq)).href);
  banco = (await carregar('db.js')).db;
  const { criarApp } = await carregar('server.js');
  servidor = await criarApp();
  try {
    await servidor.listen({ port: PORTA_PREFERIDA, host: '127.0.0.1' });
  } catch {
    await servidor.listen({ port: 0, host: '127.0.0.1' });
  }
  return `http://127.0.0.1:${servidor.server.address().port}`;
}

// ---------------- Janela e menu ----------------
function criarJanela() {
  janela = new BrowserWindow({
    width: 1320, height: 860, minWidth: 900, minHeight: 600, show: false, title: NOME, backgroundColor: '#0a0a0a',
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // abre sempre maximizada (mostrada só depois de maximizar, sem piscar no tamanho menor)
  janela.maximize();
  janela.once('ready-to-show', () => { if (!janela.isMaximized()) janela.maximize(); janela.show(); });
  setTimeout(() => { if (janela && !janela.isDestroyed() && !janela.isVisible()) { janela.maximize(); janela.show(); } }, 5000); // garantia, se a página demorar
  janela.loadURL(urlLocal);

  // PDFs (DANFSe) abrem em janela própria; links externos vão para o navegador padrão.
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:') || url.startsWith(urlLocal)) return { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 1000, autoHideMenuBar: true } };
    if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  janela.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(urlLocal)) { e.preventDefault(); if (/^(https?|mailto):/.test(url)) shell.openExternal(url); }
  });
}

async function salvarBackup() {
  const dia = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(janela, {
    title: 'Salvar backup', defaultPath: path.join(app.getPath('documents'), `nfse-backup-${dia}.db`),
    filters: [{ name: 'Backup do Kontor Gestão Transportadora', extensions: ['db'] }],
  });
  if (r.canceled || !r.filePath) return;
  try {
    banco.copiarPara(r.filePath);
    dialog.showMessageBox(janela, { type: 'info', message: 'Backup salvo.', detail: r.filePath });
  } catch (e) {
    dialog.showErrorBox('Não foi possível salvar o backup', String(e.message ?? e));
  }
}

async function restaurarBackup() {
  const r = await dialog.showOpenDialog(janela, { title: 'Escolha o arquivo de backup', properties: ['openFile'], filters: [{ name: 'Backup do Kontor Gestão Transportadora', extensions: ['db'] }] });
  if (r.canceled || !r.filePaths[0]) return;
  const origem = r.filePaths[0];
  if (!ehSqlite(origem)) return dialog.showErrorBox('Arquivo inválido', 'Este arquivo não é um backup do Kontor Gestão Transportadora.');
  const c = await dialog.showMessageBox(janela, {
    type: 'warning', buttons: ['Restaurar e reiniciar', 'Cancelar'], defaultId: 1, cancelId: 1,
    message: 'Restaurar este backup?',
    detail: 'Os dados atuais serão substituídos pelos do backup. Uma cópia dos dados atuais é guardada na pasta de dados antes da troca. Certificados A1 precisam ser enviados de novo se o backup veio de outro computador.',
  });
  if (c.response !== 0) return;
  fs.copyFileSync(origem, pendente);
  app.relaunch();
  app.quit();
}

// ---------------- Atualização automática (GitHub Releases) ----------------
function repositorioAtualizacoes() {
  try { return JSON.parse(fs.readFileSync(path.join(raizApp, 'package.json'), 'utf8')).kontor?.repositorioAtualizacoes ?? ''; } catch { return ''; }
}

let verificando = false;
let pendente_atualizacao = null; // { versao, notas, exe, sha } quando há versão nova
let baixada = null;               // { versao, caminho } instalador já baixado e conferido
let instalarAoFechar = false;     // instala a versão baixada quando o programa for fechado
let instalando = false;

const infoPendente = () => (pendente_atualizacao ? { versao: pendente_atualizacao.versao, notas: pendente_atualizacao.notas,
  baixada: baixada?.versao === pendente_atualizacao.versao, aoFechar: instalarAoFechar && baixada?.versao === pendente_atualizacao.versao } : null);
ipcMain.handle('atualizacao:pendente', () => infoPendente());
ipcMain.handle('atualizacao:instalar', async () => {
  if (!pendente_atualizacao) return { ok: false };
  try { await baixarEInstalar(pendente_atualizacao); return { ok: true }; }
  catch (e) { return { ok: false, erro: String(e?.message ?? e) }; }
});
// Só baixa (fica pronta para instalar); com aoFechar, instala sozinha quando o Kontor for fechado.
ipcMain.handle('atualizacao:baixar', async (_e, opcoes) => {
  if (!pendente_atualizacao) return { ok: false };
  try {
    await baixar(pendente_atualizacao);
    instalarAoFechar = !!opcoes?.aoFechar;
    return { ok: true, ...infoPendente() };
  } catch (e) { return { ok: false, erro: String(e?.message ?? e) }; }
});
ipcMain.handle('atualizacao:aoFechar', (_e, ligar) => { instalarAoFechar = !!ligar && !!baixada; return infoPendente(); });

let ultimaVerificacao = 0;
let ultimoResultado = { situacao: 'nunca', atual: '' };

// Verificação pela tela Configurações > Atualizações (sem janelas de diálogo): devolve o resultado.
ipcMain.handle('atualizacao:verificar', async () => {
  await verificarAtualizacao({ silenciosa: true });
  if (emAndamento) await emAndamento; // já havia uma consulta em curso: espera o resultado dela
  return { ...ultimoResultado, atual: app.getVersion(), em: ultimaVerificacao };
});
ipcMain.handle('atualizacao:estado', () => ({ ...ultimoResultado, atual: app.getVersion(), em: ultimaVerificacao }));

let emAndamento = null;
function verificarAtualizacao(opcoes = {}) {
  if (!emAndamento) emAndamento = executarVerificacao(opcoes).finally(() => { emAndamento = null; });
  return emAndamento;
}

async function executarVerificacao({ manual = false } = {}) {
  verificando = true;
  try {
    const repo = repositorioAtualizacoes();
    const r = await buscarNovaVersao(repo, app.getVersion(), (u, o) => net.fetch(u, o));
    ultimaVerificacao = Date.now();
    ultimoResultado = { situacao: r.situacao, versao: r.versao ?? null, notas: r.notas ?? null };
    if (r.situacao === 'nao_configurado') {
      if (manual) dialog.showMessageBox(janela, { type: 'info', message: 'Atualização automática não configurada.', detail: 'Falta informar o repositório de atualizações do programa.' });
      return;
    }
    if (r.situacao !== 'nova') {
      if (manual) dialog.showMessageBox(janela, { type: 'info', message: r.situacao === 'atualizado' ? 'Você já está na versão mais recente.' : 'Nenhuma atualização disponível.', detail: `Versão instalada: ${app.getVersion()}` });
      return;
    }
    pendente_atualizacao = r;
    janela?.webContents.send('atualizacao:nova', { versao: r.versao, notas: r.notas });
    if (!manual) return; // verificação automática ou da tela de Configurações: o aviso fixo na interface basta
    const c = await dialog.showMessageBox(janela, {
      type: 'question', buttons: ['Atualizar agora', 'Baixar e instalar ao fechar', 'Depois'], defaultId: 0, cancelId: 2,
      message: `Nova versão ${r.versao} disponível`,
      detail: `Você está na versão ${app.getVersion()}.\n\nAntes de instalar, o programa faz uma cópia de segurança dos seus dados. Suas notas e cadastros são mantidos.${r.notas ? '\n\nNovidades:\n' + r.notas.slice(0, 800) : ''}`,
    });
    if (c.response === 1) { await baixar(r); instalarAoFechar = true; janela?.webContents.send('atualizacao:nova', infoPendente()); return; }
    if (c.response !== 0) return;
    await baixarEInstalar(r);
  } catch (e) {
    ultimaVerificacao = Date.now();
    ultimoResultado = { situacao: 'erro', erro: `Não foi possível consultar as atualizações (${String(e?.message ?? e).slice(0, 120)}). Verifique a conexão com a internet.` };
    if (manual) dialog.showErrorBox('Não foi possível verificar atualizações', String(e?.message ?? e));
  } finally { verificando = false; }
}

/** Baixa o instalador da versão nova (conferindo o SHA-256). Se já foi baixado e confere, não baixa de novo. */
async function baixar(r) {
  if (!urlPermitida(r.exe.browser_download_url)) throw new Error('Endereço de download não permitido.');
  if (baixada?.versao === r.versao && fs.existsSync(baixada.caminho)) return baixada.caminho;
  const destino = path.join(app.getPath('temp'), r.exe.name);
  const esperado = r.sha ? (await (await net.fetch(r.sha.browser_download_url)).text()).trim().split(/\s+/)[0].toLowerCase() : null;
  const hashDe = (arq) => crypto.createHash('sha256').update(fs.readFileSync(arq)).digest('hex');
  if (!(esperado && fs.existsSync(destino) && hashDe(destino) === esperado)) {
    janela?.setProgressBar(2); // indeterminado
    try {
      const resp = await net.fetch(r.exe.browser_download_url);
      if (!resp.ok) throw new Error(`Download falhou (${resp.status}).`);
      const hash = crypto.createHash('sha256');
      const saida = fs.createWriteStream(destino);
      for await (const parte of resp.body) { hash.update(parte); if (!saida.write(parte)) await new Promise((ok) => saida.once('drain', ok)); }
      await new Promise((ok, erro) => { saida.end(ok); saida.on('error', erro); });
      if (esperado && esperado !== hash.digest('hex')) { fs.rmSync(destino, { force: true }); throw new Error('O arquivo baixado está corrompido (SHA-256 diferente). Tente novamente.'); }
    } finally { janela?.setProgressBar(-1); }
  }
  baixada = { versao: r.versao, caminho: destino };
  return destino;
}

/** Cópia de segurança dos dados e abre o instalador (ele fecha o programa, troca os arquivos e preserva os dados). */
function instalar(caminho) {
  if (instalando) return;
  instalando = true;
  const dia = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const pastaBkp = path.join(pastaDados, 'antes-de-atualizar');
  fs.mkdirSync(pastaBkp, { recursive: true });
  banco.copiarPara(path.join(pastaBkp, `nfse-v${app.getVersion()}-${dia}.db`));
  spawn(caminho, [], { detached: true, stdio: 'ignore' }).unref();
}

async function baixarEInstalar(r) {
  const caminho = await baixar(r);
  instalar(caminho);
  app.quit();
}

function montarMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Arquivo', submenu: [
      { label: 'Salvar backup…', click: salvarBackup },
      { label: 'Restaurar backup…', click: restaurarBackup },
      { type: 'separator' },
      { label: 'Abrir pasta de dados', click: () => shell.openPath(pastaDados) },
      { type: 'separator' },
      { role: 'quit', label: 'Sair' },
    ] },
    { label: 'Exibir', submenu: [
      { role: 'reload', label: 'Recarregar' }, { role: 'togglefullscreen', label: 'Tela cheia' }, { type: 'separator' },
      { role: 'zoomIn', label: 'Aumentar' }, { role: 'zoomOut', label: 'Diminuir' }, { role: 'resetZoom', label: 'Tamanho normal' },
    ] },
    { label: 'Ajuda', submenu: [
      { label: 'Verificar atualizações…', click: () => verificarAtualizacao({ manual: true }) },
      { label: 'Sobre', click: () => dialog.showMessageBox(janela, { type: 'info', message: NOME, detail: `Versão ${app.getVersion()}\nDados guardados em:\n${pastaDados}` }) },
    ] },
  ]));
}

app.on('second-instance', () => { if (janela) { if (janela.isMinimized()) janela.restore(); janela.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  // "Baixar e instalar ao fechar": ao sair, instala a versão já baixada
  if (instalarAoFechar && baixada && !instalando && fs.existsSync(baixada.caminho)) { try { instalar(baixada.caminho); } catch (e) { console.error('Instalação ao fechar:', e); } }
  servidor?.close();
});

app.whenReady().then(async () => {
  try {
    urlLocal = await iniciarServidor();
    montarMenu();
    criarJanela();
    // busca contínua: logo ao abrir, a cada hora e sempre que a janela volta ao foco após 30 min sem checar
    setTimeout(() => verificarAtualizacao(), 8000);
    setInterval(() => verificarAtualizacao(), 3600e3).unref();
    app.on('browser-window-focus', () => { if (Date.now() - ultimaVerificacao > 30 * 60e3) verificarAtualizacao(); });
  } catch (e) {
    dialog.showErrorBox(`${NOME} não conseguiu iniciar`, String(e?.stack ?? e));
    app.exit(1);
  }
});
