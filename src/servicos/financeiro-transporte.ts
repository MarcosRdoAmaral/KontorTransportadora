import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { checarEmpresa, usuarioDe } from './transporte.js';
import { criarCobranca } from './cobranca.js';

/**
 * Financeiro da Transportadora: fatura de frete (um ou vários CT-e do mesmo embarcador, com boleto/Pix pela
 * integração bancária já existente), CIOT e vale-pedágio por viagem, acerto de viagem e o painel.
 */

const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const somarDias = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const Data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida');
const Texto = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

function doRegistro(req: any, tabela: string, id: number): any {
  const r = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(id) as any;
  if (!r) throw new ErroNegocio('Registro não encontrado.', 404);
  checarEmpresa(req, r.empresa_id);
  return r;
}

// ------------------------------------------------------------------ faturas

/** A situação da fatura acompanha a cobrança: boleto/Pix pago dá baixa na fatura. */
function sincronizarFaturas(empresaId: number) {
  db.prepare(`UPDATE faturas_frete SET status = 'PAGA', pago_em = COALESCE(pago_em, date('now','localtime'))
    WHERE empresa_id = ? AND status = 'ABERTA' AND cobranca_id IN (SELECT id FROM cobrancas WHERE status = 'PAGO')`).run(empresaId);
}

const SELECT_FATURA = `SELECT f.*, e.nome AS embarcador_nome, e.documento AS embarcador_documento,
  (SELECT COUNT(*) FROM fatura_ctes x WHERE x.fatura_id = f.id) AS qtd_ctes,
  co.status AS cobranca_status, co.forma AS cobranca_forma, co.linha_digitavel, co.pix_copia_cola
  FROM faturas_frete f JOIN embarcadores e ON e.id = f.embarcador_id LEFT JOIN cobrancas co ON co.id = f.cobranca_id`;

function faturaCompleta(id: number) {
  const f = db.prepare(`${SELECT_FATURA} WHERE f.id = ?`).get(id) as any;
  const ctes = db.prepare(`SELECT c.id, c.status, c.numero, c.valor_prestacao, c.origem_cidade, c.origem_uf, c.destino_cidade, c.destino_uf, v.numero AS viagem_numero
    FROM fatura_ctes x JOIN ctes c ON c.id = x.cte_id JOIN viagens v ON v.id = c.viagem_id WHERE x.fatura_id = ? ORDER BY c.id`).all(id);
  return { ...f, ctes };
}

const NovaFatura = z.object({
  embarcador_id: z.number().int().positive(),
  cte_ids: z.array(z.number().int().positive()).min(1, 'Escolha ao menos um CT-e'),
  vencimento: Data.nullish(),
  observacao: Texto(500),
  gerar_cobranca: z.boolean().default(false),
});

/** O pagador do boleto é o embarcador: a cobrança usa o cadastro de clientes, então ele é criado/atualizado lá com o mesmo documento. */
function tomadorDoEmbarcador(empresaId: number, embarcadorId: number): number {
  const e = db.prepare('SELECT * FROM embarcadores WHERE id = ?').get(embarcadorId) as any;
  const t = db.prepare('SELECT id FROM tomadores WHERE empresa_id = ? AND documento = ?').get(empresaId, e.documento) as any;
  const campos = [e.nome, e.email, e.fone, e.cep, e.cod_municipio, e.logradouro, e.numero, e.complemento, e.bairro, e.cidade, e.uf];
  if (t) {
    db.prepare('UPDATE tomadores SET nome=?, email=COALESCE(?, email), fone=COALESCE(?, fone), cep=?, cod_municipio=?, logradouro=?, numero=?, complemento=?, bairro=?, cidade=?, uf=? WHERE id=?').run(...campos, t.id);
    return t.id;
  }
  return Number(db.prepare(`INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, email, fone, cep, cod_municipio, logradouro, numero, complemento, bairro, cidade, uf, modo_faturamento)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'BOLETO')`).run(empresaId, e.tipo_doc, e.documento, ...campos).lastInsertRowid);
}

