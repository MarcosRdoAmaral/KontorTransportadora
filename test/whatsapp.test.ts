import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-')), 'a.db');
process.env.MASTER_KEY ??= 'a'.repeat(64);
process.env.SESSION_SECRET ??= 'b'.repeat(32);
process.env.KONTOR_MARCAS = fs.mkdtempSync(path.join(os.tmpdir(), 'marcas-'));
process.env.NFSE_MACHINE_ID = 'guid-whatsapp-teste';

const html = fs.readFileSync('ferramentas/gerador-de-licencas.html', 'utf8');
const nucleo = /<script id="nucleo">([\s\S]*?)<\/script>/.exec(html)![1];
const ferr = new Function(nucleo + '; return { gerarChaves, emitirCodigo };')();

test('whatsapp: número, autorização do cliente, envio pelo relay e histórico', async () => {
  const { db, migrar } = await import('../src/db.js');
  migrar();
  const L = await import('../src/licenca.js');
  const W = await import('../src/servicos/whatsapp.js');

  assert.equal(W.normalizarFone('(47) 99999-9999'), '5547999999999');
  assert.equal(W.normalizarFone('047 3333-4444'), '554733334444');
  assert.equal(W.normalizarFone('+55 47 99999-9999'), '5547999999999');
  assert.throws(() => W.normalizarFone('123'), /inválido/);

  db.prepare("INSERT INTO escritorios (id, nome) VALUES (1, 'Escritório')").run();
  db.prepare("INSERT INTO empresas (id, escritorio_id, documento, razao_social, cod_municipio, op_simp_nac) VALUES (1,1,'13269205000119','HORIZONTE LTDA','4202404',3)").run();
  db.prepare("INSERT INTO tomadores (id, empresa_id, tipo_doc, documento, nome) VALUES (1,1,'CNPJ','11222333000181','ABM Serviços')").run();

  const chamadas: any[] = [];
  W.trocarRede((async (url: any, init: any) => { chamadas.push({ url: String(url), corpo: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, sid: 'SM123', status: 'queued', restante: 199 }), { status: 200 }); }) as any);

  // sem licença ativada
  await assert.rejects(() => W.enviarWhatsapp(1, 1, { tipo: 'lembrete', fone: '47999999999', variaveis: {}, tomadorId: 1, aceite: true }), /exige o sistema ativado/);

  const k = await ferr.gerarChaves();
  L._teste.chave = () => k.publica;
  L._teste.agora = () => new Date('2026-01-10T15:00:00Z');
  L.ativarLicenca(await ferr.emitirCodigo(k.privada, L.codigoDoComputador(), '2026-12-20', 'Cliente X'));

  // sem autorização do cliente
  await assert.rejects(() => W.enviarWhatsapp(1, 1, { tipo: 'lembrete', fone: '47999999999', variaveis: {}, tomadorId: 1 }), /autorizou receber/);
  assert.equal(chamadas.length, 0);

  // com autorização: envia, grava o aceite e o histórico
  const r = await W.enviarWhatsapp(1, 1, { tipo: 'lembrete', fone: '(47) 99999-9999', variaveis: { '1': 'ABM', '2': 'R$ 100,00' }, texto: 'Olá', tomadorId: 1, cobrancaId: 7, aceite: true });
  assert.equal(r.ok, true); assert.equal(r.restante, 199);
  assert.equal(chamadas.length, 1);
  assert.match(chamadas[0].url, /\/enviar$/);
  assert.equal(chamadas[0].corpo.para, '5547999999999');
  assert.equal(chamadas[0].corpo.tipo, 'lembrete');
  assert.deepEqual(chamadas[0].corpo.variaveis, { '1': 'ABM', '2': 'R$ 100,00' });
  assert.ok(chamadas[0].corpo.licenca.startsWith('KG'));
  assert.equal((db.prepare('SELECT whatsapp_aceite a FROM tomadores WHERE id = 1').get() as any).a, 1);

  // próximo envio já não precisa marcar o aceite
  await W.enviarWhatsapp(1, 1, { tipo: 'atraso', fone: '47999999999', variaveis: {}, tomadorId: 1, cobrancaId: 7 });

  // o relay recusa (cota): vira erro de negócio e fica no histórico
  W.trocarRede((async () => new Response(JSON.stringify({ ok: false, erro: 'Cota mensal de 200 mensagens atingida.' }), { status: 429 })) as any);
  await assert.rejects(() => W.enviarWhatsapp(1, 1, { tipo: 'nota', fone: '47999999999', variaveis: {}, tomadorId: 1, notaId: 3 }), /Cota mensal/);

  // sem internet
  W.trocarRede((async () => { throw new Error('rede'); }) as any);
  await assert.rejects(() => W.enviarWhatsapp(1, 1, { tipo: 'nota', fone: '47999999999', variaveis: {}, tomadorId: 1 }), /Não foi possível falar/);

  const h = W.historicoWhatsapp(1) as any[];
  assert.equal(h.length, 4);
  assert.deepEqual(h.map((x) => x.status).reverse(), ['queued', 'queued', 'FALHA', 'FALHA']);
  assert.equal(h[0].cliente, 'ABM Serviços');
});

