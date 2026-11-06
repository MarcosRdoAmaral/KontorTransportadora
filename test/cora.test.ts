import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Cora falsa: guarda o que recebeu e responde como a API documentada. */
function coraFalsa() {
  const est = {
    invoices: new Map<string, any>(), idem: new Map<string, string>(), pedidos: [] as any[], pagos: new Set<string>(), deletados: [] as string[],
    quedaNaProxima: false, recusar401: 0, tokens: 0, cabecalhos: [] as any[],
  };
  let seq = 0;
  const srv = http.createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on('data', (b) => partes.push(b));
    req.on('end', () => {
      const corpo = Buffer.concat(partes).toString('utf8');
      const url = new URL(req.url!, 'http://x');
      const json = (st: number, o?: unknown) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
      if (url.pathname === '/token') { est.tokens++; assert.match(corpo, /grant_type=client_credentials&client_id=cli-123/); return json(200, { access_token: `tok${est.tokens}`, expires_in: 86400 }); }
      est.cabecalhos.push(req.headers);
      if (est.recusar401 > 0) { est.recusar401--; return json(401, { message: 'token expirado' }); }
      if (url.pathname === '/v2/invoices/' && req.method === 'POST') {
        const idem = String(req.headers['idempotency-key']);
        if (est.quedaNaProxima) { est.quedaNaProxima = false; req.socket.destroy(); return; }
        const b = JSON.parse(corpo);
        if (est.idem.has(idem)) return json(200, est.invoices.get(est.idem.get(idem)!));
        est.pedidos.push(b);
        const id = `inv_${++seq}`;
        const total = b.services.reduce((s: number, x: any) => s + x.amount, 0);
        const inv = { id, status: 'OPEN', code: b.code, total_amount: total, total_paid: 0,
          payment_options: { bank_slip: { barcode: '1'.repeat(44), digitable: '2'.repeat(47), url: `http://127.0.0.1:${(srv.address() as any).port}/pdf/${id}`, our_number: `0000${seq}` } },
          pix: { emv: `000201PIX${id}` } };
        est.invoices.set(id, inv); est.idem.set(idem, id);
        return json(200, inv);
      }
      if (url.pathname === '/v2/invoices/' && req.method === 'GET') return json(200, { totalItems: est.pagos.size, items: [...est.pagos].map((id) => ({ id, status: 'PAID' })) });
      const m = url.pathname.match(/^\/v2\/invoices\/(inv_\d+)$/);
      if (m && req.method === 'GET') { const i = est.invoices.get(m[1]); return i ? json(200, { ...i, status: est.pagos.has(m[1]) ? 'PAID' : 'OPEN', total_paid: est.pagos.has(m[1]) ? i.total_amount : 0, occurrence_date: '2026-10-30' }) : json(404, { message: 'nao existe' }); }
      if (m && req.method === 'DELETE') {
        if (est.pagos.has(m[1])) return json(422, { code: 'REC-0006', message: 'O boleto já foi pago.' });
        est.deletados.push(m[1]); return json(204);
      }
      if (url.pathname.startsWith('/pdf/')) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 falso'); }
      if (url.pathname === '/bank-statement/statement') {
        return json(200, { start: { date: '2026-09-01', balance: 100000 }, end: { date: '2026-11-01', balance: 123456 }, header: { businessName: 'X', businessDocument: '1' },
          entries: [
            { id: 'e1', type: 'CREDIT', amount: 45000, createdAt: '2026-10-30T15:00:00Z', transaction: { id: 't1', type: 'PIX', description: 'Pix recebido', counterParty: { name: 'Cliente A', identity: '1' } } },
            { id: 'e2', type: 'DEBIT', amount: 9990, createdAt: '2026-10-31T12:00:00Z', transaction: { id: 't2', type: 'PAYMENT', description: 'Pagamento de conta', counterParty: { name: 'Energia' } } },
            { id: 'e3', type: 'BLOCK', amount: 100, createdAt: '2026-10-31T12:00:00Z', transaction: {} },
          ] });
      }
      json(404, { message: 'rota desconhecida ' + url.pathname });
    });
  });
  return { srv, est };
}

