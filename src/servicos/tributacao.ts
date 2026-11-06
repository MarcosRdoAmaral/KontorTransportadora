import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const TOLERANCIA = 0.05;

// ---------------------------------------------------------------------------
// Catálogo de impostos
// ---------------------------------------------------------------------------
export interface Imposto { codigo: string; nome: string; grupo: string; pode_reter: number; credita: number; ativo: number; ordem: number }
export const listarImpostos = () => db.prepare('SELECT * FROM impostos ORDER BY ordem').all() as Imposto[];

export const EdicaoImposto = z.object({ nome: z.string().trim().min(2).max(80), ativo: z.boolean() });
export function editarImposto(codigo: string, d: z.infer<typeof EdicaoImposto>) {
  if (!db.prepare('UPDATE impostos SET nome = ?, ativo = ? WHERE codigo = ?').run(d.nome, d.ativo ? 1 : 0, codigo).changes) throw new ErroNegocio('Imposto não encontrado.', 404);
}

// ---------------------------------------------------------------------------
// Perfis de tributação (conjunto de impostos, com vigência)
// ---------------------------------------------------------------------------
const Data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida').nullish().or(z.literal('').transform(() => null));
export const ItemPerfil = z.object({
  imposto_codigo: z.string().min(2),
  aliquota: z.number().min(0).max(100),
  reducao_base: z.number().min(0).max(100).default(0),
  retido: z.boolean().default(false),
  cst: z.string().regex(/^\d{3}$/, 'CST tem 3 dígitos').nullish().or(z.literal('').transform(() => null)),
  c_class_trib: z.string().regex(/^\d{6}$/, 'cClassTrib tem 6 dígitos').nullish().or(z.literal('').transform(() => null)),
  vigencia_ini: Data, vigencia_fim: Data,
}).refine((i) => !i.vigencia_ini || !i.vigencia_fim || i.vigencia_ini <= i.vigencia_fim, { message: 'A vigência inicial é maior que a final', path: ['vigencia_fim'] });
const Pct = z.number().min(0).max(100).nullish();
export const Perfil = z.object({
  nome: z.string().trim().min(2, 'Informe o nome do perfil').max(80),
  descricao: z.string().trim().max(300).nullish(),
  // dados da DPS que acompanham o perfil
  trib_issqn: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
  tp_imunidade: z.number().int().min(0).max(9).nullish(),
  p_tot_fed: Pct, p_tot_est: Pct, p_tot_mun: Pct,
  municipio_prestacao: z.string().regex(/^\d{7}$/, 'Município da prestação: código IBGE de 7 dígitos').nullish().or(z.literal('').transform(() => null)),
  info_complementar: z.string().max(2000).nullish(),
  itens: z.array(ItemPerfil).max(40).default([]),
});
const colunasPerfil = (d: z.infer<typeof Perfil>) => [d.nome, d.descricao ?? null, d.trib_issqn ?? 1, d.trib_issqn === 2 ? d.tp_imunidade ?? null : null, d.p_tot_fed ?? null, d.p_tot_est ?? null, d.p_tot_mun ?? null, d.municipio_prestacao || null, d.info_complementar || null];

