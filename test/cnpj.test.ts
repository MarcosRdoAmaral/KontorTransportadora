import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-cnpj-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x' });

const respostaReceita = {
  cnpj: '00000000000191', razao_social: 'BANCO DO BRASIL SA', nome_fantasia: 'DIRECAO GERAL', descricao_situacao_cadastral: 'ATIVA',
  cep: '70073901', municipio: 'BRASILIA', uf: 'DF', descricao_tipo_de_logradouro: 'SETOR', logradouro: 'SBS QUADRA 1 BLOCO C', numero: 'S/N',
  complemento: 'EDIF SEDE III', bairro: 'ASA SUL', email: 'ATENDIMENTO@BB.COM.BR', ddd_telefone_1: '(61) 3493-9002', opcao_pelo_simples: false, cnae_fiscal: 6422100,
};

test('consulta de CNPJ: normalização, IBGE por CEP, reserva e erros', async () => {
  const { consultarCnpj } = await import('../src/servicos/consulta-cnpj.js');
  const chamadas: string[] = [];
  let modo: 'ok' | 'primeira_cai' | 'nao_existe' | 'tudo_cai' = 'ok';
  const json = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (url: string) => {
    chamadas.push(String(url));
    if (String(url).includes('viacep')) return json(200, { ibge: '5300108' });
    if (modo === 'tudo_cai') throw new Error('sem rede');
    if (modo === 'nao_existe') return json(404, { message: 'CNPJ não encontrado' });
    if (modo === 'primeira_cai' && String(url).includes('brasilapi')) return json(500, {});
    return json(200, respostaReceita);
  }) as typeof fetch;

  // inválido nem chega à rede
  await assert.rejects(consultarCnpj('11.111.111/1111-11'), /inválido/);
  assert.equal(chamadas.length, 0);

  const d = await consultarCnpj('00.000.000/0001-91');
  assert.equal(d.razao_social, 'BANCO DO BRASIL SA');
  assert.equal(d.logradouro, 'SETOR SBS QUADRA 1 BLOCO C');
  assert.equal(d.email, 'atendimento@bb.com.br');
  assert.equal(d.fone, '6134939002');
  assert.equal(d.cep, '70073901');
  assert.equal(d.cod_municipio, '5300108', 'sem IBGE na base, deve vir do CEP');
  assert.equal(d.op_simp_nac, 1);
  assert.equal(d.ativa, true);

  // segunda consulta vem do cache
  const antes = chamadas.length;
  await consultarCnpj('00000000000191');
  assert.equal(chamadas.length, antes);

  // base principal fora do ar: usa a reserva
  modo = 'primeira_cai';
  const d2 = await consultarCnpj('33.000.167/0001-01');
  assert.equal(d2.fonte, 'Minha Receita');

  modo = 'nao_existe';
  await assert.rejects(consultarCnpj('11.222.333/0001-81'), /não encontrado/);
  modo = 'tudo_cai';
  await assert.rejects(consultarCnpj('60.746.948/0001-12'), /Preencha manualmente/);
});

test('consulta de CNPJ: logradouro e bairro ausentes na base vêm do ViaCEP', async () => {
  const { consultarCnpj } = await import('../src/servicos/consulta-cnpj.js');
  const json = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('viacep')) return json({ ibge: '4202404', logradouro: 'Rua Exemplo', bairro: 'Vila Itoupava', uf: 'SC', localidade: 'Blumenau' });
    return json({ razao_social: 'FULANO MEI', descricao_situacao_cadastral: 'ATIVA', cep: '89075365', logradouro: '', numero: '', bairro: '', uf: 'SC', opcao_pelo_mei: true });
  }) as typeof fetch;
  const d = await consultarCnpj('28.627.851/0001-88');
  assert.equal(d.logradouro, 'Rua Exemplo');
  assert.equal(d.bairro, 'Vila Itoupava');
  assert.equal(d.cod_municipio, '4202404');
  assert.equal(d.numero, null);
});