test('Cora: credenciais, emissão com idempotência, baixa, cancelamento e extrato', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kontor-cora-'));
  const { srv, est } = coraFalsa();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const porta = (srv.address() as any).port;
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x'.repeat(40), NFSE_DESKTOP: '1', CORA_URL_TESTE: `http://127.0.0.1:${porta}`, CORA_AUTOMATICO: '0', NFE_BUSCA_AUTOMATICA: '0', FECHAMENTO_AUTOMATICO: '0' });
  const { criarApp } = await import('../src/server.js');
  const { db } = await import('../src/db.js');
  const C = await import('../src/servicos/cora.js');
  const app = await criarApp();
  const call = async (method: any, url: string, payload?: any, token?: string) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') ? r.json() : null, raw: r.rawPayload };
  };
  const esperar = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); };
  try {
    const t = (await call('POST', '/api/setup', { escritorio: 'Contábil', usuario: 'ana', nome: 'Ana', email: 'ana@x.com', senha: 'senha-segura-1' })).json.token;
    const eid = (await call('POST', '/api/empresas', { documento: '13.269.205/0001-19', razao_social: 'HORIZONTE SERVICOS LTDA', cod_municipio: '4202404', op_simp_nac: 3 }, t)).json.id;
    const tom = (nome: string, doc: string, completo: boolean) => Number(db.prepare(`INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, email, logradouro, numero, bairro, cep, cidade, uf, modo_faturamento)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'BOLETO')`).run(eid, 'CPF', doc, nome, 'c@x.com', completo ? 'Rua A' : null, '10', 'Centro', completo ? '89010000' : null, 'Blumenau', 'SC').lastInsertRowid);
    const ok = tom('Cliente A', '52998224725', true), semEnd = tom('Cliente B', '11144477735', false);

    // credenciais: par inválido é recusado; válido salva e nunca devolve a chave
    const cert = path.join(tmp, 'c.pem'), chave = path.join(tmp, 'k.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', chave, '-out', cert, '-subj', '/CN=teste', '-days', '2'], { stdio: 'ignore' });
    const certTxt = fs.readFileSync(cert, 'utf8'), chaveTxt = fs.readFileSync(chave, 'utf8');
    const outra = path.join(tmp, 'o.pem');
    execFileSync('openssl', ['genrsa', '-out', outra, '2048'], { stdio: 'ignore' });
    const base = { ambiente: 'teste', client_id: 'cli-123', multa_pct: 2, juros_pct_mes: 1 };
    assert.equal((await call('PUT', `/api/empresas/${eid}/cora`, { ...base, certificado: certTxt, chave: 'lixo' }, t)).status, 400);
    const naoPar = await call('PUT', `/api/empresas/${eid}/cora`, { ...base, certificado: certTxt, chave: fs.readFileSync(outra, 'utf8') }, t);
    assert.equal(naoPar.status, 400); assert.match(JSON.stringify(naoPar.json), /não pertence/);
    const salvo = await call('PUT', `/api/empresas/${eid}/cora`, { ...base, certificado: certTxt, chave: chaveTxt }, t);
    assert.equal(salvo.status, 200, JSON.stringify(salvo.json));
    assert.ok(!JSON.stringify(salvo.json).includes('PRIVATE')); assert.ok(!JSON.stringify((await call('GET', `/api/empresas/${eid}/cora`, undefined, t)).json).includes('PRIVATE'));
    const gravado = db.prepare('SELECT chave_enc FROM contas_cora WHERE empresa_id = ?').get(eid) as any;
    assert.ok(!gravado.chave_enc.includes('PRIVATE'), 'a chave fica cifrada no banco');
    // editar sem reenviar o certificado mantém o que já estava salvo
    assert.equal((await call('PUT', `/api/empresas/${eid}/cora`, { ...base, multa_pct: 3 }, t)).status, 200);
    assert.equal((await call('PUT', `/api/empresas/${eid}/cora`, base, t)).status, 200);

    // testar conexão: token + saldo
    const teste = await call('POST', `/api/empresas/${eid}/cora/testar`, undefined, t);
    assert.equal(teste.status, 200, JSON.stringify(teste.json)); assert.equal(teste.json.saldo, 1234.56);

    // emissão: a cobrança nasce pendente e é registrada na Cora em seguida
    const av = await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: ok, descricao: 'Honorários de novembro', valor: 450, vencimento: '2027-02-10' }, t);
    assert.equal(av.status, 200, JSON.stringify(av.json));
    const cid = av.json.cobranca.id;
    await esperar(() => !!(db.prepare('SELECT cora_id FROM cobrancas WHERE id = ?').get(cid) as any).cora_id);
    let c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(cid) as any;
    assert.equal(c.status, 'REGISTRADO'); assert.equal(c.cora_id, 'inv_1'); assert.equal(c.linha_digitavel, '2'.repeat(47)); assert.equal(c.pix_copia_cola, '000201PIXinv_1');
    const ped = est.pedidos[0];
    assert.equal(ped.services[0].amount, 45000); assert.equal(ped.payment_terms.due_date, c.vencimento);
    assert.equal(ped.payment_terms.fine.rate, 2); assert.equal(ped.payment_terms.interest.rate, 1);
    assert.deepEqual(ped.payment_forms, ['BANK_SLIP', 'PIX']); assert.equal(ped.customer.document.type, 'CPF'); assert.equal(ped.customer.address.state, 'SC'); assert.equal(ped.code, `K${cid}`);
    assert.ok(est.cabecalhos.every((h) => String(h.authorization).startsWith('Bearer tok')));

    // PDF vem da Cora
    const pdf = await call('GET', `/api/cobrancas/${cid}/boleto`, undefined, t);
    assert.equal(pdf.status, 200); assert.match(pdf.raw.toString(), /%PDF-1.4 falso/);

    // dados que a Cora não aceita ficam explicados na cobrança, sem repetir sozinhos
    const baixo = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: ok, descricao: 'Pouco', valor: 4.5, vencimento: '2027-02-10' }, t)).json.cobranca.id;
    const sem = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: semEnd, descricao: 'Sem endereço', valor: 100, vencimento: '2027-02-10' }, t)).json.cobranca.id;
    await esperar(() => !!(db.prepare('SELECT observacao_banco FROM cobrancas WHERE id = ?').get(sem) as any).observacao_banco && !!(db.prepare('SELECT observacao_banco FROM cobrancas WHERE id = ?').get(baixo) as any).observacao_banco);
    assert.match((db.prepare('SELECT observacao_banco FROM cobrancas WHERE id = ?').get(baixo) as any).observacao_banco, /abaixo de R\$ 5,00/);
    assert.match((db.prepare('SELECT observacao_banco FROM cobrancas WHERE id = ?').get(sem) as any).observacao_banco, /CEP|logradouro/);
    assert.equal(est.pedidos.length, 1, 'nada foi enviado à Cora para os dois');

    // queda de rede: guarda a chave de idempotência e, na nova tentativa, a Cora não duplica
    const rede = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: ok, descricao: 'Queda', valor: 80, vencimento: '2027-02-10' }, t)).json.cobranca.id;
    est.quedaNaProxima = true;
    await esperar(() => !!(db.prepare('SELECT observacao_banco FROM cobrancas WHERE id = ?').get(rede) as any).observacao_banco);
    c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(rede) as any;
    assert.equal(c.status, 'AGUARDANDO_BANCO'); assert.match(c.observacao_banco, /tentará de novo/); assert.ok(c.cora_idem);
    const antes = est.invoices.size;
    const rodada = await C.sincronizarTudo(eid); // o ciclo automático repete só o que falhou por rede
    assert.equal(rodada.emitidas, 1);
    assert.equal(est.invoices.size, antes + 1, 'um boleto novo, sem duplicar');
    // corrige o endereço e a rodada manual registra o que tinha falhado por dados
    db.prepare("UPDATE tomadores SET logradouro = 'Rua B', cep = '89010000' WHERE id = ?").run(semEnd);
    const manual = await C.sincronizarTudo(eid, true);
    assert.equal(manual.emitidas, 1); assert.equal((db.prepare('SELECT status FROM cobrancas WHERE id = ?').get(sem) as any).status, 'REGISTRADO');

    // token expirado: renova uma vez e segue
    const tokensAntes = est.tokens; est.recusar401 = 1;
    await C.sincronizarPagos(eid);
    assert.equal(est.tokens, tokensAntes + 1);

    // baixa automática, uma vez só
    est.pagos.add('inv_1');
    assert.equal((await C.sincronizarPagos(eid)).baixadas, 1);
    c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(cid) as any;
    assert.equal(c.status, 'PAGO'); assert.equal(c.pago_em, '2026-10-30'); assert.equal(c.valor_pago, 450);
    assert.equal((await C.sincronizarPagos(eid)).baixadas, 0);

    // cancelar: em aberto cancela na Cora; já pago na Cora não cancela e atualiza a cobrança
    const aberta = db.prepare("SELECT id, cora_id FROM cobrancas WHERE cora_id = 'inv_2'").get() as any;
    assert.equal((await call('POST', `/api/cobrancas/${aberta.id}/cancelar`, undefined, t)).status, 200);
    assert.deepEqual(est.deletados, ['inv_2']); assert.equal((db.prepare('SELECT status FROM cobrancas WHERE id = ?').get(aberta.id) as any).status, 'CANCELADO');
    const paga = db.prepare("SELECT id FROM cobrancas WHERE cora_id = 'inv_3'").get() as any;
    est.pagos.add('inv_3');
    const nao = await call('POST', `/api/cobrancas/${paga.id}/cancelar`, undefined, t);
    assert.equal(nao.status, 400); assert.match(JSON.stringify(nao.json), /já foi pago/);
    assert.equal((db.prepare('SELECT status FROM cobrancas WHERE id = ?').get(paga.id) as any).status, 'PAGO');

    // reemitir um boleto em aberto: cancela o antigo na Cora e registra o novo
    const nova = (await call('POST', `/api/empresas/${eid}/boleto-avulso`, { tomadorId: ok, descricao: 'Para reemitir', valor: 120, vencimento: '2027-02-10' }, t)).json.cobranca.id;
    await esperar(() => !!(db.prepare('SELECT cora_id FROM cobrancas WHERE id = ?').get(nova) as any).cora_id);
    const antigo = db.prepare('SELECT id, cora_id FROM cobrancas WHERE id = ?').get(nova) as any;
    const re = await call('POST', `/api/cobrancas/${antigo.id}/reemitir`, { vencimento: '2027-03-10' }, t);
    assert.equal(re.status, 200, JSON.stringify(re.json));
    assert.ok(est.deletados.includes(antigo.cora_id)); assert.equal((db.prepare('SELECT status FROM cobrancas WHERE id = ?').get(antigo.id) as any).status, 'CANCELADO');

    // extrato: entra no mesmo extrato do sistema, uma vez só, e guarda o saldo
    const e1 = await call('POST', `/api/empresas/${eid}/cora/sincronizar`, undefined, t);
    assert.equal(e1.status, 200, JSON.stringify(e1.json));
    const lanc = db.prepare("SELECT valor, descricao FROM extrato_lancamentos WHERE empresa_id = ? ORDER BY documento").all(eid) as any[];
    assert.equal(lanc.length, 2); assert.equal(lanc[0].valor, 450); assert.equal(lanc[1].valor, -99.9); assert.match(lanc[0].descricao, /Pix recebido - Cliente A/);
    assert.equal((await C.sincronizarExtrato(eid)).novos, 0);
    assert.equal((db.prepare('SELECT saldo FROM contas_cora WHERE empresa_id = ?').get(eid) as any).saldo, 1234.56);

    // remover: bloqueado com boleto em aberto
    const rem = await call('DELETE', `/api/empresas/${eid}/cora`, undefined, t);
    assert.equal(rem.status, 400); assert.match(JSON.stringify(rem.json), /em aberto/);
  } finally { await app.close(); srv.close(); }
});
