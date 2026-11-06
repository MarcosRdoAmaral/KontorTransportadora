import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { LOGIN_MESTRE, MODULOS, SENHA_PADRAO, conferirSenha, senhaProvisoria, empresaPermitida, hashSenha, modulosDoUsuario, type Usuario } from '../auth.js';
import { ErroNegocio } from './emissao.js';
import { enviarCodigoRecuperacao } from './email.js';

const SEM_EMAIL = '@sem-email.local';
const emailReal = (e: string) => (e.endsWith(SEM_EMAIL) || e.endsWith('@kontor.local') ? '' : e);

export const NovoUsuario = z.object({
  login: z.string().trim().min(3, 'O usuário precisa ter pelo menos 3 caracteres').max(30).transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z0-9._-]+$/.test(v), 'Use só letras, números, ponto, hífen ou sublinhado (sem espaços nem acentos)'),
  nome: z.string().trim().min(2, 'Informe o nome'),
  email: z.string().trim().email('E-mail inválido').or(z.literal('')).nullish(),
  /** Em branco = senha padrão, com troca obrigatória no primeiro acesso. */
  senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').or(z.literal('')).nullish(),
  tipo: z.enum(['adm', 'normal']),
  permissoes: z.array(z.string()).default([]),
  empresas: z.array(z.number()).default([]),
});

export const EdicaoUsuario = z.object({
  nome: z.string().trim().min(2, 'Informe o nome'),
  email: z.string().trim().email('E-mail inválido').or(z.literal('')).nullish(),
  tipo: z.enum(['adm', 'normal']),
  permissoes: z.array(z.string()).default([]),
  empresas: z.array(z.number()).default([]),
  ativo: z.boolean().default(true),
});

const modulosValidos = (l: string[]) => [...new Set(l)].filter((m) => m in MODULOS);

export function listarUsuarios(escritorioId: number) {
  const linhas = db.prepare(`SELECT id, login, nome, email, papel, tipo, permissoes, ativo, mestre, trocar_senha,
    (SELECT group_concat(empresa_id) FROM usuario_empresas ue WHERE ue.usuario_id = usuarios.id) AS empresas
    FROM usuarios WHERE escritorio_id = ? ORDER BY mestre DESC, nome`).all(escritorioId) as any[];
  return linhas.map((x) => ({ ...x, email: emailReal(x.email), modulos: modulosDoUsuario(x), permissoes: undefined }));
}

function vincularEmpresas(caller: Usuario, id: number, empresas: number[]) {
  db.prepare('DELETE FROM usuario_empresas WHERE usuario_id = ?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO usuario_empresas VALUES (?,?)');
  empresas.forEach((e) => empresaPermitida(caller, e) && ins.run(id, e));
}