function conferirImpostos(itens: z.infer<typeof ItemPerfil>[]) {
  const validos = new Set(listarImpostos().map((i) => i.codigo));
  for (const i of itens) if (!validos.has(i.imposto_codigo)) throw new ErroNegocio(`Imposto desconhecido: ${i.imposto_codigo}.`);
}
function gravarItens(perfilId: number, itens: z.infer<typeof ItemPerfil>[]) {
  conferirImpostos(itens);
  db.prepare('DELETE FROM perfil_itens WHERE perfil_id = ?').run(perfilId);
  const ins = db.prepare('INSERT INTO perfil_itens (perfil_id, imposto_codigo, aliquota, reducao_base, retido, cst, c_class_trib, vigencia_ini, vigencia_fim) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const i of itens) ins.run(perfilId, i.imposto_codigo, i.aliquota, i.reducao_base, i.retido ? 1 : 0, i.cst ?? null, i.c_class_trib ?? null, i.vigencia_ini || null, i.vigencia_fim || null);
}

export function listarPerfis(empresaId: number) {
  const perfis = db.prepare('SELECT id, nome, descricao, trib_issqn, tp_imunidade, p_tot_fed, p_tot_est, p_tot_mun, municipio_prestacao, info_complementar FROM perfis_tributacao WHERE empresa_id = ? AND ativo = 1 ORDER BY nome').all(empresaId) as any[];
  const itens = db.prepare('SELECT * FROM perfil_itens WHERE perfil_id = ? ORDER BY imposto_codigo, vigencia_ini');
  return perfis.map((p) => ({ ...p, itens: (itens.all(p.id) as any[]).map((i) => ({ ...i, retido: !!i.retido })),
    usos: (db.prepare('SELECT COUNT(*) AS n FROM tipos_documento WHERE perfil_id = ? AND ativo = 1').get(p.id) as any).n }));
}
export function criarPerfil(empresaId: number, d: z.infer<typeof Perfil>) {
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO perfis_tributacao (empresa_id, nome, descricao, trib_issqn, tp_imunidade, p_tot_fed, p_tot_est, p_tot_mun, municipio_prestacao, info_complementar) VALUES (?,?,?,?,?,?,?,?,?,?)').run(empresaId, ...colunasPerfil(d)).lastInsertRowid);
    gravarItens(id, d.itens);
    return { id };
  })();
}
export function editarPerfil(empresaId: number, id: number, d: z.infer<typeof Perfil>) {
  db.transaction(() => {
    if (!db.prepare('UPDATE perfis_tributacao SET nome = ?, descricao = ?, trib_issqn = ?, tp_imunidade = ?, p_tot_fed = ?, p_tot_est = ?, p_tot_mun = ?, municipio_prestacao = ?, info_complementar = ? WHERE id = ? AND empresa_id = ? AND ativo = 1').run(...colunasPerfil(d), id, empresaId).changes) throw new ErroNegocio('Perfil não encontrado.', 404);
    gravarItens(id, d.itens);
  })();
}
export function excluirPerfil(empresaId: number, id: number) {
  const usos = (db.prepare('SELECT COUNT(*) AS n FROM tipos_documento WHERE perfil_id = ? AND ativo = 1').get(id) as any).n;
  if (usos) throw new ErroNegocio(`Este perfil é usado por ${usos} tipo(s) de documento. Troque o perfil deles antes de excluir.`);
  if (!db.prepare('UPDATE perfis_tributacao SET ativo = 0 WHERE id = ? AND empresa_id = ?').run(id, empresaId).changes) throw new ErroNegocio('Perfil não encontrado.', 404);
}

/** Itens do perfil que valem na data (vigência em branco = sem limite). */
export function itensVigentes(perfilId: number, data: string) {
  return (db.prepare(`SELECT pi.*, i.pode_reter, i.credita FROM perfil_itens pi JOIN impostos i ON i.codigo = pi.imposto_codigo
    WHERE pi.perfil_id = ? AND i.ativo = 1 AND (pi.vigencia_ini IS NULL OR pi.vigencia_ini <= ?) AND (pi.vigencia_fim IS NULL OR pi.vigencia_fim >= ?)`).all(perfilId, data, data) as any[]);
}

/** valor = base × (1 − redução) × alíquota. Vários itens do mesmo imposto na mesma data: vale o de vigência mais recente. */
export function calcularPerfil(perfilId: number, base: number, data: string) {
  const porImposto = new Map<string, any>();
  for (const it of itensVigentes(perfilId, data)) {
    const atual = porImposto.get(it.imposto_codigo);
    if (!atual || (it.vigencia_ini ?? '') >= (atual.vigencia_ini ?? '')) porImposto.set(it.imposto_codigo, it);
  }
  return [...porImposto.values()].map((it) => {
    const b = r2(base * (1 - it.reducao_base / 100));
    return { imposto: it.imposto_codigo as string, base: b, aliquota: it.aliquota as number, valor: r2(b * it.aliquota / 100), retido: !!it.retido };
  });
}

