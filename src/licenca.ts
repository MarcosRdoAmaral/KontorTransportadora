import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db.js';
import { CHAVE_PUBLICA } from './licenca-chave.js';
import { ErroNegocio } from './servicos/emissao.js';

export const DIAS_TESTE = 7;
export const AVISO_DIAS = 15;

export type Plano = 'teste' | 'bronze' | 'prata' | 'ouro' | 'diamante';
export interface DadosPlano { nome: string; empresas: number | null; clientes: number | null; preco: number | null; resumo: string }

/** Planos do Kontor Gestão Transportadora. null = sem limite. O Diamante é feito sob encomenda. */
export const PLANOS: Record<Plano, DadosPlano> = {
  teste: { nome: 'Teste', empresas: 1, clientes: 2, preco: 0, resumo: '7 dias, 1 empresa e 2 clientes' },
  bronze: { nome: 'Bronze', empresas: 1, clientes: null, preco: 200, resumo: '1 empresa emitente' },
  prata: { nome: 'Prata', empresas: 5, clientes: null, preco: 350, resumo: 'Até 5 empresas' },
  ouro: { nome: 'Ouro', empresas: 15, clientes: null, preco: 600, resumo: 'Até 15 empresas' },
  diamante: { nome: 'Diamante', empresas: null, clientes: null, preco: null, resumo: 'Quantidade ilimitada, sob encomenda' },
};
export const PLANOS_PAGOS: Plano[] = ['bronze', 'prata', 'ouro', 'diamante'];

/**
 * Módulos vendidos à parte: vêm em todas as versões, mas só funcionam quando o código de ativação os traz (KG3).
 * No período de teste ficam liberados para o cliente conhecer; com a licença vencida, ficam bloqueados.
 * Para vender um módulo: acrescente aqui (id igual ao do módulo em src/auth.ts, MODULOS), com as rotas dele, e no gerador de licenças.
 */
export const MODULOS_PAGOS: Record<string, { nome: string; resumo: string; rotas: RegExp; emBreve?: boolean }> = {};
export const SUPORTE_WHATSAPP = '5547999017034';

export type EstadoLicenca = 'livre' | 'teste' | 'ativa' | 'vencida' | 'relogio';

/** Ganchos para teste. */
/** No aplicativo instalado (KONTOR_EMPACOTADO=1, definido pelo próprio aplicativo) nenhuma variável de ambiente muda a chave nem os arquivos de controle. */
const empacotado = () => process.env.KONTOR_EMPACOTADO === '1';
export const _teste = { agora: () => new Date(), chave: () => (empacotado() ? CHAVE_PUBLICA : process.env.LICENCA_CHAVE_PUBLICA ?? CHAVE_PUBLICA) };

// ---- Marcas do período de teste fora do banco ----
// O início do teste e a última data de uso também ficam em dois arquivos assinados, fora da pasta do banco.
// Apagar ou trocar o banco não reinicia o teste; adulterar uma marca bloqueia o teste.
function pastasMarcas(): string[] {
  if (!process.env.NFSE_MACHINE_ID) return []; // sem identificação estável do computador, as marcas não teriam como ser conferidas
  const teste = !empacotado() && process.env.KONTOR_MARCAS;
  if (teste) return teste.split(path.delimiter);
  if (process.platform === 'win32') {
    return [path.join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'Kontor', 'sys'), path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Kontor', 'cache')];
  }
  return [path.join(os.homedir(), '.local', 'share', 'kontor-sys'), path.join(os.homedir(), '.cache', 'kontor-sys')];
}
const assinar = (txt: string) => crypto.createHmac('sha256', crypto.createHash('sha256').update('kontor-marca|' + idMaquina()).digest()).update(txt).digest('hex');
const NOME_MARCA = 'kg-lic.dat';