function gerarCobrancaDaFatura(req: any, f: any) {
  if (f.cobranca_id) {
    const c = db.prepare('SELECT status FROM cobrancas WHERE id = ?').get(f.cobranca_id) as any;
    if (c && c.status !== 'CANCELADO') throw new ErroNegocio('Esta fatura já tem cobrança.');
  }
  const tomadorId = tomadorDoEmbarcador(f.empresa_id, f.embarcador_id);
  const ctes = db.prepare('SELECT c.numero, v.numero AS viagem FROM fatura_ctes x JOIN ctes c ON c.id = x.cte_id JOIN viagens v ON v.id = c.viagem_id WHERE x.fatura_id = ?').all(f.id) as any[];
  const refs = ctes.map((c) => (c.numero ? `CT-e ${c.numero}` : `viagem ${c.viagem}`)).join(', ');
  const cob = criarCobranca({ empresaId: f.empresa_id, tomadorId, notaId: null, descricao: `Fatura de frete nº ${f.numero} (${refs})`, valor: f.valor, vencimento: f.vencimento, usuarioId: usuarioDe(req).id, semDesconto: true });
  db.prepare('UPDATE faturas_frete SET cobranca_id = ? WHERE id = ?').run(cob.id, f.id);
}

// ------------------------------------------------------------------ CIOT e vale-pedágio

export const OPERADORAS = ['e-Frete', 'Pamcard', 'Repom', 'Target', 'NDD Cargo', 'Sem Parar', 'Veloe', 'ConectCar', 'Move Mais', 'Outra'] as const;
const Pagamento = z.object({
  viagem_id: z.number().int().positive(),
  tipo: z.enum(['CIOT', 'VALE_PEDAGIO']),
  operadora: Texto(40),
  numero: z.string().trim().min(3, 'Informe o número').max(40),
  valor: z.number().min(0).default(0),
  data: Data,
  observacao: Texto(300),
});

// ------------------------------------------------------------------ acerto de viagem

export const TIPOS_DESPESA = ['COMBUSTIVEL', 'PEDAGIO', 'ALIMENTACAO', 'HOSPEDAGEM', 'MANUTENCAO', 'CARGA_DESCARGA', 'OUTROS'] as const;
const Acerto = z.object({
  adiantamento: z.number().min(0).default(0),
  comissao_pct: z.number().min(0).max(100).default(0),
  km_inicial: z.number().int().min(0).nullish().transform((v) => v ?? null),
  km_final: z.number().int().min(0).nullish().transform((v) => v ?? null),
  observacao: Texto(500),
  itens: z.array(z.object({
    data: Data.nullish().or(z.literal('')).transform((v) => v || null),
    tipo: z.enum(TIPOS_DESPESA),
    descricao: Texto(120),
    valor: z.number().positive('Valor da despesa'),
    litros: z.number().min(0).nullish().transform((v) => v || null),
    pago_pelo_motorista: z.boolean().default(true),
  })).max(300).default([]),
}).superRefine((a, ctx) => {
  if (a.km_inicial != null && a.km_final != null && a.km_final < a.km_inicial) ctx.addIssue({ code: 'custom', path: ['km_final'], message: 'Km final menor que o inicial' });
});

/** Resultado da viagem: frete − terceiro − despesas − comissão. Saldo do motorista: comissão + despesas que ele pagou − adiantamento. */
function acertoCompleto(viagemId: number) {
  const v = db.prepare(`SELECT v.*, e.nome AS embarcador_nome, ve.placa, m.nome AS motorista_nome FROM viagens v JOIN embarcadores e ON e.id = v.embarcador_id
    LEFT JOIN veiculos ve ON ve.id = v.veiculo_id LEFT JOIN motoristas m ON m.id = v.motorista_id WHERE v.id = ?`).get(viagemId) as any;
  const a = (db.prepare('SELECT * FROM acertos WHERE viagem_id = ?').get(viagemId) as any) ?? { adiantamento: 0, comissao_pct: 0, km_inicial: null, km_final: null, observacao: null, status: 'NOVO', id: null };
  const itens = a.id ? db.prepare('SELECT * FROM acerto_itens WHERE acerto_id = ? ORDER BY data, id').all(a.id) as any[] : [];
  const pedagio = (db.prepare("SELECT COALESCE(SUM(valor),0) s FROM pagamentos_frete WHERE viagem_id = ? AND tipo = 'VALE_PEDAGIO'").get(viagemId) as any).s;
  const despesas = itens.reduce((s, i) => s + i.valor, 0);
  const pagasMotorista = itens.filter((i) => i.pago_pelo_motorista).reduce((s, i) => s + i.valor, 0);
  const comissao = Math.round(v.valor_frete * a.comissao_pct) / 100;
  const terceiro = v.vinculo === 'PROPRIO' ? 0 : v.valor_terceiro ?? 0;
  const litros = itens.filter((i) => i.tipo === 'COMBUSTIVEL').reduce((s, i) => s + (i.litros ?? 0), 0);
  const km = a.km_inicial != null && a.km_final != null ? a.km_final - a.km_inicial : null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    viagem: v, acerto: a, itens,
    resumo: {
      frete: v.valor_frete, terceiro, despesas: r2(despesas), vale_pedagio: pedagio, comissao,
      resultado: r2(v.valor_frete - terceiro - despesas - pedagio - comissao),
      saldo_motorista: r2(comissao + pagasMotorista - a.adiantamento),
      km, litros, media_km_l: km && litros ? Math.round((km / litros) * 100) / 100 : null,
      custo_km: km ? r2((despesas + pedagio) / km) : null,
    },
  };
}