// ---------------------------------------------------------------------------
// Tipos de documento / operação
// ---------------------------------------------------------------------------
export const NATUREZAS = ['Serviço', 'Mercadoria para revenda', 'Insumo', 'Uso e consumo', 'Ativo imobilizado', 'Devolução', 'Outra'] as const;
export const TipoDocumento = z.object({
  nome: z.string().trim().min(2, 'Informe o nome do tipo').max(80),
  sentido: z.enum(['SAIDA', 'ENTRADA']),
  modelo: z.enum(['NFSE', 'NFE', 'MANUAL']),
  natureza: z.string().trim().max(60).nullish(),
  perfil_id: z.number().int().nullish(),
  c_trib_nac: z.string().trim().max(6).nullish(),
  cfop: z.string().trim().max(4).nullish(),
  ind_op: z.string().trim().max(6).nullish(),
  ind_final: z.union([z.literal(0), z.literal(1)]).default(0),
  ind_dest: z.union([z.literal(0), z.literal(1)]).default(0),
  gera_credito: z.boolean().default(false),
  destino: z.enum(['RECEITA', 'DESPESA', 'NENHUM']).default('NENHUM'),
  padrao: z.boolean().default(false),
});
function conferirTipo(empresaId: number, d: z.infer<typeof TipoDocumento>) {
  if (d.perfil_id && !db.prepare('SELECT 1 FROM perfis_tributacao WHERE id = ? AND empresa_id = ? AND ativo = 1').get(d.perfil_id, empresaId)) throw new ErroNegocio('Perfil de tributação inválido.');
  if (d.sentido === 'SAIDA' && d.modelo === 'NFE') throw new ErroNegocio('NF-e de mercadorias é só de entrada (compras); para saída use NFS-e.');
}
function exclusivoPadrao(empresaId: number, id: number, d: z.infer<typeof TipoDocumento>) {
  if (d.padrao) db.prepare('UPDATE tipos_documento SET padrao = 0 WHERE empresa_id = ? AND sentido = ? AND id <> ?').run(empresaId, d.sentido, id);
}
export const listarTipos = (empresaId: number) =>
  (db.prepare(`SELECT t.*, p.nome AS perfil_nome,
      (SELECT COUNT(*) FROM servicos s WHERE s.tipo_documento_id = t.id AND s.ativo = 1) + (SELECT COUNT(*) FROM compras c WHERE c.tipo_documento_id = t.id) AS usos
    FROM tipos_documento t LEFT JOIN perfis_tributacao p ON p.id = t.perfil_id WHERE t.empresa_id = ? AND t.ativo = 1 ORDER BY t.sentido DESC, t.nome`).all(empresaId) as any[])
    .map((t) => ({ ...t, gera_credito: !!t.gera_credito, padrao: !!t.padrao }));
export function criarTipo(empresaId: number, d: z.infer<typeof TipoDocumento>) {
  conferirTipo(empresaId, d);
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO tipos_documento (empresa_id, nome, sentido, modelo, natureza, perfil_id, c_trib_nac, cfop, ind_op, ind_final, ind_dest, gera_credito, destino, padrao)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(empresaId, d.nome, d.sentido, d.modelo, d.natureza ?? null, d.perfil_id ?? null, d.c_trib_nac || null, d.cfop || null, d.ind_op || null, d.ind_final ?? 0, d.ind_dest ?? 0, d.gera_credito ? 1 : 0, d.destino, d.padrao ? 1 : 0).lastInsertRowid);
    exclusivoPadrao(empresaId, id, d);
    return { id };
  })();
}
export function editarTipo(empresaId: number, id: number, d: z.infer<typeof TipoDocumento>) {
  conferirTipo(empresaId, d);
  db.transaction(() => {
    if (!db.prepare(`UPDATE tipos_documento SET nome=?, sentido=?, modelo=?, natureza=?, perfil_id=?, c_trib_nac=?, cfop=?, ind_op=?, ind_final=?, ind_dest=?, gera_credito=?, destino=?, padrao=? WHERE id=? AND empresa_id=? AND ativo=1`)
      .run(d.nome, d.sentido, d.modelo, d.natureza ?? null, d.perfil_id ?? null, d.c_trib_nac || null, d.cfop || null, d.ind_op || null, d.ind_final ?? 0, d.ind_dest ?? 0, d.gera_credito ? 1 : 0, d.destino, d.padrao ? 1 : 0, id, empresaId).changes) throw new ErroNegocio('Tipo de documento não encontrado.', 404);
    exclusivoPadrao(empresaId, id, d);
  })();
}
export function excluirTipo(empresaId: number, id: number) {
  const usos = (db.prepare('SELECT (SELECT COUNT(*) FROM servicos WHERE tipo_documento_id = ? AND ativo = 1) + (SELECT COUNT(*) FROM compras WHERE tipo_documento_id = ?) AS n').get(id, id) as any).n;
  if (usos) throw new ErroNegocio(`Este tipo está vinculado a ${usos} serviço(s)/compra(s). Troque o vínculo antes de excluir.`);
  if (!db.prepare('UPDATE tipos_documento SET ativo = 0, padrao = 0 WHERE id = ? AND empresa_id = ?').run(id, empresaId).changes) throw new ErroNegocio('Tipo de documento não encontrado.', 404);
}

