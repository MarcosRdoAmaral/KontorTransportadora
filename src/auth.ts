import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { db } from './db.js';
import { MODULOS_PAGOS, modulosLiberados, recusaModuloPago } from './licenca.js';

export type Papel = 'admin' | 'operador' | 'cliente';
export type Tipo = 'adm' | 'normal';

/** Módulos que podem ser liberados por usuário. Configurações (usuários, e-mail, backup, licença) é sempre só do adm. */
export const MODULOS = {
  painel: 'Painel do mês', emitir: 'Emitir nota', notas: 'Notas emitidas', cobrancas: 'Cobranças',
  banco: 'Dados bancários', despesas: 'Despesas e balanço', tomadores: 'Clientes', servicos: 'Serviços', empresas: 'Empresas', relatorios: 'Relatórios', compras: 'Compras', tributacao: 'Tributação',
  excluir: 'Excluir registros',
} as const;
export type Modulo = keyof typeof MODULOS;
export const TODOS_MODULOS = Object.keys(MODULOS) as Modulo[];
/** Senha padrão das versões antigas (pública). Não é mais atribuída a ninguém; só continua proibida como senha nova. */
export const SENHA_PADRAO = 'Kontor2026';
export const LOGIN_MESTRE = 'KONTOR';
/** Hash que nenhuma senha confere (conferirSenha só aceita scrypt): conta sem login por senha. */
export const SEM_SENHA = '!';

/** Senha provisória aleatória (12 caracteres, sem letras ou números que se confundem). Mostrada uma única vez a quem a gerou. */
export function senhaProvisoria(): string {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 12 }, () => alfabeto[crypto.randomInt(alfabeto.length)]).join('');
}

export interface Usuario {
  id: number;
  escritorio_id: number;
  nome: string;
  email: string;
  papel: Papel;
  login: string;
  tipo: Tipo;
  permissoes: string | null;
  trocar_senha: number;
  mestre: number;
  sessao_v: number;
}

/** Módulos que o usuário pode usar (adm: todos). */
export function modulosDoUsuario(u: Pick<Usuario, 'tipo' | 'permissoes'>): Modulo[] {
  const todos = modulosPermitidos(u);
  if (!todos.some((m) => MODULOS_PAGOS[m])) return todos;
  const lib = modulosLiberados(); // módulos vendidos à parte só com a licença que os traz
  return todos.filter((m) => !MODULOS_PAGOS[m] || lib.includes(m));
}

/** Módulos marcados para o usuário (adm: todos), independentemente da licença. */
export function modulosPermitidos(u: Pick<Usuario, 'tipo' | 'permissoes'>): Modulo[] {
  if (u.tipo === 'adm') return TODOS_MODULOS;
  if (u.permissoes == null) return TODOS_MODULOS.filter((m) => m !== 'excluir'); // exclusão nunca é liberada por padrão
  try { return (JSON.parse(u.permissoes) as string[]).filter((m): m is Modulo => m in MODULOS); } catch { return []; }
}

