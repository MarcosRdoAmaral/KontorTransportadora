import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { lerNfe, type NfeLida } from '../nfe/leitura.js';
import { checarEmpresa, usuarioDe } from './transporte.js';
import { soDigitos } from '../nfse/validacao.js';

/**
 * Viagens da Transportadora: a carga de um embarcador entre origem e destino, com veículo, motorista,
 * frete cobrado e as NF-e transportadas. É a base do CT-e e do MDF-e (próximas etapas).
 *
 * Margem prevista = frete cobrado − frete pago ao terceiro (agregado/autônomo) − custo estimado (combustível, pedágio, diárias).
 */

export const STATUS = ['AGUARDANDO_COLETA', 'EM_TRANSITO', 'ENTREGUE', 'CANCELADA'] as const;
type Status = (typeof STATUS)[number];

const LIMITE_XML = 20 * 1024 * 1024; // vários XML de NF-e numa requisição só

const Data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida').nullish().or(z.literal('')).transform((v) => v || null);
const Texto = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const Uf = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'UF inválida');
const Ibge = z.string().nullish().transform((v) => (v ? soDigitos(v) : null)).refine((v) => v === null || v.length === 7, 'Código IBGE do município deve ter 7 dígitos');
const Valor = z.number().min(0).max(100_000_000);
const Id = z.number().int().positive().nullish().transform((v) => v ?? null);