/** Tipo de documento padrão da empresa para um sentido (usado quando o serviço/compra não aponta nenhum). */
export const tipoPadrao = (empresaId: number, sentido: 'SAIDA' | 'ENTRADA') =>
  db.prepare('SELECT * FROM tipos_documento WHERE empresa_id = ? AND sentido = ? AND padrao = 1 AND ativo = 1').get(empresaId, sentido) as any | undefined;

export function conferirTipoDoVinculo(empresaId: number, tipoId: number | null | undefined, sentido: 'SAIDA' | 'ENTRADA') {
  if (!tipoId) return null;
  const t = db.prepare('SELECT sentido FROM tipos_documento WHERE id = ? AND empresa_id = ? AND ativo = 1').get(tipoId, empresaId) as any;
  if (!t) throw new ErroNegocio('Tipo de documento inválido.');
  if (t.sentido !== sentido) throw new ErroNegocio(`Este vínculo precisa de um tipo de ${sentido === 'SAIDA' ? 'saída' : 'entrada'}.`);
  return tipoId;
}

/**
 * Tributação efetiva de um tipo de documento numa data: tudo o que a DPS precisa vir do perfil
 * (ISSQN, alíquota, retenções, imunidade, totais aproximados, município, informações e o grupo IBS/CBS).
 */
export function tributacaoEfetiva(tipoId: number, data = hojeBr()) {
  const t = db.prepare('SELECT * FROM tipos_documento WHERE id = ? AND ativo = 1').get(tipoId) as any;
  if (!t) return null;
  const p = t.perfil_id ? (db.prepare('SELECT * FROM perfis_tributacao WHERE id = ? AND ativo = 1').get(t.perfil_id) as any) : null;
  const it = p ? itensVigentes(p.id, data) : [];
  const item = (cod: string) => it.filter((x) => x.imposto_codigo === cod).sort((a, b) => (b.vigencia_ini ?? '').localeCompare(a.vigencia_ini ?? ''))[0];
  const ret = (cod: string) => { const x = item(cod); return x?.retido ? x.aliquota : null; };
  const iss = item('ISS');
  const ibsItem = ['CBS', 'IBS_UF', 'IBS_MUN'].map(item).find((x) => x?.cst && x?.c_class_trib);
  const temTot = p && (p.p_tot_fed != null || p.p_tot_est != null || p.p_tot_mun != null);
  return {
    itens: [...new Set(it.map((x: any) => x.imposto_codigo as string))].map((c) => { const x = item(c); return { imposto: c, aliquota: x.aliquota as number, reducao_base: x.reducao_base as number, retido: !!x.retido }; }),
    tipoId: t.id as number, tipoNome: t.nome as string, cTribNac: (t.c_trib_nac as string | null) ?? null, temPerfil: !!p,
    aliquota: (iss?.aliquota as number | undefined) ?? null,
    tribISSQN: (p?.trib_issqn ?? 1) as 1 | 2 | 3 | 4,
    tpImunidade: (p?.trib_issqn === 2 ? p?.tp_imunidade : null) as number | null,
    issRetido: (iss?.retido ? 2 : 1) as 1 | 2,
    pPis: ret('PIS'), pCofins: ret('COFINS'), pCsll: ret('CSLL'), pIrrf: ret('IRRF'), pCp: ret('INSS'),
    pTotTrib: temTot ? { fed: p.p_tot_fed, est: p.p_tot_est, mun: p.p_tot_mun } : null,
    municipioPrestacao: (p?.municipio_prestacao as string | null) ?? null,
    infoComplementar: (p?.info_complementar as string | null) ?? null,
    ibscbs: ibsItem && t.ind_op ? { indFinal: t.ind_final as 0 | 1, cIndOp: String(t.ind_op), indDest: t.ind_dest as 0 | 1, cst: ibsItem.cst as string, cClassTrib: ibsItem.c_class_trib as string } : null,
  };
}

