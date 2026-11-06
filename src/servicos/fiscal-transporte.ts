import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { checarEmpresa } from './transporte.js';
import { soDigitos } from '../nfse/validacao.js';

/**
 * CT-e, MDF-e e GNRE da Transportadora.
 *
 * Nesta versão os documentos são montados e conferidos dentro do Kontor (rascunho). Número, chave e protocolo
 * só existem depois da transmissão à SEFAZ, que entra na próxima etapa (homologação com o certificado A1).
 * Por isso nenhum documento aqui é marcado como autorizado sem resposta da SEFAZ.
 */

const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const Data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida');
const Texto = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const Uf = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'UF inválida');
const Ibge = z.string().nullish().transform((v) => (v ? soDigitos(v) : null)).refine((v) => v === null || v.length === 7, 'Código IBGE deve ter 7 dígitos');

export const TRANSMISSAO_INDISPONIVEL = 'A transmissão à SEFAZ ainda não está disponível nesta versão. O documento fica como rascunho, conferido, até a liberação da emissão em homologação com o certificado A1.';

function doRegistro<T = any>(req: any, tabela: string, id: number): T {
  const r = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(id) as any;
  if (!r) throw new ErroNegocio('Documento não encontrado.', 404);
  checarEmpresa(req, r.empresa_id);
  return r;
}

// ------------------------------------------------------------------ CT-e

const SUL_SUDESTE = ['SP', 'RJ', 'MG', 'PR', 'SC', 'RS'];
/** Alíquota interestadual de ICMS sobre o frete: 7% de Sul/Sudeste para Norte, Nordeste, Centro-Oeste e ES; 12% nas demais. Dentro do estado, 12% como ponto de partida (ajustável). */
export function aliquotaSugerida(ufIni: string, ufFim: string) {
  if (ufIni !== ufFim && SUL_SUDESTE.includes(ufIni) && !SUL_SUDESTE.includes(ufFim)) return 7;
  return 12;
}

export const CSTS = ['00', '20', '40', '41', '51', '60', '90', 'SN'] as const;
const CteEdicao = z.object({
  cfop: z.string().regex(/^[56]3(5[1-9]|60)$/, 'CFOP de prestação de transporte: 5351 a 5360 ou 6351 a 6360'),
  tomador_papel: z.enum(['REMETENTE', 'DESTINATARIO', 'OUTROS']),
  valor_prestacao: z.number().min(0).max(100_000_000),
  cst_icms: z.enum(CSTS),
  aliquota_icms: z.number().min(0).max(30),
  produto: Texto(120),
  observacao: Texto(1000),
});

const SELECT_CTE = `SELECT c.*, e.nome AS tomador_nome, e.documento AS tomador_documento, v.numero AS viagem_numero, v.status AS viagem_status, ve.placa,
  CASE WHEN c.cst_icms IN ('00','20','90') THEN ROUND(c.valor_prestacao * c.aliquota_icms / 100, 2) ELSE 0 END AS valor_icms,
  (SELECT f.numero FROM fatura_ctes fc JOIN faturas_frete f ON f.id = fc.fatura_id WHERE fc.cte_id = c.id AND f.status <> 'CANCELADA') AS fatura_numero,
  (SELECT m.id FROM mdfe_ctes mc JOIN mdfes m ON m.id = mc.mdfe_id WHERE mc.cte_id = c.id AND m.status <> 'CANCELADO' LIMIT 1) AS mdfe_id
  FROM ctes c JOIN embarcadores e ON e.id = c.embarcador_id JOIN viagens v ON v.id = c.viagem_id LEFT JOIN veiculos ve ON ve.id = v.veiculo_id`;