interface Marcas { inicio: string | null; visto: string | null; adulterada: boolean; faltando: boolean }
function lerMarcas(): Marcas {
  const m: Marcas = { inicio: null, visto: null, adulterada: false, faltando: false };
  for (const pasta of pastasMarcas()) {
    let txt: string;
    try { txt = fs.readFileSync(path.join(pasta, NOME_MARCA), 'utf8'); } catch { m.faltando = true; continue; }
    const [inicio, visto, ass] = txt.trim().split('|');
    if (!inicio || !visto || !ass || assinar(`${inicio}|${visto}`) !== ass) { m.adulterada = true; continue; }
    if (!m.inicio || inicio < m.inicio) m.inicio = inicio;
    if (!m.visto || visto > m.visto) m.visto = visto;
  }
  return m;
}
function gravarMarcas(inicio: string, visto: string) {
  const txt = `${inicio}|${visto}|${assinar(`${inicio}|${visto}`)}`;
  for (const pasta of pastasMarcas()) {
    try { fs.mkdirSync(pasta, { recursive: true }); fs.writeFileSync(path.join(pasta, NOME_MARCA), txt); } catch { /* pasta sem permissão: a outra marca e o banco continuam valendo */ }
  }
}

const hojeBr = () => new Date(_teste.agora().getTime() - 3 * 3600e3).toISOString().slice(0, 10);
const b64u = (b: Buffer) => b.toString('base64url');

function linha() {
  db.prepare('INSERT OR IGNORE INTO licenca (id) VALUES (1)').run();
  return db.prepare('SELECT * FROM licenca WHERE id = 1').get() as any;
}

function idMaquina(): string {
  const env = process.env.NFSE_MACHINE_ID;
  if (env) return env;
  const l = linha();
  if (l.maquina_alt) return l.maquina_alt;
  const novo = crypto.randomUUID();
  db.prepare('UPDATE licenca SET maquina_alt = ? WHERE id = 1').run(novo);
  return novo;
}

/** Código que o cliente informa ao dono: 16 hex em grupos de 4. */
export function codigoDoComputador(): string {
  const h = crypto.createHash('sha256').update('kontor|' + idMaquina()).digest('hex').slice(0, 16).toUpperCase();
  return h.match(/.{4}/g)!.join('-');
}

const soHex = (s: string) => s.replace(/[^0-9a-f]/gi, '').toUpperCase();

export interface DadosCodigo { maquina: string; ate: string; cliente: string; plano: Plano; modulos: string[] }

/** Confere a assinatura e devolve os dados, ou lança ErroNegocio. */
export function lerCodigo(codigo: string): DadosCodigo {
  const chave = _teste.chave();
  if (!chave) throw new ErroNegocio('Controle de licença ainda não configurado nesta versão.');
  const partes = codigo.trim().split('.');
  if (partes.length !== 3 || !['KG1', 'KG2', 'KG3'].includes(partes[0])) throw new ErroNegocio('Código de ativação inválido.');
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: chave }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(partes[1], 'base64url'), pub, Buffer.from(partes[2], 'base64url'));
  } catch { ok = false; }
  if (!ok) throw new ErroNegocio('Código de ativação inválido.');
  const campos = Buffer.from(partes[1], 'base64url').toString('utf8').split('|');
  const [maquina, ate] = campos;
  if (!maquina || !/^\d{4}-\d{2}-\d{2}$/.test(ate ?? '')) throw new ErroNegocio('Código de ativação inválido.');
  // KG1 (anterior aos planos) segue sem limites; KG2 traz o plano antes do nome do cliente; KG3 traz também os módulos contratados
  if (partes[0] === 'KG1') return { maquina, ate, cliente: campos.slice(2).join('|'), plano: 'diamante', modulos: [] };
  const plano = campos[2] as Plano;
  if (!PLANOS_PAGOS.includes(plano)) throw new ErroNegocio('Código de ativação inválido.');
  if (partes[0] === 'KG2') return { maquina, ate, cliente: campos.slice(3).join('|'), plano, modulos: [] };
  const modulos = String(campos[3] ?? '').split(',').map((m) => m.trim()).filter((m) => /^[a-z0-9_]{1,30}$/.test(m));
  return { maquina, ate, cliente: campos.slice(4).join('|'), plano, modulos };
}

const dias = (de: string, ate: string) => Math.round((Date.parse(ate) - Date.parse(de)) / 86400e3);

