import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { empresaPermitida, type Usuario } from '../auth.js';
import { ErroNegocio } from './emissao.js';
import { documentoValido, limparDoc, soDigitos } from '../nfse/validacao.js';

/**
 * Cadastros da Transportadora: embarcador (cliente que contrata o frete), transportador terceiro (dono do veículo agregado ou autônomo), motorista e veículo.
 * O vínculo (PROPRIO, AGREGADO, AUTONOMO) fica no veículo e no motorista e define, mais adiante,
 * como a viagem é paga: acerto de viagem (frota própria) ou frete combinado (agregado e autônomo).
 */

export const VINCULOS = ['PROPRIO', 'AGREGADO', 'AUTONOMO'] as const;
export const TIPOS_VEICULO = ['Fiorino/Van', 'VUC', '3/4', 'Toco', 'Truck', 'Bitruck', 'Carreta', 'Bitrem', 'Rodotrem', 'Outro'] as const;
export const CATEGORIAS_CNH = ['A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE'] as const;

const Vinculo = z.enum(VINCULOS);
const Data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida').nullish().or(z.literal('')).transform((v) => v || null);
const Texto = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const Fone = z.string().nullish().transform((f) => (f ? soDigitos(f) : null));
const Uf = z.string().trim().toUpperCase().length(2).nullish().or(z.literal('')).transform((v) => v || null);

const Cep = z.string().nullish().transform((v) => (v ? soDigitos(v) : null)).refine((v) => v === null || v.length === 8, 'CEP inválido');
const Ibge = z.string().nullish().transform((v) => (v ? soDigitos(v) : null)).refine((v) => v === null || v.length === 7, 'Código do município (IBGE) deve ter 7 dígitos');
const Email = z.string().email().nullish().or(z.literal('')).transform((v) => v || null);
const Ie = z.string().nullish().transform((v) => (v ? v.toUpperCase().replace(/[^0-9A-Z]/g, '') : null));
const Rntrc = z.string().nullish().transform((v) => (v ? soDigitos(v) : null)).refine((v) => v === null || v.length === 8, 'RNTRC deve ter 8 dígitos');

const Endereco = {
  cep: Cep,
  logradouro: Texto(120),
  numero: Texto(20),
  complemento: Texto(60),
  bairro: Texto(60),
  cod_municipio: Ibge,
  cidade: Texto(60),
  uf: Uf,
};

/** Indicador de contribuinte do ICMS (campo indIEDest da NF-e): 1 contribuinte, 2 isento, 9 não contribuinte. */
export const Embarcador = z.object({
  tipo_doc: z.enum(['CPF', 'CNPJ']),
  documento: z.string().transform(limparDoc).refine(documentoValido, 'CNPJ/CPF inválido'),
  nome: z.string().trim().min(2).max(300),
  inscricao_estadual: Ie,
  ind_contribuinte: z.union([z.literal(1), z.literal(2), z.literal(9)]).default(1),
  email: Email,
  fone: Fone,
  ...Endereco,
  prazo_pagamento_dias: z.number().int().min(0).max(120).default(15),
  observacao: Texto(500),
}).superRefine((v, ctx) => {
  if (v.ind_contribuinte === 1 && !v.inscricao_estadual) ctx.addIssue({ code: 'custom', path: ['inscricao_estadual'], message: 'Informe a inscrição estadual (contribuinte do ICMS)' });
});

/** Dono do veículo agregado ou autônomo (transportador terceiro). Aparece no CT-e/MDF-e e no pagamento do frete combinado. */
export const Transportador = z.object({
  tipo_doc: z.enum(['CPF', 'CNPJ']),
  documento: z.string().transform(limparDoc).refine(documentoValido, 'CNPJ/CPF inválido'),
  nome: z.string().trim().min(2).max(300),
  rntrc: Rntrc,
  inscricao_estadual: Ie,
  email: Email,
  fone: Fone,
  ...Endereco,
  dados_pagamento: Texto(300),
});

export const Motorista = z.object({
  nome: z.string().trim().min(2).max(200),
  cpf: z.string().transform(limparDoc).refine((d) => d.length === 11 && documentoValido(d), 'CPF inválido'),
  fone: Fone,
  vinculo: Vinculo,
  cnh_numero: Texto(20),
  cnh_categoria: z.enum(CATEGORIAS_CNH).nullish().or(z.literal('')).transform((v) => v || null),
  cnh_validade: Data,
});