test('relay de WhatsApp: licença, cota, template e texto livre', async () => {
  const { tratar } = await import('../ferramentas/relay-whatsapp/worker.js');
  const k = await ferr.gerarChaves();
  const codigo = await ferr.emitirCodigo(k.privada, 'AAAA-BBBB-CCCC-DDDD', '2099-12-31', 'Cliente X');
  const vencido = await ferr.emitirCodigo(k.privada, 'AAAA-BBBB-CCCC-DDDD', '2020-01-01', 'Cliente X');
  const outraChave = await ferr.gerarChaves();
  const falso = await ferr.emitirCodigo(outraChave.privada, 'AAAA-BBBB-CCCC-DDDD', '2099-12-31', 'Falso');

  const kv = new Map<string, string>();
  const env: any = { CHAVE_PUBLICA: k.publica, COTA_MENSAL: '2', TWILIO_ACCOUNT_SID: 'ACxx', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_FROM: '+5547000000000', CONTENT_SID_LEMBRETE: 'HX111',
    COTAS: { get: async (c: string) => kv.get(c) ?? null, put: async (c: string, v: string) => { kv.set(c, v); } } };
  const twilio: any[] = [];
  const fakeFetch = (async (url: any, init: any) => { twilio.push({ url: String(url), form: new URLSearchParams(init.body), auth: init.headers.authorization }); return new Response(JSON.stringify({ sid: 'SM1', status: 'queued' }), { status: 201 }); }) as any;
  const pedir = (corpo: any) => tratar(new Request('https://wa.x/enviar', { method: 'POST', body: JSON.stringify(corpo) }), env, fakeFetch);
  const base = { licenca: codigo, tipo: 'lembrete', para: '5547999999999', variaveis: { '1': 'ABM' } };

  assert.equal((await pedir({ ...base, licenca: falso })).status, 401);
  assert.equal((await pedir({ ...base, licenca: 'KG2.x.y' })).status, 401);
  assert.equal((await pedir({ ...base, licenca: vencido })).status, 403);
  assert.equal((await pedir({ ...base, para: '123' })).status, 400);
  assert.equal((await pedir({ ...base, tipo: 'outro' })).status, 400);
  assert.equal(twilio.length, 0);

  // template aprovado: ContentSid + variáveis
  const ok = await pedir(base); const j: any = await ok.json();
  assert.equal(ok.status, 200); assert.equal(j.restante, 1);
  assert.equal(twilio[0].form.get('ContentSid'), 'HX111');
  assert.equal(twilio[0].form.get('To'), 'whatsapp:+5547999999999');
  assert.equal(twilio[0].form.get('From'), 'whatsapp:+5547000000000');
  assert.deepEqual(JSON.parse(twilio[0].form.get('ContentVariables')), { '1': 'ABM' });
  assert.ok(twilio[0].auth.startsWith('Basic '));

  // sem template para o tipo: precisa do texto livre
  assert.equal((await pedir({ ...base, tipo: 'atraso' })).status, 400);
  const livre = await pedir({ ...base, tipo: 'atraso', texto: 'Olá!' });
  assert.equal(livre.status, 200); assert.equal(twilio[1].form.get('Body'), 'Olá!');

  // cota de 2 por mês
  const estouro = await pedir(base); assert.equal(estouro.status, 429);
  assert.match(((await estouro.json()) as any).erro, /Cota mensal/);
  assert.equal(twilio.length, 2);
});