// ------------------------------------------------------------------ rotas

export function registrarFinanceiroTransporte(api: FastifyInstance) {
  // faturas
  api.get('/api/empresas/:id/faturas-frete', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    sincronizarFaturas(id);
    const st = (req.query as any).status;
    const ok = ['ABERTA', 'PAGA', 'CANCELADA'].includes(st);
    return db.prepare(`${SELECT_FATURA} WHERE f.empresa_id = ?${ok ? ' AND f.status = ?' : ''} ORDER BY f.numero DESC LIMIT 500`).all(...(ok ? [id, st] : [id]));
  });
  /** CT-e que ainda não estão em fatura, por embarcador. */
  api.get('/api/empresas/:id/faturas-frete/ctes-livres', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    return db.prepare(`SELECT c.id, c.status, c.numero, c.valor_prestacao, c.embarcador_id, e.nome AS embarcador_nome, e.prazo_pagamento_dias, v.numero AS viagem_numero, v.status AS viagem_status,
        c.origem_cidade, c.origem_uf, c.destino_cidade, c.destino_uf
      FROM ctes c JOIN embarcadores e ON e.id = c.embarcador_id JOIN viagens v ON v.id = c.viagem_id
      WHERE c.empresa_id = ? AND c.status <> 'CANCELADO'
        AND NOT EXISTS (SELECT 1 FROM fatura_ctes x JOIN faturas_frete f ON f.id = x.fatura_id WHERE x.cte_id = c.id AND f.status <> 'CANCELADA')
      ORDER BY e.nome, c.id`).all(id);
  });
  api.post('/api/empresas/:id/faturas-frete', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const d = NovaFatura.parse(req.body);
    const emb = db.prepare('SELECT * FROM embarcadores WHERE id = ? AND empresa_id = ?').get(d.embarcador_id, id) as any;
    if (!emb) throw new ErroNegocio('Embarcador não encontrado nesta empresa.');
    let valor = 0;
    for (const cid of new Set(d.cte_ids)) {
      const c = db.prepare('SELECT * FROM ctes WHERE id = ? AND empresa_id = ?').get(cid, id) as any;
      if (!c || c.status === 'CANCELADO') throw new ErroNegocio('CT-e não encontrado ou cancelado.');
      if (c.embarcador_id !== emb.id) throw new ErroNegocio('Todos os CT-e da fatura precisam ser do mesmo embarcador.');
      if (db.prepare("SELECT 1 FROM fatura_ctes x JOIN faturas_frete f ON f.id = x.fatura_id WHERE x.cte_id = ? AND f.status <> 'CANCELADA'").get(cid)) throw new ErroNegocio('Um dos CT-e já está em outra fatura.');
      valor += c.valor_prestacao;
    }
    valor = Math.round(valor * 100) / 100;
    if (valor <= 0) throw new ErroNegocio('O valor da fatura precisa ser maior que zero.');
    const emissao = hoje();
    const vencimento = d.vencimento ?? somarDias(emissao, emb.prazo_pagamento_dias ?? 15);
    if (vencimento < emissao) throw new ErroNegocio('O vencimento não pode ser antes de hoje.');
    let fid = 0;
    db.exec('BEGIN');
    try {
      const { n } = db.prepare('SELECT COALESCE(MAX(numero),0)+1 n FROM faturas_frete WHERE empresa_id = ?').get(id) as any;
      fid = Number(db.prepare('INSERT INTO faturas_frete (empresa_id, numero, embarcador_id, emissao, vencimento, valor, observacao) VALUES (?,?,?,?,?,?,?)')
        .run(id, n, emb.id, emissao, vencimento, valor, d.observacao).lastInsertRowid);
      for (const cid of new Set(d.cte_ids)) db.prepare('INSERT INTO fatura_ctes (fatura_id, cte_id) VALUES (?,?)').run(fid, cid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    let aviso: string | null = null;
    if (d.gerar_cobranca) {
      try { gerarCobrancaDaFatura(req, db.prepare('SELECT * FROM faturas_frete WHERE id = ?').get(fid)); }
      catch (e: any) { aviso = `Fatura criada, mas a cobrança não foi gerada: ${e.message}`; }
    }
    return { ...faturaCompleta(fid), aviso };
  });
  api.get('/api/faturas-frete/:id', async (req) => {
    const f = doRegistro(req, 'faturas_frete', Number((req.params as any).id));
    sincronizarFaturas(f.empresa_id);
    return faturaCompleta(f.id);
  });
  api.post('/api/faturas-frete/:id/cobranca', async (req) => {
    const f = doRegistro(req, 'faturas_frete', Number((req.params as any).id));
    if (f.status !== 'ABERTA') throw new ErroNegocio('Só fatura em aberto recebe cobrança.');
    gerarCobrancaDaFatura(req, f);
    return faturaCompleta(f.id);
  });
  api.post('/api/faturas-frete/:id/baixar', async (req) => {
    const f = doRegistro(req, 'faturas_frete', Number((req.params as any).id));
    if (f.status !== 'ABERTA') throw new ErroNegocio('Esta fatura não está em aberto.');
    const { data } = z.object({ data: Data.nullish() }).parse(req.body ?? {});
    db.prepare("UPDATE faturas_frete SET status = 'PAGA', pago_em = ? WHERE id = ?").run(data ?? hoje(), f.id);
    return faturaCompleta(f.id);
  });
  api.post('/api/faturas-frete/:id/cancelar', async (req) => {
    const f = doRegistro(req, 'faturas_frete', Number((req.params as any).id));
    if (f.status === 'PAGA') throw new ErroNegocio('Fatura paga não pode ser cancelada.');
    if (f.cobranca_id) {
      const c = db.prepare('SELECT status FROM cobrancas WHERE id = ?').get(f.cobranca_id) as any;
      if (c && c.status !== 'CANCELADO') throw new ErroNegocio('Cancele antes a cobrança (boleto/Pix) desta fatura, em Cobranças.');
    }
    db.prepare("UPDATE faturas_frete SET status = 'CANCELADA' WHERE id = ?").run(f.id);
    return faturaCompleta(f.id);
  });

  // CIOT e vale-pedágio
  api.get('/api/empresas/:id/pagamentos-frete', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const tipo = (req.query as any).tipo;
    const ok = tipo === 'CIOT' || tipo === 'VALE_PEDAGIO';
    return db.prepare(`SELECT p.*, v.numero AS viagem_numero, v.origem_cidade, v.destino_cidade, ve.placa, ve.vinculo FROM pagamentos_frete p JOIN viagens v ON v.id = p.viagem_id
      LEFT JOIN veiculos ve ON ve.id = v.veiculo_id WHERE p.empresa_id = ?${ok ? ' AND p.tipo = ?' : ''} ORDER BY p.data DESC, p.id DESC LIMIT 500`).all(...(ok ? [id, tipo] : [id]));
  });
  api.post('/api/empresas/:id/pagamentos-frete', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const d = Pagamento.parse(req.body);
    const v = db.prepare('SELECT status FROM viagens WHERE id = ? AND empresa_id = ?').get(d.viagem_id, id) as any;
    if (!v) throw new ErroNegocio('Viagem não encontrada nesta empresa.');
    if (v.status === 'CANCELADA') throw new ErroNegocio('Viagem cancelada.');
    if (d.tipo === 'CIOT' && d.numero.replace(/\D/g, '').length !== 12) throw new ErroNegocio('O CIOT tem 12 dígitos.');
    const r = db.prepare('INSERT INTO pagamentos_frete (empresa_id, viagem_id, tipo, operadora, numero, valor, data, observacao) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, d.viagem_id, d.tipo, d.operadora, d.tipo === 'CIOT' ? d.numero.replace(/\D/g, '') : d.numero, d.valor, d.data, d.observacao);
    return { id: Number(r.lastInsertRowid) };
  });
  api.delete('/api/pagamentos-frete/:id', async (req) => {
    const p = doRegistro(req, 'pagamentos_frete', Number((req.params as any).id));
    db.prepare('DELETE FROM pagamentos_frete WHERE id = ?').run(p.id);
    return { ok: true };
  });

  // acerto de viagem
  api.get('/api/empresas/:id/acertos', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const lista = db.prepare(`SELECT v.id FROM viagens v WHERE v.empresa_id = ? AND v.status IN ('EM_TRANSITO','ENTREGUE') ORDER BY v.numero DESC LIMIT 300`).all(id) as any[];
    return lista.map((x) => {
      const a = acertoCompleto(x.id);
      return { viagem_id: x.id, numero: a.viagem.numero, status_viagem: a.viagem.status, vinculo: a.viagem.vinculo, placa: a.viagem.placa, motorista_nome: a.viagem.motorista_nome,
        embarcador_nome: a.viagem.embarcador_nome, rota: `${a.viagem.origem_cidade}/${a.viagem.origem_uf} → ${a.viagem.destino_cidade}/${a.viagem.destino_uf}`,
        status: a.acerto.status, ...a.resumo };
    });
  });
  api.get('/api/viagens/:id/acerto', async (req) => acertoCompleto(doRegistro(req, 'viagens', Number((req.params as any).id)).id));
  api.put('/api/viagens/:id/acerto', async (req) => {
    const v = doRegistro(req, 'viagens', Number((req.params as any).id));
    if (v.status === 'CANCELADA') throw new ErroNegocio('Viagem cancelada.');
    const atual = db.prepare('SELECT * FROM acertos WHERE viagem_id = ?').get(v.id) as any;
    if (atual?.status === 'FECHADO') throw new ErroNegocio('Acerto fechado. Reabra para alterar.');
    const d = Acerto.parse(req.body);
    db.exec('BEGIN');
    try {
      let aid = atual?.id;
      if (!aid) aid = Number(db.prepare('INSERT INTO acertos (empresa_id, viagem_id) VALUES (?, ?)').run(v.empresa_id, v.id).lastInsertRowid);
      db.prepare('UPDATE acertos SET adiantamento=?, comissao_pct=?, km_inicial=?, km_final=?, observacao=? WHERE id=?').run(d.adiantamento, d.comissao_pct, d.km_inicial, d.km_final, d.observacao, aid);
      db.prepare('DELETE FROM acerto_itens WHERE acerto_id = ?').run(aid);
      for (const i of d.itens) db.prepare('INSERT INTO acerto_itens (acerto_id, data, tipo, descricao, valor, litros, pago_pelo_motorista) VALUES (?,?,?,?,?,?,?)').run(aid, i.data, i.tipo, i.descricao, i.valor, i.litros, i.pago_pelo_motorista ? 1 : 0);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return acertoCompleto(v.id);
  });
  api.post('/api/viagens/:id/acerto/fechar', async (req) => {
    const v = doRegistro(req, 'viagens', Number((req.params as any).id));
    if (v.status !== 'ENTREGUE') throw new ErroNegocio('O acerto é fechado depois da entrega.');
    const a = db.prepare('SELECT id FROM acertos WHERE viagem_id = ?').get(v.id) as any;
    if (!a) throw new ErroNegocio('Salve o acerto antes de fechar.');
    db.prepare("UPDATE acertos SET status = 'FECHADO', fechado_em = ? WHERE id = ?").run(hoje(), a.id);
    return acertoCompleto(v.id);
  });
  api.post('/api/viagens/:id/acerto/reabrir', async (req) => {
    const v = doRegistro(req, 'viagens', Number((req.params as any).id));
    db.prepare("UPDATE acertos SET status = 'ABERTO', fechado_em = NULL WHERE viagem_id = ?").run(v.id);
    return acertoCompleto(v.id);
  });

  // painel
  api.get('/api/empresas/:id/painel-transporte', async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    sincronizarFaturas(id);
    const dia = hoje(), mes = dia.slice(0, 7), em30 = somarDias(dia, 30);
    const porStatus = Object.fromEntries((db.prepare("SELECT status, COUNT(*) n FROM viagens WHERE empresa_id = ? GROUP BY status").all(id) as any[]).map((r) => [r.status, r.n]));
    // receita do mês: viagens entregues no mês; margem prevista idem
    const mesR = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(valor_frete),0) frete, COALESCE(SUM(valor_frete - COALESCE(valor_terceiro,0) - COALESCE(custo_estimado,0)),0) margem
      FROM viagens WHERE empresa_id = ? AND status = 'ENTREGUE' AND substr(entregue_em,1,7) = ?`).get(id, mes) as any;
    const receber = db.prepare(`SELECT COALESCE(SUM(valor),0) total, COALESCE(SUM(CASE WHEN vencimento < ? THEN valor END),0) vencido, COUNT(*) n
      FROM faturas_frete WHERE empresa_id = ? AND status = 'ABERTA'`).get(dia, id) as any;
    const semFatura = db.prepare(`SELECT COALESCE(SUM(v.valor_frete),0) s, COUNT(*) n FROM viagens v WHERE v.empresa_id = ? AND v.status = 'ENTREGUE'
      AND NOT EXISTS (SELECT 1 FROM ctes c JOIN fatura_ctes x ON x.cte_id = c.id JOIN faturas_frete f ON f.id = x.fatura_id WHERE c.viagem_id = v.id AND f.status <> 'CANCELADA')`).get(id) as any;
    const dias: { dia: string; frete: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = somarDias(dia, -i);
      dias.push({ dia: d, frete: (db.prepare("SELECT COALESCE(SUM(valor_frete),0) s FROM viagens WHERE empresa_id = ? AND status = 'ENTREGUE' AND entregue_em = ?").get(id, d) as any).s });
    }
    const ultimas = db.prepare(`SELECT v.id, v.numero, v.status, v.origem_cidade, v.origem_uf, v.destino_cidade, v.destino_uf, v.valor_frete, v.entrega_prevista, e.nome AS embarcador_nome, ve.placa
      FROM viagens v JOIN embarcadores e ON e.id = v.embarcador_id LEFT JOIN veiculos ve ON ve.id = v.veiculo_id WHERE v.empresa_id = ? ORDER BY v.id DESC LIMIT 6`).all(id);
    const vencimentos: { tipo: string; descricao: string; data: string }[] = [];
    for (const v of db.prepare('SELECT placa, crlv_vencimento, seguro_vencimento, ipva_vencimento FROM veiculos WHERE empresa_id = ? AND ativo = 1').all(id) as any[]) {
      for (const [k, n] of [['crlv_vencimento', 'CRLV'], ['seguro_vencimento', 'Seguro'], ['ipva_vencimento', 'IPVA']]) if (v[k] && v[k] <= em30) vencimentos.push({ tipo: n, descricao: `${n} do veículo ${v.placa}`, data: v[k] });
    }
    for (const m of db.prepare('SELECT nome, cnh_validade FROM motoristas WHERE empresa_id = ? AND ativo = 1 AND cnh_validade IS NOT NULL AND cnh_validade <= ?').all(id, em30) as any[]) vencimentos.push({ tipo: 'CNH', descricao: `CNH de ${m.nome}`, data: m.cnh_validade });
    for (const f of db.prepare("SELECT f.numero, f.vencimento, f.valor, e.nome FROM faturas_frete f JOIN embarcadores e ON e.id = f.embarcador_id WHERE f.empresa_id = ? AND f.status = 'ABERTA' AND f.vencimento <= ?").all(id, somarDias(dia, 7)) as any[]) vencimentos.push({ tipo: 'Fatura', descricao: `Fatura nº ${f.numero} de ${f.nome}`, data: f.vencimento });
    for (const g of db.prepare("SELECT uf_favorecida, vencimento, valor FROM gnres WHERE empresa_id = ? AND status = 'A_PAGAR' AND vencimento <= ?").all(id, somarDias(dia, 7)) as any[]) vencimentos.push({ tipo: 'GNRE', descricao: `GNRE ${g.uf_favorecida}`, data: g.vencimento });
    vencimentos.sort((a, b) => a.data.localeCompare(b.data));
    const docs = {
      cte_rascunho: (db.prepare("SELECT COUNT(*) n FROM ctes WHERE empresa_id = ? AND status = 'RASCUNHO'").get(id) as any).n,
      mdfe_abertos: (db.prepare("SELECT COUNT(*) n FROM mdfes WHERE empresa_id = ? AND status IN ('RASCUNHO','AUTORIZADO')").get(id) as any).n,
      viagens_sem_cte: (db.prepare("SELECT COUNT(*) n FROM viagens v WHERE v.empresa_id = ? AND v.status <> 'CANCELADA' AND NOT EXISTS (SELECT 1 FROM ctes c WHERE c.viagem_id = v.id AND c.status <> 'CANCELADO')").get(id) as any).n,
      gnre_a_pagar: (db.prepare("SELECT COUNT(*) n FROM gnres WHERE empresa_id = ? AND status = 'A_PAGAR'").get(id) as any).n,
    };
    return { porStatus, mes: mesR, receber, semFatura, dias, ultimas, vencimentos: vencimentos.slice(0, 12), docs };
  });
}