/** O que falta para o CT-e poder ser transmitido. */
function pendenciasCte(c: any): string[] {
  if (c.status !== 'RASCUNHO') return [];
  const p: string[] = [];
  const emp = db.prepare('SELECT * FROM empresas WHERE id = ?').get(c.empresa_id) as any;
  if (!emp.cert_validade) p.push('A empresa não tem certificado A1 cadastrado.');
  else if (emp.cert_validade < hoje()) p.push('O certificado A1 da empresa está vencido.');
  const tom = db.prepare('SELECT * FROM embarcadores WHERE id = ?').get(c.embarcador_id) as any;
  if (!tom.cod_municipio || !tom.logradouro) p.push(`Endereço completo do tomador ${tom.nome} (logradouro e código IBGE).`);
  if (tom.ind_contribuinte === 1 && !tom.inscricao_estadual) p.push(`Inscrição estadual do tomador ${tom.nome}.`);
  if (!c.origem_ibge || !c.destino_ibge) p.push('Código IBGE da origem e do destino.');
  if (!c.valor_prestacao) p.push('Valor da prestação.');
  const nfes = db.prepare('SELECT COUNT(*) n, SUM(xml IS NULL) sem FROM viagem_nfes WHERE viagem_id = ?').get(c.viagem_id) as any;
  if (!nfes.n) p.push('A viagem não tem NF-e vinculada.');
  else if (nfes.sem) p.push(`${nfes.sem} NF-e da viagem só com a chave (importe o XML).`);
  if (!c.remetente_documento || !c.destinatario_documento) p.push('Remetente e destinatário (vêm do XML da NF-e).');
  return p;
}

function cteCompleto(id: number) {
  const c = db.prepare(`${SELECT_CTE} WHERE c.id = ?`).get(id) as any;
  const nfes = db.prepare('SELECT chave, numero, valor, peso_kg, (xml IS NOT NULL) AS completa FROM viagem_nfes WHERE viagem_id = ? ORDER BY id').all(c.viagem_id);
  return { ...c, nfes, pendencias: pendenciasCte(c) };
}

