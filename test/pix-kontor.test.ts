import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { lerPix } from '../src/cobranca/pix.js';

test('Pix gerado pelo Kontor com a chave da empresa (InfinitePay ou outro banco)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-pixk-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0', AVISOS_AUTOMATICOS: '0', SITFIS_AUTOMATICO: '0', ENVIO_DP_AUTOMATICO: '0' });
  const { criarApp } = await import('../src/server.js');
  const C = await import('../src/servicos/cobranca.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Ciclo', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'CICLO ASSESSORIA CONTABIL LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    const tid = (await call('POST', `/api/empresas/${eid}/tomadores`, { tipo_doc: 'CNPJ', documento: '36128844000160', nome: 'ABM TRANSPORTES LTDA.', email: 'abm@x.com', fone: '47999990000',
      cep: '89069-000', cod_municipio: '4202404', logradouro: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'Blumenau', uf: 'SC',
      modo_faturamento: 'BOLETO', forma_cobranca: 'PIX', vencimento_tipo: 'DIA_FIXO', vencimento_valor: 10 }, t)).json.id;
    // sem chave: fica pendente, como antes
    const pend = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: tid, descricao: 'Honorários', valor: 350, vencimento: '2027-02-10' }, t)).json.cobranca;
    assert.equal(pend.status, 'AGUARDANDO_BANCO');
    assert.equal((await call('POST', `/api/cobrancas/${pend.id}/pix/gerar`, {}, t)).status, 400, 'sem chave cadastrada');
    // normalização e validação da chave
    assert.equal(C.normalizarChavePix('TELEFONE', '(47) 99901-7034'), '+5547999017034');
    assert.equal(C.normalizarChavePix('TELEFONE', '+55 47 99901-7034'), '+5547999017034');
    assert.equal(C.normalizarChavePix('CNPJ', '13.269.205/0001-19'), '13269205000119');
    assert.equal(C.normalizarChavePix('EMAIL', ' Financeiro@Ciclo.com.br '), 'financeiro@ciclo.com.br');
    assert.throws(() => C.normalizarChavePix('ALEATORIA', '123'), /aleatória inválida/);
    assert.throws(() => C.normalizarChavePix('CPF', '123'), /11 números/);
    assert.equal((await call('PUT', `/api/empresas/${eid}/pix-config`, { ativo: true, tipo: 'EMAIL', chave: 'sem-arroba', nome: 'X', cidade: 'Y' }, t)).status, 400);
    const cfg = (await call('PUT', `/api/empresas/${eid}/pix-config`, { ativo: true, tipo: 'ALEATORIA', chave: '7D9F0335-8DCC-4054-9BF9-0DBD61D36906', nome: 'Ciclo Assessoria Contábil Ltda', cidade: 'Blumenau' }, t)).json;
    assert.equal(cfg.config.chave, '7d9f0335-8dcc-4054-9bf9-0dbd61d36906');
    assert.equal(cfg.config.nome, 'CICLO ASSESSORIA CONTABIL'); assert.equal(cfg.config.cidade, 'BLUMENAU');
    assert.equal(cfg.pendentes, 1);
    // pendentes: gera o Pix de todas
    assert.equal((await call('POST', `/api/empresas/${eid}/pix-gerar`, {}, t)).json.gerados, 1);
    const g = (await call('GET', `/api/empresas/${eid}/cobrancas`, undefined, t)).json.find((c: any) => c.id === pend.id);
    assert.equal(g.status, 'REGISTRADO');
    const lido = lerPix(g.pix_copia_cola); // código válido (CRC) e com o valor e a chave certos
    assert.deepEqual([lido.valor, lido.chave, lido.recebedor, lido.cidade, lido.txid], [350, '7d9f0335-8dcc-4054-9bf9-0dbd61d36906', 'CICLO ASSESSORIA CONTABIL', 'BLUMENAU', `KONTOR${pend.id}`]);
    // novas cobranças da carteira Pix já saem com o Pix
    const nova = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: tid, descricao: 'Honorários', valor: 412.5, vencimento: '2027-03-10' }, t)).json.cobranca;
    assert.equal(nova.status, 'REGISTRADO'); assert.equal(lerPix(nova.pix_copia_cola).valor, 412.5);
    assert.equal((await call('GET', `/api/cobrancas/${nova.id}/demonstrativo`, undefined, t)).status, 200);
    const png = await app.inject({ method: 'GET', url: `/api/cobrancas/${nova.id}/qrcode`, headers: { authorization: `Bearer ${t}` } });
    assert.equal(png.statusCode, 200); assert.equal(png.headers['content-type'], 'image/png'); assert.equal(png.rawPayload.subarray(1, 4).toString(), 'PNG');
    assert.match(String(png.headers['content-disposition']), /Pix_ABM_TRANSPORTES_LTDA_2027-03-10\.png/);
    assert.equal((await call('GET', `/api/cobrancas/${pend.id}/qrcode`, undefined, t)).status, 200);
    // desativado: volta a ficar pendente para informar o Pix
    await call('PUT', `/api/empresas/${eid}/pix-config`, { ativo: false, tipo: 'ALEATORIA', chave: '7d9f0335-8dcc-4054-9bf9-0dbd61d36906', nome: 'Ciclo', cidade: 'Blumenau' }, t);
    const sem = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: tid, descricao: 'Honorários', valor: 100, vencimento: '2027-04-10' }, t)).json.cobranca;
    assert.equal(sem.status, 'AGUARDANDO_BANCO');
    assert.equal((await call('POST', `/api/cobrancas/${sem.id}/pix/gerar`, {}, t)).json.status, 'REGISTRADO', 'gerar um a um continua possível');
    assert.equal((await call('GET', `/api/empresas/${eid}/pix-config`, undefined, t)).json.pendentes, 0);
  } finally { await app.close(); }
});