const PLACA = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;
export const TIPOS_CARROCERIA = ['Aberta', 'Fechada/Baú', 'Granelera', 'Porta-contêiner', 'Sider', 'Tanque', 'Outra'] as const;
export const TIPOS_RODADO = ['Truck', 'Toco', 'Cavalo mecânico', 'VAN', 'Utilitário', 'Outros'] as const;

export const Veiculo = z.object({
  placa: z.string().transform((p) => p.toUpperCase().replace(/[^A-Z0-9]/g, '')).refine((p) => PLACA.test(p), 'Placa inválida (use ABC1D23 ou ABC1234)'),
  tipo: z.enum(TIPOS_VEICULO),
  capacidade_kg: z.number().min(0).max(200000).nullish().transform((v) => (v && v > 0 ? v : null)),
  tara_kg: z.number().min(0).max(100000).nullish().transform((v) => (v && v > 0 ? v : null)),
  renavam: z.string().nullish().transform((v) => (v ? soDigitos(v) : null)).refine((v) => v === null || (v.length >= 9 && v.length <= 11), 'RENAVAM inválido'),
  uf_licenciamento: Uf,
  tipo_carroceria: z.enum(TIPOS_CARROCERIA).nullish().or(z.literal('')).transform((v) => v || null),
  tipo_rodado: z.enum(TIPOS_RODADO).nullish().or(z.literal('')).transform((v) => v || null),
  vinculo: Vinculo,
  proprietario_id: z.number().int().positive().nullish().transform((v) => v ?? null),
  motorista_id: z.number().int().positive().nullish().transform((v) => v ?? null),
  crlv_vencimento: Data,
  seguro_vencimento: Data,
  ipva_vencimento: Data,
}).superRefine((v, ctx) => {
  if (v.vinculo !== 'PROPRIO' && !v.proprietario_id) ctx.addIssue({ code: 'custom', path: ['proprietario_id'], message: 'Informe o proprietário do veículo (agregado e autônomo)' });
});

type Esquema = z.ZodType<Record<string, any>, any>;

export const usuarioDe = (req: FastifyRequest) => req.usuario as Usuario;
export function checarEmpresa(req: FastifyRequest, empresaId: number) {
  if (!empresaPermitida(usuarioDe(req), empresaId)) throw new ErroNegocio('Empresa não encontrada.', 404);
}

type Cadastro = {
  rota: string; tabela: string; rotulo: string; esquema: Esquema;
  unico?: string; // coluna que não pode repetir dentro da empresa
  busca: string[]; // colunas (com alias) pesquisadas pelo parâmetro ?q=
  ordem: string;
  listar: string; // SELECT base, com alias t para a tabela
  conferir?: (empresaId: number, d: Record<string, any>) => void;
};

