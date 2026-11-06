import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-acesso-'));
Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });

test('acesso por usuário: master, tipos, permissões, redefinição e recuperação por e-mail', async () => {
  const { criarApp } = await import('../src/server.js');
  const { trocarTransporte } = await import('../src/servicos/email.js');
  const { _zerarFalhas } = await import('../src/servicos/usuarios.js');
  const enviados: any[] = [];
  trocarTransporte(() => ({ sendMail: async (m: any) => { enviados.push(m); return {}; } }) as any);
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null };
  };
  try {
    // antes do primeiro acesso não existe master e o sistema não está configurado
    assert.equal((await call('POST', '/api/login', { usuario: 'KONTOR', senha: '270820' })).status, 401);
    const s = await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal((await call('POST', '/api/setup', { escritorio: 'Xx', usuario: 'kontor', nome: 'Eve', email: 'e@x.com', senha: 'senha-segura-1' })).status, 409);

    // login por usuário (qualquer caixa) e, por compatibilidade, pelo e-mail
    const adm = (await call('POST', '/api/login', { usuario: 'ana', senha: 'senha-segura-1' })).json;
    assert.equal(adm.usuario.login, 'ANA'); assert.equal(adm.usuario.tipo, 'adm');
    assert.equal((await call('POST', '/api/login', { email: 'ana@x.com', senha: 'senha-segura-1' })).status, 200);
    // o master existe, mas a antiga senha fixa não entra (o acesso de suporte é por código assinado: test/suporte.test.ts)
    assert.equal((await call('POST', '/api/login', { usuario: 'Kontor', senha: '270820' })).status, 401);
    _zerarFalhas();
    const tAdm = adm.token;

    // cadastro de usuários: nome em maiúsculas, único, sem espaços
    const ruim = await call('POST', '/api/usuarios', { login: 'joao silva', nome: 'João', tipo: 'normal' }, tAdm);
    assert.equal(ruim.status, 400);
    assert.equal((await call('POST', '/api/usuarios', { login: 'kontor', nome: 'Falso', tipo: 'adm' }, tAdm)).status, 400);
    const emp = await call('POST', '/api/empresas', { documento: '529.982.247-25', razao_social: 'MEI Teste', cod_municipio: '4208203', op_simp_nac: 2 }, tAdm);
    assert.equal(emp.status, 200);
    const novo = await call('POST', '/api/usuarios', { login: 'joao', nome: 'João', email: 'joao@x.com', tipo: 'normal', permissoes: ['painel', 'notas'], empresas: [] }, tAdm);
    assert.equal(novo.status, 200, JSON.stringify(novo.json));
    const provisoria = novo.json.senhaProvisoria;
    assert.match(provisoria, /^[A-Za-z2-9]{12}$/, 'sem senha informada, o sistema gera uma provisória aleatória');
    assert.notEqual((await call('POST', '/api/usuarios', { login: 'temp2', nome: 'T', tipo: 'normal' }, tAdm)).json.senhaProvisoria, provisoria);
    assert.equal((await call('POST', '/api/login', { usuario: 'JOAO', senha: 'Kontor2026' })).status, 401, 'a senha padrão antiga não vale para usuário novo');
    _zerarFalhas();
    assert.equal((await call('POST', '/api/usuarios', { login: 'JOAO', nome: 'Outro', tipo: 'normal' }, tAdm)).status, 409);

    // primeiro acesso com a senha provisória: só consegue trocar a senha
    const l1 = (await call('POST', '/api/login', { usuario: 'JOAO', senha: provisoria })).json;
    assert.equal(l1.trocar_senha, true);
    assert.equal((await call('GET', '/api/empresas', undefined, l1.token)).status, 403);
    assert.equal((await call('PUT', '/api/me/senha', { atual: provisoria, nova: 'Kontor2026' }, l1.token)).status, 400, 'a senha padrão antiga continua proibida');
    assert.equal((await call('PUT', '/api/me/senha', { atual: provisoria, nova: 'joao-nova-123' }, l1.token)).status, 200);
    assert.equal((await call('GET', '/api/me', undefined, l1.token)).status, 401, 'sessão antiga é encerrada');
    const tJoao = (await call('POST', '/api/login', { usuario: 'joao', senha: 'joao-nova-123' })).json.token;

    // permissões aplicadas no servidor
    assert.equal((await call('GET', '/api/empresas', undefined, tJoao)).status, 200);
    assert.equal((await call('GET', '/api/notas', undefined, tJoao)).status, 200);
    assert.equal((await call('POST', '/api/faturar', {}, tJoao)).status, 403, 'sem o módulo Emitir');
    assert.equal((await call('GET', `/api/empresas/${emp.json.id}/conta-bancaria`, undefined, tJoao)).status, 403);
    assert.equal((await call('POST', '/api/empresas', { documento: '11.222.333/0001-81', razao_social: 'X', cod_municipio: '4208203' }, tJoao)).status, 403);
    for (const rota of ['/api/usuarios', '/api/email/config', '/api/backup']) assert.equal((await call('GET', rota, undefined, tJoao)).status, 403, rota);
    assert.deepEqual((await call('GET', '/api/me', undefined, tJoao)).json.modulos, ['painel', 'notas']);

    // adm libera mais um módulo
    const lista = (await call('GET', '/api/usuarios', undefined, tAdm)).json;
    const idJoao = lista.find((x: any) => x.login === 'JOAO').id;
    assert.equal((await call('PUT', `/api/usuarios/${idJoao}`, { nome: 'João', email: 'joao@x.com', tipo: 'normal', permissoes: ['painel', 'notas', 'servicos'], empresas: [], ativo: true }, tAdm)).status, 200);
    assert.equal((await call('GET', `/api/empresas/${emp.json.id}/servicos`, undefined, tJoao)).status, 200);

    // exclusão exige a permissão própria "excluir" (mesmo com acesso à funcionalidade)
    assert.equal((await call('DELETE', '/api/servicos/9999', undefined, tJoao)).status, 403, 'sem a permissão de excluir');
    assert.equal((await call('DELETE', '/api/notas/9999', undefined, tJoao)).status, 403);
    assert.equal((await call('PUT', `/api/usuarios/${idJoao}`, { nome: 'João', email: 'joao@x.com', tipo: 'normal', permissoes: ['painel', 'notas', 'servicos', 'excluir'], empresas: [], ativo: true }, tAdm)).status, 200);
    assert.equal((await call('DELETE', '/api/servicos/9999', undefined, tJoao)).status, 404, 'com a permissão chega ao serviço (que não existe)');
    assert.equal((await call('DELETE', '/api/notas/9999', undefined, tAdm)).status, 404, 'adm sempre pode');

    // adm redefine a senha de outro usuário; o master é intocável
    assert.equal((await call('POST', `/api/usuarios/${idJoao}/redefinir-senha`, {}, tJoao)).status, 403, 'normal não redefine senhas');
    const reset = await call('POST', `/api/usuarios/${idJoao}/redefinir-senha`, {}, tAdm);
    assert.equal(reset.status, 200); assert.match(reset.json.senhaProvisoria, /^[A-Za-z2-9]{12}$/);
    assert.equal((await call('POST', '/api/login', { usuario: 'JOAO', senha: 'joao-nova-123' })).status, 401);
    assert.equal((await call('POST', '/api/login', { usuario: 'JOAO', senha: 'Kontor2026' })).status, 401, 'redefinir não volta para a senha padrão antiga');
    assert.equal((await call('POST', '/api/login', { usuario: 'JOAO', senha: reset.json.senhaProvisoria })).json.trocar_senha, true);
    const idMaster = lista.find((x: any) => x.login === 'KONTOR').id;
    assert.equal((await call('POST', `/api/usuarios/${idMaster}/redefinir-senha`, {}, tAdm)).status, 403);
    assert.equal((await call('PUT', `/api/usuarios/${idMaster}`, { nome: 'xx', tipo: 'normal', permissoes: [], empresas: [], ativo: false }, tAdm)).status, 403);
    assert.equal((await call('PUT', `/api/usuarios/${lista.find((x: any) => x.login === 'ANA').id}`, { nome: 'Ana', tipo: 'normal', permissoes: [], empresas: [], ativo: true }, tAdm)).status, 400, 'o último adm não pode virar normal');

    // esqueci minha senha: sem e-mail configurado nada é enviado, mas a resposta é a mesma
    const antes = await call('POST', '/api/esqueci-senha', { usuario: 'JOAO' });
    assert.equal(antes.status, 200); assert.equal(enviados.length, 0);
    assert.equal((await call('POST', '/api/esqueci-senha', { usuario: 'NAOEXISTE' })).json.mensagem, antes.json.mensagem);
    const cfg = { host: 'smtp.exemplo.com', port: 465, secure: true, usuario: 'ana@x.com', senha: 'segredo-123', remetente_nome: 'Contábil', remetente_email: 'ana@x.com' };
    assert.equal((await call('PUT', '/api/email/config', cfg, tAdm)).status, 200);
    await call('POST', '/api/login', { usuario: 'JOAO', senha: 'joao-nova-123' }); // (falha) só para zerar o estado abaixo
    _zerarFalhas();
    assert.equal((await call('PUT', '/api/me/senha', { atual: reset.json.senhaProvisoria, nova: 'joao-outra-456' }, (await call('POST', '/api/login', { usuario: 'JOAO', senha: reset.json.senhaProvisoria })).json.token)).status, 200);
    await call('POST', '/api/esqueci-senha', { usuario: 'joao' });
    assert.equal(enviados.length, 1); assert.equal(enviados[0].to, 'joao@x.com');
    const codigo = /é: (\d{6})/.exec(enviados[0].text)![1];
    assert.equal((await call('POST', '/api/esqueci-senha/confirmar', { usuario: 'JOAO', codigo: codigo === '000000' ? '000001' : '000000', nova: 'joao-recuperada-1' })).status, 400);
    assert.equal((await call('POST', '/api/login', { usuario: 'JOAO', senha: 'joao-recuperada-1' })).status, 401, 'código errado não troca a senha');
    assert.equal((await call('POST', '/api/esqueci-senha/confirmar', { usuario: 'JOAO', codigo })).status, 400, 'a senha nova é obrigatória');
    assert.equal((await call('POST', '/api/esqueci-senha/confirmar', { usuario: 'JOAO', codigo, nova: 'Kontor2026' })).status, 400, 'nem a senha padrão antiga');
    assert.equal((await call('POST', '/api/esqueci-senha/confirmar', { usuario: 'JOAO', codigo, nova: 'joao-recuperada-1' })).status, 200);
    assert.equal((await call('POST', '/api/esqueci-senha/confirmar', { usuario: 'JOAO', codigo, nova: 'joao-recuperada-2' })).status, 400, 'código só vale uma vez');
    assert.equal((await call('POST', '/api/login', { usuario: 'JOAO', senha: 'Kontor2026' })).status, 401, 'a recuperação não passa pela senha padrão');
    const rec = (await call('POST', '/api/login', { usuario: 'JOAO', senha: 'joao-recuperada-1' })).json;
    assert.equal(rec.trocar_senha, false, 'a senha criada na recuperação já é definitiva');
    // master não usa a recuperação por e-mail
    await call('POST', '/api/esqueci-senha', { usuario: 'KONTOR' });
    assert.equal(enviados.length, 1);

    // bloqueio após 5 erros seguidos
    _zerarFalhas();
    for (let i = 0; i < 5; i++) await call('POST', '/api/login', { usuario: 'ANA', senha: 'errada' });
    assert.equal((await call('POST', '/api/login', { usuario: 'ANA', senha: 'senha-segura-1' })).status, 429);
  } finally { await app.close(); }
});