/** Chave de acesso da NF-e: 44 dígitos, modelo 55 e dígito verificador (módulo 11). */
export function chaveNfeValida(c: string): boolean {
  if (!/^\d{44}$/.test(c) || c.slice(20, 22) !== '55') return false;
  let soma = 0, peso = 2;
  for (let i = 42; i >= 0; i--) { soma += Number(c[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11;
  return (r < 2 ? 0 : 11 - r) === Number(c[43]);
}

const NfeEntrada = z.union([
  z.object({ xml: z.string().min(200) }),
  z.object({ chave: z.string().transform(soDigitos).refine(chaveNfeValida, 'Chave de NF-e inválida (44 dígitos, modelo 55, dígito verificador)') }),
]);

export const Viagem = z.object({
  embarcador_id: z.number().int().positive(),
  produto: Texto(120),
  origem_cidade: z.string().trim().min(2).max(60),
  origem_uf: Uf,
  origem_ibge: Ibge,
  destino_cidade: z.string().trim().min(2).max(60),
  destino_uf: Uf,
  destino_ibge: Ibge,
  veiculo_id: Id,
  motorista_id: Id,
  valor_frete: Valor,
  valor_terceiro: Valor.nullish().transform((v) => v ?? null),
  custo_estimado: Valor.nullish().transform((v) => v ?? null),
  coleta_prevista: Data,
  entrega_prevista: Data,
  observacao: Texto(500),
}).superRefine((v, ctx) => {
  if (v.coleta_prevista && v.entrega_prevista && v.entrega_prevista < v.coleta_prevista) ctx.addIssue({ code: 'custom', path: ['entrega_prevista'], message: 'A entrega prevista não pode ser antes da coleta' });
});

const MudancaStatus = z.object({ status: z.enum(STATUS), data: Data });

type NfeGravar = {
  chave: string; numero: string | null; serie: string | null; emissao: string | null;
  emitente_documento: string | null; emitente_nome: string | null; destinatario_documento: string | null; destinatario_nome: string | null;
  valor: number | null; peso_kg: number | null; volumes: number | null; xml: string | null;
};

function nfeDoXml(xml: string): { gravar: NfeGravar; lida: NfeLida } {
  let lida: NfeLida;
  try { lida = lerNfe(xml); } catch (e: any) { throw new ErroNegocio(e.message ?? 'XML inválido.'); }
  if (lida.modelo !== '55') throw new ErroNegocio(`A nota ${lida.numero} é NFC-e (modelo ${lida.modelo}); a viagem só leva NF-e modelo 55.`);
  return {
    lida,
    gravar: {
      chave: lida.chave, numero: lida.numero, serie: lida.serie, emissao: lida.emissao,
      emitente_documento: lida.fornecedor.documento || null, emitente_nome: lida.fornecedor.nome || null,
      destinatario_documento: lida.destinatario.documento, destinatario_nome: lida.destinatario.nome,
      valor: lida.totais.nf, peso_kg: lida.transporte.pesoBruto || lida.transporte.pesoLiquido || null, volumes: lida.transporte.volumes || null, xml,
    },
  };
}

/** Só a chave: número, série e CNPJ do emitente saem dela; o resto fica esperando o XML. */
function nfeDaChave(chave: string): NfeGravar {
  return {
    chave, numero: String(Number(chave.slice(25, 34))), serie: String(Number(chave.slice(22, 25))), emissao: null,
    emitente_documento: chave.slice(6, 20), emitente_nome: null, destinatario_documento: null, destinatario_nome: null,
    valor: null, peso_kg: null, volumes: null, xml: null,
  };
}

function prepararNfes(entradas: z.infer<typeof NfeEntrada>[]): NfeGravar[] {
  const vistas = new Set<string>();
  return entradas.map((e) => {
    const n = 'xml' in e ? nfeDoXml(e.xml).gravar : nfeDaChave(e.chave);
    if (vistas.has(n.chave)) throw new ErroNegocio(`A NF-e ${n.numero} foi enviada duas vezes.`);
    vistas.add(n.chave);
    return n;
  });
}

/** Grava as NF-e na viagem. Chave que já está na viagem só com a chave é completada pelo XML. */
function gravarNfes(empresaId: number, viagemId: number, nfes: NfeGravar[]) {
  for (const n of nfes) {
    const outra = db.prepare(`SELECT v.numero FROM viagem_nfes x JOIN viagens v ON v.id = x.viagem_id
      WHERE x.chave = ? AND v.empresa_id = ? AND v.id <> ? AND v.status <> 'CANCELADA'`).get(n.chave, empresaId, viagemId) as { numero: number } | undefined;
    if (outra) throw new ErroNegocio(`A NF-e ${n.numero} já está na viagem nº ${outra.numero}.`);
    const atual = db.prepare('SELECT id, xml FROM viagem_nfes WHERE viagem_id = ? AND chave = ?').get(viagemId, n.chave) as { id: number; xml: string | null } | undefined;
    if (atual) {
      if (atual.xml || !n.xml) throw new ErroNegocio(`A NF-e ${n.numero} já está nesta viagem.`);
      db.prepare(`UPDATE viagem_nfes SET numero=?, serie=?, emissao=?, emitente_documento=?, emitente_nome=?, destinatario_documento=?, destinatario_nome=?, valor=?, peso_kg=?, volumes=?, xml=? WHERE id = ?`)
        .run(n.numero, n.serie, n.emissao, n.emitente_documento, n.emitente_nome, n.destinatario_documento, n.destinatario_nome, n.valor, n.peso_kg, n.volumes, n.xml, atual.id);
      continue;
    }
    db.prepare(`INSERT INTO viagem_nfes (viagem_id, chave, numero, serie, emissao, emitente_documento, emitente_nome, destinatario_documento, destinatario_nome, valor, peso_kg, volumes, xml)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(viagemId, n.chave, n.numero, n.serie, n.emissao, n.emitente_documento, n.emitente_nome, n.destinatario_documento, n.destinatario_nome, n.valor, n.peso_kg, n.volumes, n.xml);
  }
}

/** Confere embarcador, veículo e motorista da empresa e calcula o vínculo pelo veículo. */
function conferir(empresaId: number, d: z.infer<typeof Viagem>, anterior?: { embarcador_id: number; veiculo_id: number | null; motorista_id: number | null }) {
  const ativoOuMesmo = (tabela: string, id: number, mesmo: number | null | undefined) =>
    db.prepare(`SELECT * FROM ${tabela} WHERE id = ? AND empresa_id = ? AND (ativo = 1 OR id = ?)`).get(id, empresaId, mesmo ?? 0) as any;
  if (!ativoOuMesmo('embarcadores', d.embarcador_id, anterior?.embarcador_id)) throw new ErroNegocio('Embarcador não encontrado nesta empresa.');
  if (d.motorista_id && !ativoOuMesmo('motoristas', d.motorista_id, anterior?.motorista_id)) throw new ErroNegocio('Motorista não encontrado nesta empresa.');
  let vinculo: string | null = null;
  if (d.veiculo_id) {
    const v = ativoOuMesmo('veiculos', d.veiculo_id, anterior?.veiculo_id);
    if (!v) throw new ErroNegocio('Veículo não encontrado nesta empresa.');
    vinculo = v.vinculo;
  }
  // frota própria não paga frete a terceiro: o custo dela vem no acerto de viagem
  const valor_terceiro = vinculo === 'PROPRIO' ? null : d.valor_terceiro;
  return { ...d, vinculo, valor_terceiro };
}

const SELECT_LISTA = `SELECT v.*, e.nome AS embarcador_nome, e.documento AS embarcador_documento, ve.placa, ve.tipo AS veiculo_tipo, m.nome AS motorista_nome,
  (SELECT COUNT(*) FROM viagem_nfes x WHERE x.viagem_id = v.id) AS nfes,
  (SELECT COUNT(*) FROM viagem_nfes x WHERE x.viagem_id = v.id AND x.xml IS NULL) AS nfes_incompletas,
  (SELECT COALESCE(SUM(x.valor), 0) FROM viagem_nfes x WHERE x.viagem_id = v.id) AS valor_carga,
  (SELECT COALESCE(SUM(x.peso_kg), 0) FROM viagem_nfes x WHERE x.viagem_id = v.id) AS peso_kg,
  v.valor_frete - COALESCE(v.valor_terceiro, 0) - COALESCE(v.custo_estimado, 0) AS margem
  FROM viagens v JOIN embarcadores e ON e.id = v.embarcador_id LEFT JOIN veiculos ve ON ve.id = v.veiculo_id LEFT JOIN motoristas m ON m.id = v.motorista_id`;

const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

/** Pendências que não impedem salvar, mas o usuário precisa ver antes de rodar (e antes do CT-e/MDF-e). */
export function avisosDaViagem(viagemId: number): string[] {
  const v = db.prepare(`${SELECT_LISTA} WHERE v.id = ?`).get(viagemId) as any;
  if (!v || v.status === 'CANCELADA' || v.status === 'ENTREGUE') return [];
  const a: string[] = [];
  const dia = hoje();
  if (!v.veiculo_id) a.push('Sem veículo definido.');
  if (!v.motorista_id) a.push('Sem motorista definido.');
  if (!v.origem_ibge || !v.destino_ibge) a.push('Falta o código IBGE da origem ou do destino (exigido no CT-e e no MDF-e).');
  if (!v.nfes) a.push('Nenhuma NF-e vinculada.');
  if (v.nfes_incompletas) a.push(`${v.nfes_incompletas} NF-e só com a chave: importe o XML para ter valor e peso da carga.`);
  if (v.vinculo && v.vinculo !== 'PROPRIO' && !v.valor_terceiro) a.push('Informe o frete combinado com o terceiro para calcular a margem.');
  if (v.valor_frete > 0 && v.margem < 0) a.push('Margem prevista negativa.');
  if (v.veiculo_id) {
    const ve = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(v.veiculo_id) as any;
    if (ve.crlv_vencimento && ve.crlv_vencimento < dia) a.push(`CRLV do veículo ${ve.placa} vencido.`);
    if (ve.seguro_vencimento && ve.seguro_vencimento < dia) a.push(`Seguro do veículo ${ve.placa} vencido.`);
    if (ve.capacidade_kg && v.peso_kg > ve.capacidade_kg) a.push(`Peso da carga (${Math.round(v.peso_kg)} kg) acima da capacidade do veículo (${Math.round(ve.capacidade_kg)} kg).`);
    if (!ve.renavam || !ve.uf_licenciamento || !ve.tara_kg) a.push(`Veículo ${ve.placa} sem RENAVAM, UF de licenciamento ou tara (exigidos no MDF-e).`);
    if (ve.vinculo !== 'PROPRIO' && ve.proprietario_id) {
      const p = db.prepare('SELECT rntrc FROM transportadores WHERE id = ?').get(ve.proprietario_id) as any;
      if (!p?.rntrc) a.push(`Proprietário do veículo ${ve.placa} sem RNTRC.`);
    }
  }
  if (v.motorista_id) {
    const m = db.prepare('SELECT nome, cnh_validade FROM motoristas WHERE id = ?').get(v.motorista_id) as any;
    if (m.cnh_validade && m.cnh_validade < dia) a.push(`CNH de ${m.nome} vencida.`);
  }
  return a;
}

function viagemCompleta(id: number) {
  const v = db.prepare(`${SELECT_LISTA} WHERE v.id = ?`).get(id) as any;
  const nfes = db.prepare(`SELECT id, chave, numero, serie, emissao, emitente_documento, emitente_nome, destinatario_documento, destinatario_nome, valor, peso_kg, volumes,
    (xml IS NOT NULL) AS completa FROM viagem_nfes WHERE viagem_id = ? ORDER BY id`).all(id);
  return { ...v, nfes_lista: nfes, avisos: avisosDaViagem(id) };
}

function viagemDaEmpresa(req: any, id: number) {
  const v = db.prepare('SELECT * FROM viagens WHERE id = ?').get(id) as any;
  if (!v) throw new ErroNegocio('Viagem não encontrada.', 404);
  checarEmpresa(req, v.empresa_id);
  return v;
}

/** Passos permitidos. Cancelada é final; entregue pode voltar para em trânsito (lançamento por engano). */
const PASSOS: Record<Status, Status[]> = {
  AGUARDANDO_COLETA: ['EM_TRANSITO', 'ENTREGUE', 'CANCELADA'],
  EM_TRANSITO: ['AGUARDANDO_COLETA', 'ENTREGUE', 'CANCELADA'],
  ENTREGUE: ['EM_TRANSITO'],
  CANCELADA: [],
};

export function registrarViagens(api: FastifyInstance) {
  api.get('/api/empresas/:id/viagens', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const q = req.query as { status?: string; q?: string };
    const filtros = ['v.empresa_id = ?'];
    const args: unknown[] = [id];
    if (q.status === 'ABERTAS') filtros.push("v.status IN ('AGUARDANDO_COLETA','EM_TRANSITO')");
    else if (q.status && (STATUS as readonly string[]).includes(q.status)) { filtros.push('v.status = ?'); args.push(q.status); }
    const busca = String(q.q ?? '').trim();
    if (busca) {
      filtros.push(`(e.nome LIKE ? OR ve.placa LIKE ? OR m.nome LIKE ? OR v.origem_cidade LIKE ? OR v.destino_cidade LIKE ? OR CAST(v.numero AS TEXT) = ?
        OR EXISTS (SELECT 1 FROM viagem_nfes x WHERE x.viagem_id = v.id AND (x.numero = ? OR x.chave = ?)))`);
      const like = `%${busca}%`;
      args.push(like, like.toUpperCase().replace(/[^A-Z0-9%]/g, ''), like, like, like, busca, busca.replace(/^0+/, ''), soDigitos(busca));
    }
    return db.prepare(`${SELECT_LISTA} WHERE ${filtros.join(' AND ')} ORDER BY v.numero DESC LIMIT 500`).all(...args);
  });

  /** Lê um XML de NF-e sem gravar: a tela usa para preencher origem, destino e sugerir o embarcador (pelo modFrete). */
  api.post('/api/empresas/:id/viagens/ler-nfe', { bodyLimit: LIMITE_XML }, async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const { xml } = z.object({ xml: z.string().min(200) }).parse(req.body);
    const { gravar, lida } = nfeDoXml(xml);
    // FOB (1): quem paga o frete é o destinatário; nos demais casos, o emitente (remetente)
    const pagador = lida.transporte.modFrete === '1' ? lida.destinatario.documento : lida.fornecedor.documento;
    const emb = pagador ? db.prepare('SELECT id, nome FROM embarcadores WHERE empresa_id = ? AND documento = ? AND ativo = 1').get(id, pagador) as any : undefined;
    const outra = db.prepare(`SELECT v.numero FROM viagem_nfes x JOIN viagens v ON v.id = x.viagem_id WHERE x.chave = ? AND v.empresa_id = ? AND v.status <> 'CANCELADA'`).get(gravar.chave, id) as any;
    const { xml: _, ...nfe } = gravar;
    return {
      nfe, ja_em_viagem: outra?.numero ?? null,
      modFrete: lida.transporte.modFrete, pagador_documento: pagador,
      embarcador_sugerido: emb ?? null,
      origem: lida.retirada, destino: lida.entrega,
      produto: lida.itens[0]?.descricao ?? null,
    };
  });

  api.get('/api/viagens/:id', async (req) => {
    const v = viagemDaEmpresa(req, Number((req.params as any).id));
    return viagemCompleta(v.id);
  });

  api.post('/api/empresas/:id/viagens', { bodyLimit: LIMITE_XML }, async (req) => {
    const empresaId = Number((req.params as any).id);
    checarEmpresa(req, empresaId);
    const corpo = req.body as any;
    const d = conferir(empresaId, Viagem.parse(corpo));
    const nfes = prepararNfes(z.array(NfeEntrada).max(200).default([]).parse(corpo?.nfes));
    let id = 0;
    db.exec('BEGIN');
    try {
      const { n } = db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM viagens WHERE empresa_id = ?').get(empresaId) as { n: number };
      const colunas = Object.keys(d) as (keyof typeof d)[];
      id = Number(db.prepare(`INSERT INTO viagens (empresa_id, numero, criado_por, ${colunas.join(', ')}) VALUES (?, ?, ?${', ?'.repeat(colunas.length)})`)
        .run(empresaId, n, usuarioDe(req).id, ...colunas.map((k) => d[k] as any)).lastInsertRowid);
      gravarNfes(empresaId, id, nfes);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return viagemCompleta(id);
  });

  api.put('/api/viagens/:id', async (req) => {
    const atual = viagemDaEmpresa(req, Number((req.params as any).id));
    if (atual.status === 'CANCELADA') throw new ErroNegocio('Viagem cancelada não pode ser alterada.');
    const d = conferir(atual.empresa_id, Viagem.parse(req.body), atual);
    const colunas = Object.keys(d) as (keyof typeof d)[];
    db.prepare(`UPDATE viagens SET ${colunas.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((k) => d[k] as any), atual.id);
    return viagemCompleta(atual.id);
  });

  api.post('/api/viagens/:id/status', async (req) => {
    const v = viagemDaEmpresa(req, Number((req.params as any).id));
    const { status, data } = MudancaStatus.parse(req.body);
    if (status === v.status) return viagemCompleta(v.id);
    if (!PASSOS[v.status as Status].includes(status)) {
      throw new ErroNegocio(v.status === 'CANCELADA' ? 'Viagem cancelada não muda de situação.' : 'Esta mudança de situação não é permitida.');
    }
    if ((status === 'EM_TRANSITO' || status === 'ENTREGUE') && (!v.veiculo_id || !v.motorista_id)) {
      throw new ErroNegocio('Defina o veículo e o motorista antes de iniciar a viagem.');
    }
    const dia = data ?? hoje();
    const coletada = status === 'AGUARDANDO_COLETA' ? null : v.coletada_em ?? (status === 'CANCELADA' ? null : dia);
    const entregue = status === 'ENTREGUE' ? dia : null;
    if (entregue && coletada && entregue < coletada) throw new ErroNegocio('A data de entrega não pode ser antes da coleta.');
    db.prepare('UPDATE viagens SET status = ?, coletada_em = ?, entregue_em = ? WHERE id = ?').run(status, coletada, entregue, v.id);
    return viagemCompleta(v.id);
  });

  api.post('/api/viagens/:id/nfes', { bodyLimit: LIMITE_XML }, async (req) => {
    const v = viagemDaEmpresa(req, Number((req.params as any).id));
    if (v.status === 'CANCELADA') throw new ErroNegocio('Viagem cancelada não recebe NF-e.');
    const nfes = prepararNfes(z.object({ nfes: z.array(NfeEntrada).min(1).max(200) }).parse(req.body).nfes);
    db.exec('BEGIN');
    try { gravarNfes(v.empresa_id, v.id, nfes); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return viagemCompleta(v.id);
  });

  api.delete('/api/viagens/:id/nfes/:nfe', async (req) => {
    const p = req.params as any;
    const v = viagemDaEmpresa(req, Number(p.id));
    if (v.status === 'CANCELADA') throw new ErroNegocio('Viagem cancelada não pode ser alterada.');
    const r = db.prepare('DELETE FROM viagem_nfes WHERE id = ? AND viagem_id = ?').run(Number(p.nfe), v.id);
    if (!r.changes) throw new ErroNegocio('NF-e não encontrada nesta viagem.', 404);
    return viagemCompleta(v.id);
  });
}