type Regra = { m?: string; r: RegExp; mod: Modulo[] | 'adm' | 'livre' };
const LER_NOTA: Modulo[] = ['notas', 'painel', 'cobrancas', 'emitir'];
/** Qual módulo cada rota exige. Rota que não está aqui é negada (lista fechada). */
const REGRAS: Regra[] = [
  { r: /^\/api\/me(\/empresa|\/senha|\/avatar)?$/, mod: 'livre' },
  { m: 'GET', r: /^\/api\/licenca$/, mod: 'livre' },
  { m: 'GET', r: /^\/api\/inicio$/, mod: 'livre' },
  { m: 'GET', r: /^\/api\/consulta\/cnpj\//, mod: 'livre' },
  { m: 'GET', r: /^\/api\/empresas$/, mod: 'livre' },
  { r: /^\/api\/empresas\/\d+\/contabilidade(\/|$)/, mod: 'adm' },
  { r: /^\/api\/(usuarios|email\/config|email\/testar|email\/modelos|email\/assinatura|backup|tabelas|licenca|contabilidade)(\/|$)/, mod: 'adm' },
  { r: /^\/api\/empresas(\/\d+)?$|^\/api\/empresas\/\d+\/(certificado|logo)$/, mod: ['empresas'] },
  { m: 'POST', r: /^\/api\/tomadores\/\d+\/descricao$/, mod: ['emitir', 'tomadores'] },
  { r: /^\/api\/empresas\/\d+\/orcamentos(\/\d+(\/(duplicar|situacao|conversao|pdf|email))?)?$/, mod: ['emitir'] },
  { m: 'GET', r: /^\/api\/empresas\/\d+\/tomadores$/, mod: ['tomadores', 'emitir', 'cobrancas'] },
  { r: /^\/api\/empresas\/\d+\/tomadores(\/planilha\/(analisar|importar))?$|^\/api\/tomadores\/\d+$/, mod: ['tomadores'] },
  { m: 'GET', r: /^\/api\/empresas\/\d+\/servicos$/, mod: ['servicos', 'emitir'] },
  { r: /^\/api\/empresas\/\d+\/servicos$|^\/api\/servicos\/\d+$/, mod: ['servicos'] },
  { m: 'GET', r: /^\/api\/empresas\/\d+\/conta-bancaria$/, mod: ['banco', 'empresas', 'cobrancas', 'emitir'] },
  { m: 'GET', r: /^\/api\/empresas\/\d+\/cora$/, mod: ['banco', 'empresas', 'cobrancas', 'emitir'] },
  { r: /^\/api\/empresas\/\d+\/cora\/(sincronizar)$/, mod: ['cobrancas', 'banco'] },
  { r: /^\/api\/empresas\/\d+\/cora(\/testar)?$/, mod: ['banco', 'empresas'] },
  { r: /^\/api\/empresas\/\d+\/conta-bancaria$/, mod: ['banco', 'empresas'] },
  { m: 'GET', r: /^\/api\/empresas\/\d+\/pix-config$/, mod: ['banco', 'empresas', 'cobrancas'] },
  { r: /^\/api\/empresas\/\d+\/pix-config$/, mod: ['banco', 'empresas'] },
  { r: /^\/api\/(empresas\/\d+\/(cobrancas|remessas|retorno|boleto-avulso)|cobrancas\/\d+\/(cancelar|pagar|reemitir|pix(\/gerar)?|qrcode|email|carta)|empresas\/\d+\/pix-gerar|empresas\/\d+\/(modelos-whatsapp|demonstrativo)|remessas\/\d+\/arquivo)$/, mod: ['cobrancas'] },
  { m: 'GET', r: /^\/api\/cobrancas\/\d+\/(boleto|demonstrativo)$/, mod: ['cobrancas', 'notas', 'emitir'] },
  { m: 'POST', r: /^\/api\/(notas|faturar)$/, mod: ['emitir'] },
  { m: 'GET', r: /^\/api\/relatorios$|^\/api\/empresas\/\d+\/relatorios\/[a-z-]+$/, mod: ['relatorios'] },
  { m: 'GET', r: /^\/api\/empresas\/\d+\/agenda$/, mod: ['emitir', 'painel'] },
  { r: /^\/api\/empresas\/\d+\/agenda(\/.*)?$/, mod: ['emitir'] },
  { m: 'POST', r: /^\/api\/empresas\/\d+\/notas\/importar-xml$/, mod: ['notas', 'emitir'] },
  { m: 'GET', r: /^\/api\/(notas|notas-lote)$|^\/api\/notas\/\d+(\/(danfse|xml|emails))?$/, mod: LER_NOTA },
  { m: 'DELETE', r: /^\/api\/notas\/\d+$/, mod: ['notas', 'emitir'] },
  { m: 'POST', r: /^\/api\/notas\/\d+\/(email|reenviar|reconciliar|cancelar)$/, mod: ['notas', 'emitir'] },
  { m: 'GET', r: /^\/api\/relatorios\//, mod: ['painel'] },
  { m: 'GET', r: /^\/api\/empresas\/\d+\/painel$/, mod: ['painel'] },
  { r: /^\/api\/empresas\/\d+\/(despesas(\/\d+)?|despesas-categorias)$/, mod: ['despesas'] },
  { r: /^\/api\/empresas\/\d+\/extrato(\/.*)?$/, mod: ['despesas'] },
  { r: /^\/api\/empresas\/\d+\/cartao(\/.*)?$/, mod: ['despesas'] },
  { m: 'GET', r: /^\/api\/empresas\/\d+\/tributacao\/tipos(\/\d+\/efetiva)?$/, mod: ['tributacao', 'servicos', 'compras', 'emitir'] },
  { r: /^\/api\/tributacao\/impostos(\/[A-Z_]+)?$|^\/api\/empresas\/\d+\/tributacao\/.*$/, mod: ['tributacao'] },
  { r: /^\/api\/empresas\/\d+\/compras(\/importar-xml|\/previa-xml|\/fornecedores|\/sefaz(\/(buscar|chave|importar|ocultar|ciencia|config|xml\/\d{44}|previa\/\d{44}))?)?$|^\/api\/compras\/\d+(\/xml|\/parcelas)?$/, mod: ['compras'] },
  { r: /^\/api\/sefaz\/conexao(\/(baixar-cadeia|cadeia))?$/, mod: 'adm' },
  { m: 'GET', r: /^\/api\/empresas\/\d+\/feriados$/, mod: ['banco', 'empresas', 'emitir'] },
  { r: /^\/api\/empresas\/\d+\/feriados$/, mod: ['banco', 'empresas'] },
];

/** null = permitido; senão a mensagem de recusa. */
export function recusaRota(u: Usuario, metodo: string, caminho: string): string | null {
  if (u.trocar_senha && !/^\/api\/me(\/senha)?$/.test(caminho)) return 'Defina uma nova senha para continuar.';
  const pago = recusaModuloPago(caminho); // módulo vendido à parte: nem o administrador usa sem contratar
  if (pago) return pago;
  const regra = REGRAS.find((x) => (!x.m || x.m === metodo) && x.r.test(caminho));
  if (!regra) return 'Sem permissão para esta ação.';
  if (regra.mod === 'livre') return null;
  if (u.tipo === 'adm') return null;
  if (regra.mod === 'adm') return 'Somente administradores podem acessar as Configurações.';
  const meus = modulosDoUsuario(u);
  // qualquer exclusão (DELETE) exige a permissão própria "excluir", além do acesso à funcionalidade
  if (metodo === 'DELETE' && !/\/logo$/.test(caminho) && !meus.includes('excluir')) return 'Seu usuário não tem permissão para excluir. Peça ao administrador (Configurações > Usuários e acessos).';
  return regra.mod.some((m) => meus.includes(m)) ? null : 'Seu usuário não tem acesso a esta funcionalidade.';
}

declare module 'fastify' {
  interface FastifyRequest {
    usuario?: Usuario;
  }
}

export function hashSenha(senha: string): string {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, sal, 64);
  return `scrypt$${sal.toString('base64')}$${h.toString('base64')}`;
}

export function conferirSenha(senha: string, armazenado: string): boolean {
  const [alg, salB64, hB64] = armazenado.split('$');
  if (alg !== 'scrypt' || !salB64 || !hB64) return false;
  const h = crypto.scryptSync(senha, Buffer.from(salB64, 'base64'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hB64, 'base64'));
}

const VALIDADE_TOKEN_S = 12 * 3600;

/** Token simples assinado com HMAC: base64url(payload).assinatura */
export function gerarToken(usuarioId: number, expiraEmMs?: number): string {
  const v = (db.prepare('SELECT sessao_v FROM usuarios WHERE id = ?').get(usuarioId) as { sessao_v: number } | undefined)?.sessao_v ?? 0;
  const padrao = Math.floor(Date.now() / 1000) + VALIDADE_TOKEN_S;
  const exp = expiraEmMs ? Math.min(padrao, Math.floor(expiraEmMs / 1000)) : padrao;
  const payload = Buffer.from(JSON.stringify({ u: usuarioId, v, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function lerToken(token: string): { u: number; v: number } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const esperado = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  const { u, v, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (exp < Date.now() / 1000) return null;
  return { u, v: v ?? 0 };
}

export async function exigirLogin(req: FastifyRequest, reply: FastifyReply) {
  const h = req.headers.authorization ?? '';
  const t = h.startsWith('Bearer ') ? lerToken(h.slice(7)) : null;
  const u = t ? (db.prepare('SELECT id, escritorio_id, nome, email, papel, login, tipo, permissoes, trocar_senha, mestre, sessao_v FROM usuarios WHERE id = ? AND ativo = 1').get(t.u) as Usuario | undefined) : undefined;
  if (!u || u.sessao_v !== t!.v) return reply.code(401).send({ erro: 'Sessão expirada. Entre novamente.' });
  const recusa = recusaRota(u, req.method, req.url.split('?')[0]);
  if (recusa) return reply.code(403).send({ erro: recusa });
  req.usuario = u;
}

export function exigirPapel(...papeis: Papel[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.usuario || !papeis.includes(req.usuario.papel)) return reply.code(403).send({ erro: 'Sem permissão para esta ação.' });
  };
}

/** Cliente (legado) e usuário normal com empresas marcadas só enxergam essas empresas; adm e normal sem marcação veem todas. */
export function restritoAEmpresas(u: Usuario): boolean {
  if (u.tipo === 'adm') return false;
  if (u.papel === 'cliente') return true;
  return !!db.prepare('SELECT 1 FROM usuario_empresas WHERE usuario_id = ?').get(u.id);
}

/**
 * Garante que o usuário pode operar a empresa: admin/operador veem todas do escritório;
 * cliente só as empresas vinculadas a ele.
 */
export function empresaPermitida(u: Usuario, empresaId: number): boolean {
  const e = db.prepare('SELECT escritorio_id FROM empresas WHERE id = ?').get(empresaId) as { escritorio_id: number } | undefined;
  if (!e || e.escritorio_id !== u.escritorio_id) return false;
  if (!restritoAEmpresas(u)) return true;
  return !!db.prepare('SELECT 1 FROM usuario_empresas WHERE usuario_id = ? AND empresa_id = ?').get(u.id, empresaId);
}

/** Cria o escritório e o administrador na primeira execução. */
export function garantirAdmin(): void {
  const existe = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get() as { n: number };
  if (existe.n > 0) return;
  // Sem ADMIN_SENHA o primeiro acesso é criado pela tela de boas-vindas (modo desktop).
  if (!config.adminSenha) return;
  if (config.adminSenha.length < 8) throw new Error('ADMIN_SENHA deve ter no mínimo 8 caracteres.');
  const esc = db.prepare('INSERT INTO escritorios (nome) VALUES (?)').run('Meu Escritório');
  db.prepare("INSERT INTO usuarios (escritorio_id, nome, email, login, senha_hash, papel, tipo) VALUES (?,?,?,?,?,?,'adm')")
    .run(esc.lastInsertRowid, 'Administrador', config.adminEmail.toLowerCase(), loginDoEmail(config.adminEmail), hashSenha(config.adminSenha), 'admin');
  console.log(`Usuário administrador criado: ${config.adminEmail}`);
}

/** Usuário de acesso a partir do começo do e-mail (para instalações antigas e para o primeiro acesso sem nome de usuário). */
export const loginDoEmail = (email: string) => email.split('@')[0].toUpperCase().replace(/[^A-Z0-9._-]/g, '');

/** O master não conta: ele só existe depois do primeiro acesso. */
export const sistemaConfigurado = () => (db.prepare('SELECT COUNT(*) AS n FROM usuarios WHERE mestre = 0').get() as { n: number }).n > 0;

/**
 * Usuário master do Kontor (suporte): administrador que ninguém mais pode alterar ou redefinir.
 * Não tem senha. Só entra com um código de suporte assinado pela chave privada do Kontor,
 * gerado para este computador e com validade curta (ver acessoDeSuporte em licenca.ts).
 * Instalações antigas tinham uma senha inicial fixa no código: ela é inutilizada aqui, a cada início.
 */
export function garantirMaster(): void {
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0, sessao_v = sessao_v + 1 WHERE mestre = 1 AND senha_hash <> ?').run(SEM_SENHA, SEM_SENHA);
  if (db.prepare('SELECT 1 FROM usuarios WHERE mestre = 1').get()) return;
  const esc = db.prepare('SELECT id FROM escritorios ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  if (!esc) return;
  if (db.prepare('SELECT 1 FROM usuarios WHERE login = ?').get(LOGIN_MESTRE)) return; // nome já usado por outro usuário
  db.prepare("INSERT INTO usuarios (escritorio_id, nome, email, login, senha_hash, papel, tipo, mestre) VALUES (?,?,?,?,?,?,'adm',1)")
    .run(esc.id, 'Kontor (master)', 'kontor@kontor.local', LOGIN_MESTRE, SEM_SENHA, 'admin');
}

/** Primeiro acesso: cria o escritório e o administrador. Só funciona enquanto não existe nenhum usuário. */
export function configurarPrimeiroAcesso(d: { escritorio: string; nome: string; email: string; senha: string; usuario?: string }) {
  const id = db.transaction(() => {
    if (sistemaConfigurado()) throw new Error('O sistema já foi configurado.');
    const login = (d.usuario?.trim() || loginDoEmail(d.email)).toUpperCase();
    if (login === LOGIN_MESTRE) throw new Error('Este nome de usuário é reservado.');
    const esc = db.prepare('SELECT id FROM escritorios ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    const escId = esc?.id ?? Number(db.prepare('INSERT INTO escritorios (nome) VALUES (?)').run(d.escritorio).lastInsertRowid);
    if (esc) db.prepare('UPDATE escritorios SET nome = ? WHERE id = ?').run(d.escritorio, esc.id);
    const u = db.prepare("INSERT INTO usuarios (escritorio_id, nome, email, login, senha_hash, papel, tipo) VALUES (?,?,?,?,?,?,'adm')")
      .run(escId, d.nome, d.email.toLowerCase(), login, hashSenha(d.senha), 'admin');
    return Number(u.lastInsertRowid);
  })();
  garantirMaster();
  return id;
}
