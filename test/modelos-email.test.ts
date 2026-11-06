import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('modelos de e-mail: render, edição validada, restauração e assinatura em imagem', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-modelos-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x'.repeat(40) });
  const { criarApp } = await import('../src/server.js');
  const E = await import('../src/servicos/email.js');
  const M = await import('../src/servicos/modelos-email.js');
  const enviados: any[] = [];
  E.trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Horizonte', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    await call('PUT', '/api/email/config', { host: 'smtp.exemplo.com', port: 465, secure: true, usuario: 'ana@x.com', senha: 'segredo-123', remetente_nome: 'Horizonte Serviços', remetente_email: 'ana@x.com' }, t);

    // sugerido: lista de modelos, linha com campo vazio some, quadro de lista vira tabela
    const lista = (await call('GET', '/api/email/modelos', undefined, t)).json;
    assert.deepEqual(lista.map((m: any) => m.chave), ['nota', 'nota_cancelada', 'boleto', 'pix', 'pacote']);
    assert.ok(lista.every((m: any) => !m.personalizado));
    const r = M.renderizar('boleto', { cliente: 'ABM', emitente: 'Horizonte', remetente: 'Horizonte', valor: 'R$ 100,00', vencimento: '10/02/2027', linha_digitavel: '' });
    assert.equal(r.assunto, 'Boleto com vencimento em 10/02/2027 — Horizonte');
    assert.ok(!r.texto.includes('linha digitável'), 'linha com campo vazio não é enviada');
    assert.ok(r.texto.startsWith('Olá, ABM!'));

    // edição: campo inexistente é recusado; válido personaliza; igual ao sugerido volta a "sugerido"
    const ruim = await call('PUT', '/api/email/modelos/pix', { assunto: 'Oi {{inexistente}}', corpo: 'x' }, t);
    assert.equal(ruim.status, 400); assert.match(JSON.stringify(ruim.json), /inexistente/);
    assert.equal((await call('PUT', '/api/email/modelos/pix', { assunto: 'Seu Pix de {{valor}}', corpo: '{{saudacao}}\n\nPague **{{valor}}**.\n{{pix_copia_cola}}' }, t)).status, 200);
    assert.equal((await call('GET', '/api/email/modelos', undefined, t)).json.find((m: any) => m.chave === 'pix').personalizado, true);

    // a mensagem real usa o texto salvo
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'HORIZONTE SERVICOS LTDA', cod_municipio: '4202404', op_simp_nac: 3, email: 'contato@horizonte.com.br' }, t)).json.id;
    await E.enviarMensagemBoleto(1, ['c@x.com'], { empresa_id: eid, forma: 'PIX', valor: 225, vencimento: '2027-02-10', pix_copia_cola: 'CODIGO123' }, { nome: 'ABM' }, []);
    assert.match(enviados.at(-1).subject, /^Seu Pix de R\$\s225,00$/); assert.ok(enviados.at(-1).text.includes('CODIGO123'));

    // assinatura: PNG mínimo entra inline no HTML e como anexo cid; remover tira
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    assert.equal((await call('PUT', '/api/email/assinatura', { imagem: png }, t)).status, 200);
    assert.equal((await call('PUT', '/api/email/assinatura', { imagem: 'data:text/html;base64,AAAA' }, t)).status, 400);
    const antes = enviados.length;
    await call('POST', '/api/email/modelos/nota/teste', { para: 'ana@x.com', assunto: 'Nota {{numero}}', corpo: '{{saudacao}}\n\nNota {{numero}} de {{valor}}.' }, t);
    const m = enviados[antes];
    assert.equal(m.subject, '[TESTE] Nota 128');
    assert.ok(m.html.includes('cid:assinatura@kontor') && !m.html.includes('<!--assinatura-->'));
    assert.equal(m.attachments.at(-1).cid, 'assinatura@kontor');
    const prev = (await call('POST', '/api/email/modelos/nota/previa', { assunto: 'a {{zzz}}', corpo: 'b' }, t)).json;
    assert.deepEqual(prev.desconhecidos, ['zzz']); assert.ok(prev.html.includes('data:image/png'));
    await call('PUT', '/api/email/assinatura', { imagem: null }, t);
    await call('POST', '/api/email/modelos/nota/teste', { para: 'ana@x.com', assunto: 'N', corpo: 'oi' }, t);
    assert.ok(!enviados.at(-1).html.includes('cid:') && !enviados.at(-1).html.includes('<!--'));

    // restaurar
    assert.equal((await call('DELETE', '/api/email/modelos/pix', undefined, t)).status, 200);
    assert.equal((await call('GET', '/api/email/modelos', undefined, t)).json.find((x: any) => x.chave === 'pix').personalizado, false);
    // operador não edita modelos
    assert.equal((await call('GET', '/api/email/modelos')).status, 401);
  } finally { await app.close(); }
});