/** Tipo de documento que vale para um serviço (o dele, ou o padrão de saída da empresa). */
export function tipoDoServico(servicoId: number | null | undefined, empresaId: number): number | null {
  const sv = servicoId ? (db.prepare('SELECT tipo_documento_id FROM servicos WHERE id = ?').get(servicoId) as any) : null;
  return sv?.tipo_documento_id ?? tipoPadrao(empresaId, 'SAIDA')?.id ?? null;
}

/**
 * Tributação completa de um serviço no formato que a emissão e as telas já usam:
 * o que vem do tipo/perfil prevalece sobre o que ficou gravado no próprio serviço (cadastros antigos).
 */
export function tributacaoCompletaDoServico(sv: any, data = hojeBr()) {
  const antiga = sv.tributacao_json ? JSON.parse(sv.tributacao_json) : null;
  const ef = sv.tipo_documento_id ? tributacaoEfetiva(sv.tipo_documento_id, data) : null;
  if (!ef?.temPerfil) return { tributacao: antiga, aliquota: sv.aliquota ?? null, ibscbs: sv.ibscbs_json ? JSON.parse(sv.ibscbs_json) : null, tipo: ef };
  return {
    tributacao: { tribISSQN: ef.tribISSQN, issRetido: ef.issRetido, tpImunidade: ef.tpImunidade, pPis: ef.pPis, pCofins: ef.pCofins, pCsll: ef.pCsll, pIrrf: ef.pIrrf, pCp: ef.pCp,
      pTotTrib: ef.pTotTrib, municipioPrestacao: ef.municipioPrestacao, infoComplementar: ef.infoComplementar },
    aliquota: ef.aliquota ?? sv.aliquota ?? null,
    ibscbs: ef.ibscbs ?? (sv.ibscbs_json ? JSON.parse(sv.ibscbs_json) : null),
    tipo: ef,
  };
}

/**
 * Cria perfis e tipos a partir da tributação que estava gravada dentro de cada serviço (alíquota do ISS, retenções,
 * ISSQN, imunidade, totais aproximados, município, informações e grupo IBS/CBS) e vincula o serviço ao tipo. Idempotente.
 */