export function statusLicenca() {
  const todos = Object.keys(MODULOS_PAGOS);
  const base = { codigoComputador: codigoDoComputador(), diasTeste: DIAS_TESTE, plano: 'teste' as Plano, planoNome: PLANOS.teste.nome, limites: { empresas: PLANOS.teste.empresas, clientes: PLANOS.teste.clientes }, modulos: [] as string[] };
  if (!_teste.chave()) return { ...base, modulos: todos, plano: 'diamante' as Plano, planoNome: 'Sem controle', limites: { empresas: null as number | null, clientes: null as number | null }, estado: 'livre' as EstadoLicenca, permitido: true, mensagem: 'Controle de licença desativado.' };

  const l = linha();
  const hoje = hojeBr();
  const agoraIso = _teste.agora().toISOString();
  const marcas = lerMarcas();
  // relógio voltado: data atual bem anterior à última vez que o sistema foi aberto (no banco ou nas marcas)
  const vistoDia = [l.ultimo_visto?.slice(0, 10), marcas.visto].filter(Boolean).sort().pop() as string | undefined;
  if (vistoDia && dias(hoje, vistoDia) > 1) {
    return { ...base, estado: 'relogio' as EstadoLicenca, permitido: false, mensagem: 'A data do computador está anterior à última utilização. Corrija a data do Windows para voltar a emitir.' };
  }
  if (!vistoDia || vistoDia < hoje) db.prepare('UPDATE licenca SET ultimo_visto = ? WHERE id = 1').run(agoraIso);

  // vale o início mais antigo entre o banco e as marcas: trocar o banco não dá novo teste
  const inicio = ([l.inicio_teste?.slice(0, 10), marcas.inicio].filter(Boolean) as string[]).sort()[0] ?? hoje;
  if (l.inicio_teste?.slice(0, 10) !== inicio) db.prepare('UPDATE licenca SET inicio_teste = ? WHERE id = 1').run(inicio);
  const vistoGravar = vistoDia && vistoDia > hoje ? vistoDia : hoje;
  if (!marcas.adulterada && (marcas.faltando || marcas.inicio !== inicio || marcas.visto !== vistoGravar)) gravarMarcas(inicio, vistoGravar);

  if (l.codigo) {
    try {
      const d = lerCodigo(l.codigo);
      if (soHex(d.maquina) === soHex(base.codigoComputador)) {
        const resta = dias(hoje, d.ate);
        const pl = PLANOS[d.plano];
        const dp = { plano: d.plano, planoNome: pl.nome, limites: { empresas: pl.empresas, clientes: pl.clientes } };
        if (resta >= 0) {
          return { ...base, ...dp, modulos: d.modulos.filter((m) => todos.includes(m)), estado: 'ativa' as EstadoLicenca, permitido: true, ate: d.ate, cliente: d.cliente, diasRestantes: resta,
            aviso: resta <= AVISO_DIAS, mensagem: `Licença válida até ${d.ate.split('-').reverse().join('/')}.` };
        }
        return { ...base, ...dp, estado: 'vencida' as EstadoLicenca, permitido: false, ate: d.ate, cliente: d.cliente, diasRestantes: resta,
          mensagem: `Licença vencida em ${d.ate.split('-').reverse().join('/')}. Use "Alterar plano" ou informe o código do computador ao suporte para renovar.` };
      }
    } catch { /* cai para o teste */ }
  }
  if (marcas.adulterada) {
    return { ...base, estado: 'vencida' as EstadoLicenca, permitido: false, diasRestantes: 0,
      mensagem: 'Os dados do período de teste foram alterados. Informe o código do computador ao suporte para receber o código de ativação.' };
  }
  const resta = DIAS_TESTE - dias(inicio, hoje);
  if (resta > 0) {
    return { ...base, modulos: todos, estado: 'teste' as EstadoLicenca, permitido: true, diasRestantes: resta, aviso: resta <= AVISO_DIAS,
      mensagem: `Período de teste: ${resta} dia(s) restante(s).` };
  }
  return { ...base, estado: 'vencida' as EstadoLicenca, permitido: false, diasRestantes: 0,
    mensagem: 'O período de teste terminou. Informe o código do computador ao suporte para receber o código de ativação.' };
}

export function ativarLicenca(codigo: string) {
  const d = lerCodigo(codigo);
  if (soHex(d.maquina) !== soHex(codigoDoComputador())) throw new ErroNegocio('Este código foi gerado para outro computador.');
  if (dias(hojeBr(), d.ate) < 0) throw new ErroNegocio('Este código de ativação já está vencido.');
  linha();
  db.prepare("UPDATE licenca SET codigo = ?, cliente = ?, ate = ?, ativada_em = datetime('now') WHERE id = 1").run(codigo.trim(), d.cliente, d.ate);
  cacheModulos = null;
  return statusLicenca();
}