/** Cria GET/POST em /api/empresas/:id/<rota> e PUT/DELETE em /api/<rota>/:id. Excluir só inativa, porque as viagens vão referenciar estes registros. */
function registrarCadastro(api: FastifyInstance, c: Cadastro) {
  const lista = `${c.listar} WHERE t.empresa_id = ? AND t.ativo = 1`;
  api.get(`/api/empresas/:id/${c.rota}`, async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    const q = `%${String((req.query as any).q ?? '').trim()}%`;
    const busca = ` AND (${c.busca.map((col) => `${col} LIKE ?`).join(' OR ')})`;
    return db.prepare(`${lista}${busca} ORDER BY ${c.ordem} LIMIT 500`).all(id, ...c.busca.map(() => q));
  });

  const gravar = (empresaId: number, d: Record<string, any>, registroId: number | null) => {
    if (c.unico && d[c.unico] != null) {
      const outro = db.prepare(`SELECT id, ativo FROM ${c.tabela} WHERE empresa_id = ? AND ${c.unico} = ?`).get(empresaId, d[c.unico]) as { id: number; ativo: number } | undefined;
      if (outro && outro.id !== registroId) {
        const campo = c.unico === 'placa' ? 'esta placa' : 'este documento';
        if (outro.ativo) throw new ErroNegocio(`Já existe ${c.rotulo} com ${campo}.`);
        // cadastro excluído antes (apenas inativado): cadastrar de novo o traz de volta
        if (registroId !== null) throw new ErroNegocio(`Já existe ${c.rotulo} excluído com ${campo}. Cadastre-o de novo para reativá-lo.`);
        registroId = outro.id;
      }
    }
    c.conferir?.(empresaId, d);
    const colunas = Object.keys(d);
    if (registroId === null) {
      const r = db.prepare(`INSERT INTO ${c.tabela} (empresa_id, ${colunas.join(', ')}) VALUES (?${', ?'.repeat(colunas.length)})`).run(empresaId, ...colunas.map((k) => d[k]));
      return Number(r.lastInsertRowid);
    }
    db.prepare(`UPDATE ${c.tabela} SET ${colunas.map((k) => `${k} = ?`).join(', ')}, ativo = 1 WHERE id = ?`).run(...colunas.map((k) => d[k]), registroId);
    return registroId;
  };

  api.post(`/api/empresas/:id/${c.rota}`, async (req) => {
    const id = Number((req.params as any).id);
    checarEmpresa(req, id);
    return { id: gravar(id, c.esquema.parse(req.body), null) };
  });
  api.put(`/api/${c.rota}/:id`, async (req) => {
    const id = Number((req.params as any).id);
    const t = db.prepare(`SELECT empresa_id FROM ${c.tabela} WHERE id = ?`).get(id) as { empresa_id: number } | undefined;
    if (!t) throw new ErroNegocio(`${c.rotulo[0].toUpperCase()}${c.rotulo.slice(1)} não encontrado.`, 404);
    checarEmpresa(req, t.empresa_id);
    gravar(t.empresa_id, c.esquema.parse(req.body), id);
    return { ok: true };
  });
  api.delete(`/api/${c.rota}/:id`, async (req) => {
    const id = Number((req.params as any).id);
    const t = db.prepare(`SELECT empresa_id FROM ${c.tabela} WHERE id = ?`).get(id) as { empresa_id: number } | undefined;
    if (!t) throw new ErroNegocio(`${c.rotulo[0].toUpperCase()}${c.rotulo.slice(1)} não encontrado.`, 404);
    checarEmpresa(req, t.empresa_id);
    db.prepare(`UPDATE ${c.tabela} SET ativo = 0 WHERE id = ?`).run(id);
    if (c.tabela === 'motoristas') db.prepare('UPDATE veiculos SET motorista_id = NULL WHERE motorista_id = ?').run(id);
    if (c.tabela === 'transportadores') {
      const em = db.prepare('SELECT COUNT(*) n FROM veiculos WHERE proprietario_id = ? AND ativo = 1').get(id) as { n: number };
      if (em.n) { db.prepare('UPDATE transportadores SET ativo = 1 WHERE id = ?').run(id); throw new ErroNegocio('Este transportador é proprietário de veículos ativos. Troque ou exclua os veículos antes.'); }
    }
    return { ok: true };
  });
}

export function registrarTransporte(api: FastifyInstance) {
  registrarCadastro(api, {
    rota: 'embarcadores', tabela: 'embarcadores', rotulo: 'embarcador', esquema: Embarcador, unico: 'documento', busca: ['t.nome', 't.documento'], ordem: 't.nome',
    listar: 'SELECT t.* FROM embarcadores t',
  });
  registrarCadastro(api, {
    rota: 'motoristas', tabela: 'motoristas', rotulo: 'motorista', esquema: Motorista, unico: 'cpf', busca: ['t.nome', 't.cpf'], ordem: 't.nome',
    listar: 'SELECT t.* FROM motoristas t',
  });
  registrarCadastro(api, {
    rota: 'transportadores', tabela: 'transportadores', rotulo: 'transportador', esquema: Transportador, unico: 'documento', busca: ['t.nome', 't.documento', 't.rntrc'], ordem: 't.nome',
    listar: 'SELECT t.* FROM transportadores t',
  });
  registrarCadastro(api, {
    rota: 'veiculos', tabela: 'veiculos', rotulo: 'veículo', esquema: Veiculo, unico: 'placa', busca: ['t.placa', 'p.nome', 'm.nome'], ordem: 't.placa',
    listar: 'SELECT t.*, m.nome AS motorista_nome, p.nome AS proprietario_nome, p.rntrc AS proprietario_rntrc FROM veiculos t LEFT JOIN motoristas m ON m.id = t.motorista_id LEFT JOIN transportadores p ON p.id = t.proprietario_id',
    conferir: (empresaId, d) => {
      if (d.motorista_id && !db.prepare('SELECT 1 FROM motoristas WHERE id = ? AND empresa_id = ? AND ativo = 1').get(d.motorista_id, empresaId)) throw new ErroNegocio('Motorista não encontrado nesta empresa.');
      if (d.proprietario_id && !db.prepare('SELECT 1 FROM transportadores WHERE id = ? AND empresa_id = ? AND ativo = 1').get(d.proprietario_id, empresaId)) throw new ErroNegocio('Proprietário não encontrado nesta empresa.');
      // frota própria: o proprietário é a própria transportadora
      if (d.vinculo === 'PROPRIO') d.proprietario_id = null;
    },
  });
}