export function gerarPerfisDosServicos(empresaId: number) {
  const servs = db.prepare('SELECT id, aliquota, tributacao_json, ibscbs_json FROM servicos WHERE empresa_id = ? AND ativo = 1 AND tipo_documento_id IS NULL').all(empresaId) as any[];
  let criados = 0;
  const cache = new Map<string, number>(); // cada perfil/tipo é gravado em sua própria transação; refazer é seguro
  for (const sv of servs) {
    const t = sv.tributacao_json ? JSON.parse(sv.tributacao_json) : {};
    const ib = sv.ibscbs_json ? JSON.parse(sv.ibscbs_json) : null;
    const itens: z.infer<typeof ItemPerfil>[] = [];
    const add = (cod: string, aliq: any, retido: boolean, extra: Partial<z.infer<typeof ItemPerfil>> = {}) => {
      if (aliq != null && Number(aliq) >= 0 && (Number(aliq) > 0 || extra.cst)) itens.push({ imposto_codigo: cod, aliquota: Number(aliq), reducao_base: 0, retido, cst: null, c_class_trib: null, vigencia_ini: null, vigencia_fim: null, ...extra });
    };
    add('ISS', sv.aliquota, t.issRetido === 2 || t.issRetido === 3);
    add('PIS', t.pPis, true); add('COFINS', t.pCofins, true); add('CSLL', t.pCsll, true); add('IRRF', t.pIrrf, true); add('INSS', t.pCp, true);
    if (ib) for (const cod of ['IBS_UF', 'IBS_MUN', 'CBS']) add(cod, 0, false, { cst: ib.cst, c_class_trib: ib.cClassTrib });
    const cab = { trib_issqn: (t.tribISSQN ?? 1) as 1 | 2 | 3 | 4, tp_imunidade: t.tpImunidade ?? null, p_tot_fed: t.pTotTrib?.fed ?? null, p_tot_est: t.pTotTrib?.est ?? null, p_tot_mun: t.pTotTrib?.mun ?? null,
      municipio_prestacao: t.municipioPrestacao || null, info_complementar: t.infoComplementar || null };
    const vazio = !itens.length && cab.trib_issqn === 1 && !cab.p_tot_fed && !cab.p_tot_est && !cab.p_tot_mun && !cab.municipio_prestacao && !cab.info_complementar;
    if (vazio) continue;
    const chave = JSON.stringify([itens, cab, ib]);
    let tipoId = cache.get(chave);
    if (!tipoId) {
      const partes = [...new Set(itens.map((i) => i.imposto_codigo + (i.retido ? ' ret.' : '')))];
      const nome = `Serviço — ${partes.length ? partes.join(', ') : 'tributação padrão'}${cab.trib_issqn !== 1 ? ` (ISSQN ${cab.trib_issqn})` : ''}`.slice(0, 80);
      const perfil = criarPerfil(empresaId, { nome, descricao: 'Criado a partir da tributação que estava cadastrada nos serviços.', ...cab, itens });
      tipoId = criarTipo(empresaId, { nome, sentido: 'SAIDA', modelo: 'NFSE', natureza: 'Serviço', perfil_id: perfil.id, ind_op: ib?.cIndOp ?? null, ind_final: ib?.indFinal ?? 0, ind_dest: ib?.indDest ?? 0, gera_credito: false, destino: 'RECEITA', padrao: false }).id;
      cache.set(chave, tipoId); criados++;
    }
    db.prepare('UPDATE servicos SET tipo_documento_id = ? WHERE id = ?').run(tipoId, sv.id);
  }
  return { servicos: servs.length, perfisCriados: criados };
}

/** Na inicialização: converte a tributação antiga dos serviços de todas as empresas (só mexe no que ainda não tem tipo). */
export function migrarServicosLegados() {
  try {
    for (const e of db.prepare('SELECT DISTINCT empresa_id FROM servicos WHERE ativo = 1 AND tipo_documento_id IS NULL AND (tributacao_json IS NOT NULL OR ibscbs_json IS NOT NULL)').all() as { empresa_id: number }[]) gerarPerfisDosServicos(e.empresa_id);
  } catch (err) { console.error('Conversão da tributação dos serviços:', err); }
}

// ---------------------------------------------------------------------------
// "Tributação" = perfil + o tipo de documento que o acompanha (1:1, mantido automaticamente).
// Serviços, compras e a emissão só enxergam a tributação; o tipo é detalhe interno.
// ---------------------------------------------------------------------------
export const Tributacao = Perfil.extend({
  sentido: z.enum(['SAIDA', 'ENTRADA']).default('SAIDA'),
  natureza: z.string().trim().max(60).nullish(),
  /** código de tributação nacional (saída) ou CFOP (entrada) padrão */
  codigo: z.string().trim().max(6).nullish(),
  ind_op: z.string().trim().max(6).nullish(),
  ind_final: z.union([z.literal(0), z.literal(1)]).default(0),
  ind_dest: z.union([z.literal(0), z.literal(1)]).default(0),
  gera_credito: z.boolean().default(false),
  destino: z.enum(['RECEITA', 'DESPESA', 'NENHUM']).nullish(),
  padrao: z.boolean().default(false),
});
type EntradaTributacao = z.infer<typeof Tributacao>;