// ---- Módulos vendidos à parte ----
let cacheModulos: { ate: number; lista: string[] } | null = null;
/** Módulos pagos liberados neste computador (guardado por 1 minuto: a conferência roda a cada requisição). */
export function modulosLiberados(): string[] {
  const agora = Date.now();
  if (cacheModulos && cacheModulos.ate > agora) return cacheModulos.lista;
  let lista: string[];
  try { lista = statusLicenca().modulos; } catch { return []; } // banco indisponível: nenhum módulo pago
  cacheModulos = { ate: agora + 60e3, lista };
  return lista;
}
export const _limparCacheModulos = () => { cacheModulos = null; };

/** Recusa de uma rota de módulo pago não contratado (ou null). */
export function recusaModuloPago(caminho: string): string | null {
  for (const [id, m] of Object.entries(MODULOS_PAGOS)) {
    if (m.rotas.test(caminho) && !modulosLiberados().includes(id)) return `O módulo ${m.nome} não está contratado nesta licença. Fale com o suporte para contratar (Configurações > Licença).`;
  }
  return null;
}

/** Bloqueia apenas ações que emitem/alteram notas. Consultas, downloads e backup seguem liberados. */
export function exigirLicenca(): void {
  const s = statusLicenca();
  if (!s.permitido) throw new ErroNegocio(s.mensagem, 402);
}

/** Quantidade já cadastrada de cada coisa que o plano limita. */
export function usoAtual() {
  return {
    empresas: (db.prepare('SELECT COUNT(*) n FROM empresas').get() as any).n as number,
    clientes: (db.prepare('SELECT COUNT(*) n FROM (SELECT documento FROM tomadores WHERE documento IS NOT NULL GROUP BY documento)').get() as any).n as number,
  };
}

/** Recusa um novo cadastro que ultrapassaria o limite do plano. `documento` de cliente que já existe não conta de novo. */
export function exigirLimite(tipo: 'empresas' | 'clientes', documento?: string | null): void {
  const s = statusLicenca();
  const max = s.limites[tipo];
  if (max == null) return;
  if (tipo === 'clientes' && documento && db.prepare('SELECT 1 FROM tomadores WHERE documento = ?').get(documento)) return;
  const usado = usoAtual()[tipo];
  if (usado < max) return;
  const nome = tipo === 'empresas' ? (max === 1 ? '1 empresa' : `${max} empresas`) : (max === 1 ? '1 cliente' : `${max} clientes`);
  throw new ErroNegocio(`O plano ${s.planoNome} permite ${nome}. Para cadastrar mais, altere o plano em Configurações > Licença.`, 402);
}

// ---- Acesso de suporte (usuário master) ----
/** Validade máxima de um código de suporte: mesmo que o gerador peça mais, o sistema não aceita. */
export const SUPORTE_MAX_HORAS = 24;

/**
 * Confere um código de suporte (KS1.<carga>.<assinatura>), gerado no "Gerador de licenças" com a chave privada do Kontor.
 * Carga: SUPORTE|<código do computador>|<expira em, ISO>|<aleatório>. Só vale neste computador e até expirar.
 * Retorna a data de expiração ou lança ErroNegocio (sempre com a mesma mensagem, para não ajudar quem tenta adivinhar).
 */
export function acessoDeSuporte(codigo: string): string {
  const invalido = () => new ErroNegocio('Usuário ou senha incorretos.', 401);
  const chave = _teste.chave();
  const partes = String(codigo ?? '').trim().split('.');
  if (!chave || partes.length !== 3 || partes[0] !== 'KS1') throw invalido();
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: chave }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(partes[1], 'base64url'), pub, Buffer.from(partes[2], 'base64url'));
  } catch { ok = false; }
  if (!ok) throw invalido();
  const [tipo, maquina, expira] = Buffer.from(partes[1], 'base64url').toString('utf8').split('|');
  const fim = Date.parse(expira ?? '');
  const agora = _teste.agora().getTime();
  if (tipo !== 'SUPORTE' || soHex(maquina ?? '') !== soHex(codigoDoComputador())) throw invalido();
  if (!Number.isFinite(fim) || fim < agora || fim > agora + (SUPORTE_MAX_HORAS * 3600e3) + 5 * 60e3) throw invalido();
  return new Date(fim).toISOString();
}
