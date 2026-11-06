import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-transp-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x'.repeat(40), NFSE_DESKTOP: '1' });
process.env.LICENCA_CHAVE_PUBLICA ??= ''; // sem controle de licença neste teste

test('cadastros da transportadora: embarcador, motorista e veículo com vínculo', async () => {
  const { criarApp } = await import('../src/server.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Transportes', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'HORIZONTE TRANSPORTES LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    const base = `/api/empresas/${eid}`;

    // embarcador: documento válido, sem repetir, excluir só inativa
    assert.equal((await call('POST', `${base}/embarcadores`, { tipo_doc: 'CNPJ', documento: '11.111.111/0001-11', nome: 'Alfa' }, t)).status, 400, 'CNPJ inválido');
    const emb = (await call('POST', `${base}/embarcadores`, { tipo_doc: 'CNPJ', documento: '45.723.174/0001-10', nome: 'Indústria Alfa', uf: 'sc', prazo_pagamento_dias: 30 }, t)).json;
    assert.ok(emb.id);
    assert.match((await call('POST', `${base}/embarcadores`, { tipo_doc: 'CNPJ', documento: '45723174000110', nome: 'Repetido' }, t)).json.erro, /Já existe embarcador/);
    let lista = (await call('GET', `${base}/embarcadores`, undefined, t)).json;
    assert.equal(lista.length, 1);
    assert.equal(lista[0].uf, 'SC');
    assert.equal(lista[0].prazo_pagamento_dias, 30);
    assert.equal((await call('PUT', `/api/embarcadores/${emb.id}`, { tipo_doc: 'CNPJ', documento: '45723174000110', nome: 'Indústria Alfa SA', prazo_pagamento_dias: 45 }, t)).status, 200);
    assert.equal((await call('GET', `${base}/embarcadores?q=alfa`, undefined, t)).json[0].nome, 'Indústria Alfa SA');
    assert.equal((await call('DELETE', `/api/embarcadores/${emb.id}`, undefined, t)).status, 200);
    assert.equal((await call('GET', `${base}/embarcadores`, undefined, t)).json.length, 0);
    // cadastrar de novo traz de volta o excluído
    const volta = (await call('POST', `${base}/embarcadores`, { tipo_doc: 'CNPJ', documento: '45723174000110', nome: 'Indústria Alfa' }, t)).json;
    assert.equal(volta.id, emb.id);

    // motorista
    assert.equal((await call('POST', `${base}/motoristas`, { nome: 'Carlos', cpf: '111.111.111-11', vinculo: 'PROPRIO' }, t)).status, 400, 'CPF inválido');
    assert.equal((await call('POST', `${base}/motoristas`, { nome: 'Carlos', cpf: '45723174000110', vinculo: 'PROPRIO' }, t)).status, 400, 'CNPJ não vale como CPF');
    const mot = (await call('POST', `${base}/motoristas`, { nome: 'Carlos Silva', cpf: '529.982.247-25', vinculo: 'PROPRIO', cnh_categoria: 'E', cnh_validade: '2027-05-10' }, t)).json;
    assert.ok(mot.id);
    assert.equal((await call('POST', `${base}/motoristas`, { nome: 'Pedro', cpf: '52998224725', vinculo: 'AGREGADO', cnh_categoria: 'Z' }, t)).status, 400, 'categoria inexistente');

    // veículo: placa, proprietário exigido fora da frota própria
    const proprio = { placa: 'abc-1d23', tipo: 'Truck', vinculo: 'PROPRIO', capacidade_kg: 14000, motorista_id: mot.id, crlv_vencimento: '2026-11-10' };
    assert.equal((await call('POST', `${base}/veiculos`, { ...proprio, placa: '12-ABC' }, t)).status, 400, 'placa inválida');
    const v1 = (await call('POST', `${base}/veiculos`, proprio, t)).json;
    assert.ok(v1.id);
    assert.match((await call('POST', `${base}/veiculos`, { ...proprio, placa: 'ABC1D23' }, t)).json.erro, /Já existe veículo/);
    const semDono = await call('POST', `${base}/veiculos`, { placa: 'XYZ5678', tipo: 'Carreta', vinculo: 'AGREGADO' }, t);
    assert.equal(semDono.status, 400);
    assert.match(JSON.stringify(semDono.json), /proprietário/);
    const v2 = (await call('POST', `${base}/veiculos`, { placa: 'XYZ5678', tipo: 'Carreta', vinculo: 'AGREGADO', proprietario_nome: 'Transp. Rota Sul', proprietario_documento: '45.723.174/0001-10' }, t)).json;
    assert.ok(v2.id);
    // frota própria não guarda proprietário
    assert.equal((await call('PUT', `/api/veiculos/${v1.id}`, { ...proprio, proprietario_nome: 'Fulano' }, t)).status, 200);
    const veiculos = (await call('GET', `${base}/veiculos`, undefined, t)).json;
    assert.equal(veiculos.length, 2);
    const p = veiculos.find((v: any) => v.placa === 'ABC1D23');
    assert.equal(p.proprietario_nome, null);
    assert.equal(p.motorista_nome, 'Carlos Silva');
    assert.equal(p.capacidade_kg, 14000);
    assert.equal((await call('POST', `${base}/veiculos`, { placa: 'DEF9012', tipo: 'Toco', vinculo: 'PROPRIO', motorista_id: 99999 }, t)).status, 400, 'motorista de outra empresa');

    // excluir motorista solta o veículo dele
    assert.equal((await call('DELETE', `/api/motoristas/${mot.id}`, undefined, t)).status, 200);
    assert.equal((await call('GET', `${base}/veiculos`, undefined, t)).json.find((v: any) => v.placa === 'ABC1D23').motorista_nome, null);

    // outra empresa não enxerga nem altera
    const e2 = (await call('POST', '/api/empresas', { documento: '45.723.174/0001-10', razao_social: 'OUTRA TRANSPORTES LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    assert.equal((await call('GET', `/api/empresas/${e2}/veiculos`, undefined, t)).json.length, 0);

    // acesso por módulo: com "embarcadores" o usuário só chega aos embarcadores, não à frota
    const u = await call('POST', '/api/usuarios', { login: 'joao', nome: 'João', email: 'joao@x.com', tipo: 'normal', permissoes: ['embarcadores'], empresas: [eid] }, t);
    assert.equal(u.status, 200, JSON.stringify(u.json));
    const l1 = (await call('POST', '/api/login', { usuario: 'joao', senha: u.json.senhaProvisoria })).json;
    assert.equal((await call('PUT', '/api/me/senha', { atual: u.json.senhaProvisoria, nova: 'joao-nova-123' }, l1.token)).status, 200);
    const tj = (await call('POST', '/api/login', { usuario: 'joao', senha: 'joao-nova-123' })).json.token;
    assert.equal((await call('GET', `${base}/embarcadores`, undefined, tj)).status, 200);
    assert.equal((await call('GET', `${base}/veiculos`, undefined, tj)).status, 403);
    assert.equal((await call('GET', `${base}/motoristas`, undefined, tj)).status, 403);
  } finally { await app.close(); }
});