/** Monta o rascunho do CT-e com os dados da viagem: tomador, rota, carga, valor e ICMS sugerido. */
function criarCteDaViagem(viagemId: number) {
  const v = db.prepare('SELECT * FROM viagens WHERE id = ?').get(viagemId) as any;
  if (v.status === 'CANCELADA') throw new ErroNegocio('Viagem cancelada não gera CT-e.');
  const ja = db.prepare("SELECT id FROM ctes WHERE viagem_id = ? AND status <> 'CANCELADO'").get(viagemId) as any;
  if (ja) return ja.id as number;
  const emp = db.prepare('SELECT op_simp_nac FROM empresas WHERE id = ?').get(v.empresa_id) as any;
  const emb = db.prepare('SELECT documento FROM embarcadores WHERE id = ?').get(v.embarcador_id) as any;
  const n = db.prepare(`SELECT emitente_documento ed, emitente_nome en, destinatario_documento dd, destinatario_nome dn FROM viagem_nfes WHERE viagem_id = ? AND xml IS NOT NULL ORDER BY id LIMIT 1`).get(viagemId) as any;
  const tot = db.prepare('SELECT COALESCE(SUM(valor),0) valor, COALESCE(SUM(peso_kg),0) peso FROM viagem_nfes WHERE viagem_id = ?').get(viagemId) as any;
  const papel = n?.dd && n.dd === emb.documento ? 'DESTINATARIO' : n?.ed && n.ed !== emb.documento ? 'OUTROS' : 'REMETENTE';
  const simples = emp.op_simp_nac !== 1;
  const cfop = `${v.origem_uf === v.destino_uf ? '5' : '6'}353`;
  return Number(db.prepare(`INSERT INTO ctes (empresa_id, viagem_id, cfop, tomador_papel, embarcador_id, remetente_documento, remetente_nome, destinatario_documento, destinatario_nome,
      origem_cidade, origem_uf, origem_ibge, destino_cidade, destino_uf, destino_ibge, produto, valor_carga, peso_kg, valor_prestacao, cst_icms, aliquota_icms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.empresa_id, v.id, cfop, papel, v.embarcador_id, n?.ed ?? null, n?.en ?? null, n?.dd ?? null, n?.dn ?? null,
    v.origem_cidade, v.origem_uf, v.origem_ibge, v.destino_cidade, v.destino_uf, v.destino_ibge, v.produto, tot.valor, tot.peso, v.valor_frete,
    simples ? 'SN' : '00', simples ? 0 : aliquotaSugerida(v.origem_uf, v.destino_uf)).lastInsertRowid);
}

// ------------------------------------------------------------------ MDF-e

const MdfeEdicao = z.object({
  veiculo_id: z.number().int().positive().nullish().transform((v) => v ?? null),
  motorista_id: z.number().int().positive().nullish().transform((v) => v ?? null),
  uf_ini: Uf,
  uf_fim: Uf,
  percurso: z.string().nullish().transform((v) => (v ? v.toUpperCase().split(/[^A-Z]+/).filter(Boolean).join(',') : null))
    .refine((v) => v === null || v.split(',').every((u) => /^[A-Z]{2}$/.test(u)), 'Percurso: UFs separadas por vírgula'),
  carregamento_cidade: Texto(60), carregamento_ibge: Ibge,
  descarga_cidade: Texto(60), descarga_ibge: Ibge,
  ciot: z.string().nullish().transform((v) => (v ? soDigitos(v) : null)).refine((v) => v === null || v.length === 12, 'CIOT tem 12 dígitos'),
  observacao: Texto(1000),
  cte_ids: z.array(z.number().int().positive()).min(1, 'Inclua ao menos um CT-e'),
});

const SELECT_MDFE = `SELECT m.*, ve.placa, ve.vinculo, mo.nome AS motorista_nome,
  (SELECT COUNT(*) FROM mdfe_ctes x WHERE x.mdfe_id = m.id) AS qtd_ctes,
  (SELECT COALESCE(SUM(c.valor_carga),0) FROM mdfe_ctes x JOIN ctes c ON c.id = x.cte_id WHERE x.mdfe_id = m.id) AS valor_carga,
  (SELECT COALESCE(SUM(c.peso_kg),0) FROM mdfe_ctes x JOIN ctes c ON c.id = x.cte_id WHERE x.mdfe_id = m.id) AS peso_kg
  FROM mdfes m LEFT JOIN veiculos ve ON ve.id = m.veiculo_id LEFT JOIN motoristas mo ON mo.id = m.motorista_id`;

function pendenciasMdfe(m: any): string[] {
  if (m.status !== 'RASCUNHO') return [];
  const p: string[] = [];
  const emp = db.prepare('SELECT cert_validade FROM empresas WHERE id = ?').get(m.empresa_id) as any;
  if (!emp.cert_validade) p.push('A empresa não tem certificado A1 cadastrado.');
  if (!m.veiculo_id) p.push('Veículo de tração.');
  if (!m.motorista_id) p.push('Motorista (condutor).');
  if (!m.carregamento_ibge || !m.descarga_ibge) p.push('Código IBGE do município de carregamento e de descarga.');
  const ctes = db.prepare('SELECT c.status FROM mdfe_ctes x JOIN ctes c ON c.id = x.cte_id WHERE x.mdfe_id = ?').all(m.id) as any[];
  if (ctes.some((c) => c.status !== 'AUTORIZADO')) p.push('Todos os CT-e precisam estar autorizados pela SEFAZ antes do MDF-e.');
  if (m.veiculo_id) {
    const v = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(m.veiculo_id) as any;
    if (!v.renavam || !v.tara_kg || !v.uf_licenciamento || !v.tipo_rodado || !v.tipo_carroceria) p.push(`Veículo ${v.placa}: RENAVAM, tara, UF de licenciamento, tipo de rodado e de carroceria.`);
    if (v.vinculo !== 'PROPRIO') {
      const d = v.proprietario_id ? db.prepare('SELECT rntrc FROM transportadores WHERE id = ?').get(v.proprietario_id) as any : null;
      if (!d?.rntrc) p.push(`RNTRC do proprietário do veículo ${v.placa}.`);
      if (!m.ciot) p.push('CIOT (obrigatório na contratação de transportador autônomo ou agregado).');
    }
  }
  return p;
}

function mdfeCompleto(id: number) {
  const m = db.prepare(`${SELECT_MDFE} WHERE m.id = ?`).get(id) as any;
  const ctes = db.prepare(`SELECT c.id, c.status, c.numero, c.chave, c.valor_prestacao, c.valor_carga, c.peso_kg, c.destino_cidade, c.destino_uf, e.nome AS tomador_nome, v.numero AS viagem_numero
    FROM mdfe_ctes x JOIN ctes c ON c.id = x.cte_id JOIN embarcadores e ON e.id = c.embarcador_id JOIN viagens v ON v.id = c.viagem_id WHERE x.mdfe_id = ? ORDER BY c.id`).all(id);
  return { ...m, ctes, pendencias: pendenciasMdfe(m) };
}

function gravarMdfe(empresaId: number, d: z.infer<typeof MdfeEdicao>, mdfeId: number | null) {
  for (const cid of d.cte_ids) {
    const c = db.prepare('SELECT * FROM ctes WHERE id = ? AND empresa_id = ?').get(cid, empresaId) as any;
    if (!c || c.status === 'CANCELADO') throw new ErroNegocio('CT-e não encontrado ou cancelado.');
    const outro = db.prepare("SELECT m.id FROM mdfe_ctes x JOIN mdfes m ON m.id = x.mdfe_id WHERE x.cte_id = ? AND m.status IN ('RASCUNHO','AUTORIZADO') AND m.id <> ?").get(cid, mdfeId ?? 0);
    if (outro) throw new ErroNegocio('Um dos CT-e já está em outro MDF-e aberto.');
  }
  if (d.veiculo_id && !db.prepare('SELECT 1 FROM veiculos WHERE id = ? AND empresa_id = ?').get(d.veiculo_id, empresaId)) throw new ErroNegocio('Veículo não encontrado nesta empresa.');
  if (d.motorista_id && !db.prepare('SELECT 1 FROM motoristas WHERE id = ? AND empresa_id = ?').get(d.motorista_id, empresaId)) throw new ErroNegocio('Motorista não encontrado nesta empresa.');
  const { cte_ids, ...campos } = d;
  const cols = Object.keys(campos) as (keyof typeof campos)[];
  db.exec('BEGIN');
  try {
    if (mdfeId === null) {
      mdfeId = Number(db.prepare(`INSERT INTO mdfes (empresa_id, ${cols.join(', ')}) VALUES (?${', ?'.repeat(cols.length)})`).run(empresaId, ...cols.map((k) => campos[k] as any)).lastInsertRowid);
    } else {
      db.prepare(`UPDATE mdfes SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => campos[k] as any), mdfeId);
      db.prepare('DELETE FROM mdfe_ctes WHERE mdfe_id = ?').run(mdfeId);
    }
    for (const cid of cte_ids) db.prepare('INSERT INTO mdfe_ctes (mdfe_id, cte_id) VALUES (?, ?)').run(mdfeId, cid);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return mdfeId!;
}

