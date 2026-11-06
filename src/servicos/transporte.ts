import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { empresaPermitida, type Usuario } from '../auth.js';
import { ErroNegocio } from './emissao.js';
import { documentoValido, limparDoc, soDigitos } from '../nfse/validacao.js';

/**
 * Cadastros da Transportadora: embarcador (cliente que contrata o frete), motorista e veículo.
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

export const Embarcador = z.object({
  tipo_doc: z.enum(['CPF', 'CNPJ']),
  documento: z.string().transform(limparDoc).refine(documentoValido, 'CNPJ/CPF inválido'),
  nome: z.string().trim().min(2).max(300),
  email: z.string().email().nullish().or(z.literal('')).transform((v) => v || null),
  fone: Fone,
  cidade: Texto(60),
  uf: Uf,
  prazo_pagamento_dias: z.number().int().min(0).max(120).default(15),
  observacao: Texto(500),
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
export const Veiculo = z.object({
  placa: z.string().transform((p) => p.toUpperCase().replace(/[^A-Z0-9]/g, '')).refine((p) => PLACA.test(p), 'Placa inválida (use ABC1D23 ou ABC1234)'),
  tipo: z.enum(TIPOS_VEICULO),
  capacidade_kg: z.number().min(0).max(200000).nullish().transform((v) => (v && v > 0 ? v : null)),
  vinculo: Vinculo,
  proprietario_nome: Texto(200),
  proprietario_documento: z.string().nullish().transform((d) => (d ? limparDoc(d) : null)).refine((d) => d === null || documentoValido(d), 'CNPJ/CPF do proprietário inválido'),
  motorista_id: z.number().int().positive().nullish().transform((v) => v ?? null),
  crlv_vencimento: Data,
  seguro_vencimento: Data,
  ipva_vencimento: Data,
}).superRefine((v, ctx) => {
  if (v.vinculo !== 'PROPRIO' && !v.proprietario_nome) ctx.addIssue({ code: 'custom', path: ['proprietario_nome'], message: 'Informe o proprietário do veículo (agregado e autônomo)' });
});

type Esquema = z.ZodType<Record<string, any>, any>;

const usuarioDe = (req: FastifyRequest) => req.usuario as Usuario;
function checarEmpresa(req: FastifyRequest, empresaId: number) {
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
    rota: 'veiculos', tabela: 'veiculos', rotulo: 'veículo', esquema: Veiculo, unico: 'placa', busca: ['t.placa', 't.proprietario_nome', 'm.nome'], ordem: 't.placa',
    listar: 'SELECT t.*, m.nome AS motorista_nome FROM veiculos t LEFT JOIN motoristas m ON m.id = t.motorista_id',
    conferir: (empresaId, d) => {
      if (d.motorista_id && !db.prepare('SELECT 1 FROM motoristas WHERE id = ? AND empresa_id = ? AND ativo = 1').get(d.motorista_id, empresaId)) throw new ErroNegocio('Motorista não encontrado nesta empresa.');
      // frota própria: o proprietário é a própria transportadora
      if (d.vinculo === 'PROPRIO') { d.proprietario_nome = null; d.proprietario_documento = null; }
    },
  });
}