function tipoDoPerfil(perfilId: number) {
  return db.prepare('SELECT id FROM tipos_documento WHERE perfil_id = ? AND ativo = 1 ORDER BY id LIMIT 1').get(perfilId) as { id: number } | undefined;
}
function dadosTipo(perfilId: number, d: EntradaTributacao) {
  const entrada = d.sentido === 'ENTRADA';
  return TipoDocumento.parse({
    nome: d.nome, sentido: d.sentido, modelo: entrada ? 'NFE' : 'NFSE', natureza: d.natureza || null, perfil_id: perfilId,
    c_trib_nac: entrada ? null : d.codigo || null, cfop: entrada ? d.codigo || null : null, ind_op: d.ind_op || null,
    ind_final: d.ind_final ?? 0, ind_dest: d.ind_dest ?? 0, gera_credito: !!d.gera_credito, destino: d.destino ?? (entrada ? 'DESPESA' : 'RECEITA'), padrao: !!d.padrao,
  });
}
function sincronizarTipo(empresaId: number, perfilId: number, d: EntradaTributacao) {
  const t = tipoDoPerfil(perfilId);
  const dados = dadosTipo(perfilId, d);
  if (t) editarTipo(empresaId, t.id, dados); else criarTipo(empresaId, dados);
}

export function listarTributacoes(empresaId: number) {
  return listarPerfis(empresaId).map((p: any) => {
    const t = tipoDoPerfil(p.id);
    const tipo = t ? (db.prepare('SELECT * FROM tipos_documento WHERE id = ?').get(t.id) as any) : null;
    const usos = t ? (db.prepare('SELECT (SELECT COUNT(*) FROM servicos s WHERE s.tipo_documento_id = ? AND s.ativo = 1) + (SELECT COUNT(*) FROM compras c WHERE c.tipo_documento_id = ?) AS n').get(t.id, t.id) as any).n : 0;
    return { ...p, tipo_id: tipo?.id ?? null, sentido: tipo?.sentido ?? 'SAIDA', natureza: tipo?.natureza ?? null,
      codigo: tipo ? (tipo.sentido === 'ENTRADA' ? tipo.cfop : tipo.c_trib_nac) ?? null : null, ind_op: tipo?.ind_op ?? null, ind_final: tipo?.ind_final ?? 0, ind_dest: tipo?.ind_dest ?? 0,
      gera_credito: !!tipo?.gera_credito, destino: tipo?.destino ?? 'RECEITA', padrao: !!tipo?.padrao, usos };
  });
}
export function criarTributacao(empresaId: number, d: EntradaTributacao) {
  const { id } = criarPerfil(empresaId, d);
  sincronizarTipo(empresaId, id, d);
  return { id, tipo_id: tipoDoPerfil(id)?.id ?? null };
}
export function editarTributacao(empresaId: number, id: number, d: EntradaTributacao) {
  editarPerfil(empresaId, id, d);
  sincronizarTipo(empresaId, id, d);
}
export function excluirTributacao(empresaId: number, id: number) {
  const t = tipoDoPerfil(id);
  if (t) excluirTipo(empresaId, t.id); // recusa se algum serviço/compra ainda usa
  excluirPerfilSemTipos(empresaId, id);
}
function excluirPerfilSemTipos(empresaId: number, id: number) {
  if (!db.prepare('UPDATE perfis_tributacao SET ativo = 0 WHERE id = ? AND empresa_id = ?').run(id, empresaId).changes) throw new ErroNegocio('Tributação não encontrada.', 404);
}

/** Perfis antigos sem tipo ganham um (para poderem ser vinculados a serviços e compras). */
export function garantirTiposDosPerfis() {
  for (const p of db.prepare('SELECT id, empresa_id, nome FROM perfis_tributacao WHERE ativo = 1').all() as any[]) {
    if (tipoDoPerfil(p.id)) continue;
    criarTipo(p.empresa_id, TipoDocumento.parse({ nome: p.nome, sentido: 'SAIDA', modelo: 'NFSE', perfil_id: p.id, destino: 'RECEITA' }));
  }
}
