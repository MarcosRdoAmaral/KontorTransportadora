import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('fechamento mensal: e-mail da contabilidade, envio manual e automático no dia escolhido', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-fech-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1', FECHAMENTO_AUTOMATICO: '0' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const { trocarTransporte } = await import('../src/servicos/email.js');
  const { fechamentoAutomatico, mesAnterior } = await import('../src/servicos/contabilidade.js');
  const enviados: any[] = [];
  trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    assert.equal(mesAnterior('2026-01-15'), '2025-12'); assert.equal(mesAnterior('2026-10-26'), '2026-09');
    const token = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const emp = (await call('POST', '/api/empresas', { documento: '10.512.356/0001-68', razao_social: 'BARBIERI', cod_municipio: '4208203', op_simp_nac: 3 }, token)).json.id;
    const u = `/api/empresas/${emp}/contabilidade`;
    // validações
    assert.equal((await call('PUT', `${u}/config`, { emails: 'invalido', ativo: false }, token)).status, 400);
    assert.equal((await call('PUT', `${u}/config`, { emails: '', ativo: true, dia: 5 }, token)).status, 400);
    assert.equal((await call('PUT', `${u}/config`, { emails: 'contador@x.com', ativo: true }, token)).status, 400);
    assert.equal((await call('POST', `${u}/enviar`, {}, token)).status, 400, 'sem e-mail do escritório configurado');
    // e-mail do escritório
    const cfg = { host: 'smtp.exemplo.com', port: 465, secure: true, usuario: 'ana@x.com', senha: 'segredo-123', remetente_nome: 'Contábil', remetente_email: 'ana@x.com' };
    assert.equal((await call('PUT', '/api/email/config', cfg, token)).status, 200);
    assert.equal((await call('PUT', `${u}/config`, { emails: 'contador@x.com; outro@x.com', ativo: true, dia: 5 }, token)).status, 200);
    const antes = (await call('GET', `${u}/config`, undefined, token)).json;
    assert.equal(antes.emails, 'contador@x.com, outro@x.com'); assert.equal(antes.ativo, true); assert.equal(antes.dia, 5);
    // com movimento (uma despesa), envia
    db.prepare("INSERT INTO despesas (empresa_id, data, categoria, descricao, valor) VALUES (?,?,?,?,?)").run(emp, '2026-09-10', 'Aluguel', 'Sala', 500);
    const r = await call('POST', `${u}/enviar`, { mes: '2026-09' }, token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(enviados.length, 1); assert.equal(enviados[0].to, 'contador@x.com, outro@x.com');
    assert.match(enviados[0].subject, /Fechamento 09\/2026/); assert.equal(enviados[0].attachments[0].contentType, 'application/zip');
    assert.equal((await call('GET', `${u}/config`, undefined, token)).json.ultimo, '2026-09');
    // automático: antes do dia não envia; no dia envia o mês anterior uma vez só
    db.prepare("UPDATE empresas SET fechamento_ultimo = NULL, fechamento_resultado = NULL WHERE id = ?").run(emp);
    assert.equal(await fechamentoAutomatico('2026-10-04'), 0);
    assert.equal(await fechamentoAutomatico('2026-10-05'), 1);
    assert.equal(await fechamentoAutomatico('2026-10-06'), 0, 'já enviado neste mês');
    assert.equal(enviados.length, 2);
    // desligado, não envia
    db.prepare("UPDATE empresas SET fechamento_ultimo = NULL, fechamento_ativo = 0 WHERE id = ?").run(emp);
    assert.equal(await fechamentoAutomatico('2026-10-20'), 0);
    // só administrador mexe
    assert.equal((await call('GET', `${u}/config`)).status, 401);
  } finally { await app.close(); }
});