// ------------------------------------------------------------------ GNRE

const Gnre = z.object({
  cte_id: z.number().int().positive().nullish().transform((v) => v ?? null),
  uf_favorecida: Uf,
  receita: z.string().regex(/^\d{6}$/, 'Código da receita com 6 dígitos').default('100013'),
  referencia: Texto(60),
  valor: z.number().positive('Informe o valor'),
  vencimento: Data,
  codigo_barras: z.string().nullish().transform((v) => (v ? soDigitos(v) : null)),
  observacao: Texto(500),
});

// ------------------------------------------------------------------ rotas

export function registrarFiscalTransporte(api: FastifyInstance) {
  // CT-e
  api.get('/api/empresas/:id/ctes', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const q = req.query as { status?: string; q?: string };
    const f = ['c.empresa_id = ?']; const a: unknown[] = [id];
    if (q.status && ['RASCUNHO', 'AUTORIZADO', 'CANCELADO'].includes(q.status)) { f.push('c.status = ?'); a.push(q.status); }
    const b = String(q.q ?? '').trim();
    if (b) { f.push('(e.nome LIKE ? OR CAST(v.numero AS TEXT) = ? OR CAST(c.numero AS TEXT) = ? OR c.destino_cidade LIKE ?)'); a.push(`%${b}%`, b, b, `%${b}%`); }
    return db.prepare(`${SELECT_CTE} WHERE ${f.join(' AND ')} ORDER BY c.id DESC LIMIT 500`).all(...a);
  });
  api.post('/api/viagens/:id/cte', async (req) => {
    const v = doRegistro(req, 'viagens', Number((req.params as any).id));
    return cteCompleto(criarCteDaViagem(v.id));
  });
  api.get('/api/ctes/:id', async (req) => cteCompleto(doRegistro(req, 'ctes', Number((req.params as any).id)).id));
  api.put('/api/ctes/:id', async (req) => {
    const c = doRegistro(req, 'ctes', Number((req.params as any).id));
    if (c.status !== 'RASCUNHO') throw new ErroNegocio('Só o rascunho pode ser alterado.');
    const d = CteEdicao.parse(req.body);
    if ((d.cfop[0] === '5') !== (c.origem_uf === c.destino_uf)) throw new ErroNegocio(c.origem_uf === c.destino_uf ? 'Prestação dentro do estado: use CFOP 53xx.' : 'Prestação interestadual: use CFOP 63xx.');
    if (['40', '41', '51', '60', 'SN'].includes(d.cst_icms)) d.aliquota_icms = 0;
    db.prepare('UPDATE ctes SET cfop=?, tomador_papel=?, valor_prestacao=?, cst_icms=?, aliquota_icms=?, produto=?, observacao=? WHERE id=?')
      .run(d.cfop, d.tomador_papel, d.valor_prestacao, d.cst_icms, d.aliquota_icms, d.produto, d.observacao, c.id);
    return cteCompleto(c.id);
  });
  api.post('/api/ctes/:id/transmitir', async (req) => {
    const c = doRegistro(req, 'ctes', Number((req.params as any).id));
    const p = pendenciasCte(c);
    if (p.length) throw new ErroNegocio(`Antes de transmitir: ${p.join(' ')}`);
    throw new ErroNegocio(TRANSMISSAO_INDISPONIVEL);
  });
  api.post('/api/ctes/:id/cancelar', async (req) => {
    const c = doRegistro(req, 'ctes', Number((req.params as any).id));
    if (c.status === 'AUTORIZADO') throw new ErroNegocio('CT-e autorizado é cancelado por evento na SEFAZ (disponível junto com a transmissão).');
    if (c.status === 'CANCELADO') return cteCompleto(c.id);
    if (db.prepare("SELECT 1 FROM fatura_ctes x JOIN faturas_frete f ON f.id = x.fatura_id WHERE x.cte_id = ? AND f.status <> 'CANCELADA'").get(c.id)) throw new ErroNegocio('Este CT-e está numa fatura. Cancele a fatura antes.');
    db.prepare("UPDATE ctes SET status = 'CANCELADO' WHERE id = ?").run(c.id);
    db.prepare("DELETE FROM mdfe_ctes WHERE cte_id = ? AND mdfe_id IN (SELECT id FROM mdfes WHERE status = 'RASCUNHO')").run(c.id);
    return cteCompleto(c.id);
  });

  // MDF-e
  api.get('/api/empresas/:id/mdfes', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const st = (req.query as any).status;
    const ok = ['RASCUNHO', 'AUTORIZADO', 'ENCERRADO', 'CANCELADO'].includes(st);
    return db.prepare(`${SELECT_MDFE} WHERE m.empresa_id = ?${ok ? ' AND m.status = ?' : ''} ORDER BY m.id DESC LIMIT 500`).all(...(ok ? [id, st] : [id]));
  });
  api.post('/api/viagens/:id/mdfe', async (req) => {
    const v = doRegistro(req, 'viagens', Number((req.params as any).id));
    const cteId = criarCteDaViagem(v.id);
    const aberto = db.prepare("SELECT m.id FROM mdfe_ctes x JOIN mdfes m ON m.id = x.mdfe_id WHERE x.cte_id = ? AND m.status IN ('RASCUNHO','AUTORIZADO')").get(cteId) as any;
    if (aberto) return mdfeCompleto(aberto.id);
    const ciot = db.prepare("SELECT numero FROM pagamentos_frete WHERE viagem_id = ? AND tipo = 'CIOT' ORDER BY id DESC LIMIT 1").get(v.id) as any;
    const id = gravarMdfe(v.empresa_id, MdfeEdicao.parse({
      veiculo_id: v.veiculo_id, motorista_id: v.motorista_id, uf_ini: v.origem_uf, uf_fim: v.destino_uf, percurso: null,
      carregamento_cidade: v.origem_cidade, carregamento_ibge: v.origem_ibge, descarga_cidade: v.destino_cidade, descarga_ibge: v.destino_ibge,
      ciot: ciot?.numero && soDigitos(ciot.numero).length === 12 ? ciot.numero : null, observacao: null, cte_ids: [cteId],
    }), null);
    return mdfeCompleto(id);
  });
  api.get('/api/mdfes/:id', async (req) => mdfeCompleto(doRegistro(req, 'mdfes', Number((req.params as any).id)).id));
  api.put('/api/mdfes/:id', async (req) => {
    const m = doRegistro(req, 'mdfes', Number((req.params as any).id));
    if (m.status !== 'RASCUNHO') throw new ErroNegocio('Só o rascunho pode ser alterado.');
    gravarMdfe(m.empresa_id, MdfeEdicao.parse(req.body), m.id);
    return mdfeCompleto(m.id);
  });
  api.post('/api/mdfes/:id/transmitir', async (req) => {
    const m = doRegistro(req, 'mdfes', Number((req.params as any).id));
    const p = pendenciasMdfe(m);
    if (p.length) throw new ErroNegocio(`Antes de transmitir: ${p.join(' ')}`);
    throw new ErroNegocio(TRANSMISSAO_INDISPONIVEL);
  });
  api.post('/api/mdfes/:id/encerrar', async (req) => {
    const m = doRegistro(req, 'mdfes', Number((req.params as any).id));
    if (m.status !== 'AUTORIZADO') throw new ErroNegocio('Só MDF-e autorizado pode ser encerrado.');
    const d = z.object({ uf: Uf, ibge: Ibge.refine((v) => v !== null, 'Informe o município de encerramento'), data: Data.default(hoje()) }).parse(req.body);
    throw new ErroNegocio(`${TRANSMISSAO_INDISPONIVEL} (encerramento em ${d.uf})`);
  });
  api.post('/api/mdfes/:id/cancelar', async (req) => {
    const m = doRegistro(req, 'mdfes', Number((req.params as any).id));
    if (m.status !== 'RASCUNHO') throw new ErroNegocio('MDF-e autorizado é cancelado ou encerrado por evento na SEFAZ.');
    db.prepare("UPDATE mdfes SET status = 'CANCELADO' WHERE id = ?").run(m.id);
    return mdfeCompleto(m.id);
  });

  // GNRE
  api.get('/api/empresas/:id/gnres', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    return db.prepare(`SELECT g.*, v.numero AS viagem_numero, c.destino_cidade FROM gnres g LEFT JOIN ctes c ON c.id = g.cte_id LEFT JOIN viagens v ON v.id = c.viagem_id
      WHERE g.empresa_id = ? ORDER BY g.status = 'A_PAGAR' DESC, g.vencimento LIMIT 500`).all(id);
  });
  const conferirGnre = (empresaId: number, d: z.infer<typeof Gnre>) => {
    if (d.cte_id && !db.prepare('SELECT 1 FROM ctes WHERE id = ? AND empresa_id = ?').get(d.cte_id, empresaId)) throw new ErroNegocio('CT-e não encontrado nesta empresa.');
  };
  api.post('/api/empresas/:id/gnres', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const d = Gnre.parse(req.body);
    conferirGnre(id, d);
    const r = db.prepare('INSERT INTO gnres (empresa_id, cte_id, uf_favorecida, receita, referencia, valor, vencimento, codigo_barras, observacao) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, d.cte_id, d.uf_favorecida, d.receita, d.referencia, d.valor, d.vencimento, d.codigo_barras, d.observacao);
    return { id: Number(r.lastInsertRowid) };
  });
  api.put('/api/gnres/:id', async (req) => {
    const g = doRegistro(req, 'gnres', Number((req.params as any).id));
    if (g.status !== 'A_PAGAR') throw new ErroNegocio('Guia paga ou cancelada não pode ser alterada.');
    const d = Gnre.parse(req.body);
    conferirGnre(g.empresa_id, d);
    db.prepare('UPDATE gnres SET cte_id=?, uf_favorecida=?, receita=?, referencia=?, valor=?, vencimento=?, codigo_barras=?, observacao=? WHERE id=?')
      .run(d.cte_id, d.uf_favorecida, d.receita, d.referencia, d.valor, d.vencimento, d.codigo_barras, d.observacao, g.id);
    return { ok: true };
  });
  api.post('/api/gnres/:id/pagar', async (req) => {
    const g = doRegistro(req, 'gnres', Number((req.params as any).id));
    if (g.status === 'CANCELADA') throw new ErroNegocio('Guia cancelada.');
    const { data } = z.object({ data: Data.nullish() }).parse(req.body ?? {});
    db.prepare("UPDATE gnres SET status = 'PAGA', pago_em = ? WHERE id = ?").run(data ?? hoje(), g.id);
    return { ok: true };
  });
  api.post('/api/gnres/:id/cancelar', async (req) => {
    const g = doRegistro(req, 'gnres', Number((req.params as any).id));
    if (g.status === 'PAGA') throw new ErroNegocio('Guia já paga.');
    db.prepare("UPDATE gnres SET status = 'CANCELADA' WHERE id = ?").run(g.id);
    return { ok: true };
  });
}