export function criarUsuario(caller: Usuario, d: z.infer<typeof NovoUsuario>) {
  if (d.login === LOGIN_MESTRE) throw new ErroNegocio('Este nome de usuário é reservado.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE login = ?').get(d.login)) throw new ErroNegocio('Já existe um usuário com este nome. Escolha outro.', 409);
  const email = (d.email || '').toLowerCase() || `${d.login.toLowerCase()}${SEM_EMAIL}`;
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Este e-mail já está em uso por outro usuário.', 409);
  if (d.senha && d.senha === SENHA_PADRAO) throw new ErroNegocio('Escolha uma senha diferente da senha padrão das versões antigas.');
  // sem senha informada: provisória aleatória, mostrada uma vez ao administrador; a troca é obrigatória no primeiro acesso
  const provisoria = d.senha ? null : senhaProvisoria();
  const id = Number(db.prepare(`INSERT INTO usuarios (escritorio_id, nome, email, login, senha_hash, papel, tipo, permissoes, trocar_senha) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(caller.escritorio_id, d.nome, email, d.login, hashSenha(d.senha || provisoria!), d.tipo === 'adm' ? 'admin' : 'operador', d.tipo,
      d.tipo === 'adm' ? null : JSON.stringify(modulosValidos(d.permissoes)), provisoria ? 1 : 0).lastInsertRowid);
  vincularEmpresas(caller, id, d.empresas);
  return { id, senhaProvisoria: provisoria };
}

function alvo(caller: Usuario, id: number) {
  const a = db.prepare('SELECT * FROM usuarios WHERE id = ? AND escritorio_id = ?').get(id, caller.escritorio_id) as any;
  if (!a) throw new ErroNegocio('Usuário não encontrado.', 404);
  if (a.mestre && !caller.mestre) throw new ErroNegocio('O usuário master só pode ser alterado por ele mesmo.', 403);
  return a;
}

function ultimoAdm(id: number) {
  return !(db.prepare("SELECT 1 FROM usuarios WHERE tipo = 'adm' AND ativo = 1 AND mestre = 0 AND id <> ?").get(id));
}

export function editarUsuario(caller: Usuario, id: number, d: z.infer<typeof EdicaoUsuario>) {
  const a = alvo(caller, id);
  if (a.mestre) throw new ErroNegocio('O usuário master não pode ser editado.', 403);
  if ((d.tipo !== 'adm' || !d.ativo) && a.tipo === 'adm' && ultimoAdm(id)) throw new ErroNegocio('É preciso manter pelo menos um administrador ativo.');
  if (id === caller.id && !d.ativo) throw new ErroNegocio('Você não pode desativar o próprio usuário.');
  const email = (d.email || '').toLowerCase() || `${a.login.toLowerCase()}${SEM_EMAIL}`;
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ? AND id <> ?').get(email, id)) throw new ErroNegocio('Este e-mail já está em uso por outro usuário.', 409);
  // cliente (legado) continua sendo cliente: o perfil só muda entre adm e normal
  const papel = d.tipo === 'adm' ? 'admin' : a.papel === 'cliente' ? 'cliente' : 'operador';
  db.prepare('UPDATE usuarios SET nome = ?, email = ?, tipo = ?, papel = ?, permissoes = ?, ativo = ?, sessao_v = sessao_v + ? WHERE id = ?')
    .run(d.nome, email, d.tipo, papel, d.tipo === 'adm' ? null : JSON.stringify(modulosValidos(d.permissoes)), d.ativo ? 1 : 0, d.ativo && a.tipo === d.tipo ? 0 : 1, id);
  vincularEmpresas(caller, id, d.empresas);
}

/** Admin devolve ao usuário a senha padrão; ele é obrigado a trocá-la ao entrar. */
export function redefinirSenha(caller: Usuario, id: number) {
  const a = alvo(caller, id);
  if (a.mestre) throw new ErroNegocio('A senha do usuário master não pode ser redefinida por outra pessoa.', 403);
  const provisoria = senhaProvisoria();
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1, sessao_v = sessao_v + 1 WHERE id = ?').run(hashSenha(provisoria), id);
  return provisoria;
}

export function trocarMinhaSenha(u: Usuario, atual: string, nova: string) {
  if (u.mestre) throw new ErroNegocio('O acesso de suporte não tem senha: ele entra só com código de suporte.', 400);
  const r = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(u.id) as { senha_hash: string };
  if (!conferirSenha(atual, r.senha_hash)) throw new ErroNegocio('A senha atual está incorreta.', 400);
  if (nova.length < 8) throw new ErroNegocio('A nova senha precisa ter pelo menos 8 caracteres.');
  if (nova === SENHA_PADRAO) throw new ErroNegocio('Escolha uma senha diferente da senha padrão das versões antigas.');
  if (nova === atual) throw new ErroNegocio('A nova senha precisa ser diferente da atual.');
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0, sessao_v = sessao_v + 1 WHERE id = ?').run(hashSenha(nova), u.id);
}

// ---------- Esqueci minha senha ----------
const hashCodigo = (c: string) => crypto.createHash('sha256').update(c).digest('hex');
const VALIDADE_CODIGO_MS = 15 * 60e3;

/**
 * Envia um código ao e-mail cadastrado do usuário. A resposta é sempre a mesma, exista ou não o usuário,
 * para a tela de login não revelar quem tem acesso.
 */
export async function solicitarRecuperacao(login: string) {
  const a = db.prepare('SELECT id, escritorio_id, nome, email, mestre FROM usuarios WHERE (login = ? OR email = ?) AND ativo = 1')
    .get(login.trim().toUpperCase(), login.trim().toLowerCase()) as any;
  if (!a || a.mestre || !emailReal(a.email)) return;
  const agora = Date.now();
  const antigos = db.prepare('SELECT pedidos_em FROM recuperacao_senha WHERE usuario_id = ?').get(a.id) as { pedidos_em: string } | undefined;
  const pedidos = (JSON.parse(antigos?.pedidos_em ?? '[]') as number[]).filter((t) => agora - t < VALIDADE_CODIGO_MS);
  if (pedidos.length >= 3) return; // no máximo 3 e-mails a cada 15 minutos
  const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  pedidos.push(agora);
  db.prepare(`INSERT INTO recuperacao_senha (usuario_id, codigo_hash, expira_em, tentativas, pedidos_em) VALUES (?,?,?,0,?)
    ON CONFLICT(usuario_id) DO UPDATE SET codigo_hash = excluded.codigo_hash, expira_em = excluded.expira_em, tentativas = 0, pedidos_em = excluded.pedidos_em`)
    .run(a.id, hashCodigo(codigo), agora + VALIDADE_CODIGO_MS, JSON.stringify(pedidos));
  await enviarCodigoRecuperacao(a.escritorio_id, a.email, a.nome, codigo);
}

/** Código correto: o próprio usuário define a senha nova na mesma hora (nenhuma senha conhecida fica valendo no meio do caminho). */
export function confirmarRecuperacao(login: string, codigo: string, nova: string) {
  const a = db.prepare('SELECT id, mestre FROM usuarios WHERE (login = ? OR email = ?) AND ativo = 1').get(login.trim().toUpperCase(), login.trim().toLowerCase()) as any;
  const r = a && !a.mestre ? (db.prepare('SELECT * FROM recuperacao_senha WHERE usuario_id = ?').get(a.id) as any) : null;
  const invalido = () => new ErroNegocio('Código incorreto ou vencido. Peça um novo código.', 400);
  if (!r || r.expira_em < Date.now() || r.tentativas >= 5) throw invalido();
  const ok = crypto.timingSafeEqual(Buffer.from(hashCodigo(codigo.trim())), Buffer.from(r.codigo_hash));
  if (!ok) { db.prepare('UPDATE recuperacao_senha SET tentativas = tentativas + 1 WHERE usuario_id = ?').run(a.id); throw invalido(); }
  if (nova.length < 8) throw new ErroNegocio('A nova senha precisa ter pelo menos 8 caracteres.');
  if (nova === SENHA_PADRAO) throw new ErroNegocio('Escolha uma senha diferente da senha padrão das versões antigas.');
  db.prepare('UPDATE recuperacao_senha SET expira_em = 0 WHERE usuario_id = ?').run(a.id);
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0, sessao_v = sessao_v + 1 WHERE id = ?').run(hashSenha(nova), a.id);
}

// ---------- Tentativas de login ----------
const falhas = new Map<string, { n: number; ate: number }>();
export function loginBloqueado(login: string): boolean {
  const f = falhas.get(login);
  return !!f && f.n >= 5 && f.ate > Date.now();
}
export function registrarFalha(login: string) {
  const f = falhas.get(login);
  if (!f || f.ate < Date.now()) falhas.set(login, { n: 1, ate: Date.now() + 5 * 60e3 });
  else { f.n++; f.ate = Date.now() + 5 * 60e3; }
}
export const limparFalhas = (login: string) => falhas.delete(login);
export const _zerarFalhas = () => falhas.clear();
