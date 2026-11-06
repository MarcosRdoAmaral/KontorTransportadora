import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trib-'));
process.env.DATABASE_PATH = path.join(dir, 'd.db');
process.env.STORAGE_DIR = dir;
process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET = 'x';
process.env.NFSE_DESKTOP = '1';

const chave = '35261012345678000195550010000012341000012345';
const nfe = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00">
<ide><natOp>Venda</natOp><mod>55</mod><serie>1</serie><nNF>1234</nNF><dhEmi>2026-10-10T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>12345678000195</CNPJ><xNome>Papelaria Central Ltda</xNome></emit><dest><CNPJ>10512356000168</CNPJ></dest>
<det nItem="1"><prod><cProd>A1</cProd><xProd>Papel</xProd><NCM>48025610</NCM><CFOP>5102</CFOP><uCom>CX</uCom><qCom>10</qCom><vUnCom>25</vUnCom><vProd>250.00</vProd></prod></det>
<total><ICMSTot><vProd>250.00</vProd><vFrete>10.00</vFrete><vDesc>0.00</vDesc><vOutro>0.00</vOutro><vICMS>18.00</vICMS><vIPI>0.00</vIPI><vNF>260.00</vNF></ICMSTot>
<IBSCBSTot><gIBS><gIBSUF><vIBSUF>0.26</vIBSUF></gIBSUF><gIBSMun><vIBSMun>0.00</vIBSMun></gIBSMun></gIBS><gCBS><vCBS>2.34</vCBS></gCBS></IBSCBSTot></total>
</infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><cStat>100</cStat></infProt></protNFe></nfeProc>`;

test('tributação: perfis, tipos de documento, retenções do perfil', async () => {
  const { migrar, db } = await import('../src/db.js');
  migrar();
  const T = await import('../src/servicos/tributacao.js');
  const { importarCompraXml } = await import('../src/servicos/compras.js');
  const { comRetencoesDoServico } = await import('../src/servicos/emissao.js');
  db.prepare("INSERT INTO escritorios (id, nome) VALUES (1, 'E')").run();
  db.prepare("INSERT INTO usuarios (id, escritorio_id, nome, email, papel, login, senha_hash) VALUES (1, 1, 'A', 'a@x.com', 'admin', 'A', 'x')").run();
  db.prepare("INSERT INTO empresas (id, escritorio_id, documento, razao_social, cod_municipio, op_simp_nac, ambiente) VALUES (1, 1, '10512356000168', 'BARBIERI', '4208203', 3, 2)").run();

  assert.equal(T.listarImpostos().length, 11);

  // perfil de saída: ISS 5%, PIS retido 0,65% (vigência a partir de 2026-01-01), CBS 0,9% só em 2026
  const ps = T.criarPerfil(1, { nome: 'Serviço com retenção', itens: [
    { imposto_codigo: 'ISS', aliquota: 5, reducao_base: 0, retido: false },
    { imposto_codigo: 'PIS', aliquota: 0.65, reducao_base: 0, retido: true, vigencia_ini: '2026-01-01' },
    { imposto_codigo: 'CBS', aliquota: 0.9, reducao_base: 0, retido: false, vigencia_ini: '2026-01-01', vigencia_fim: '2026-12-31' },
    { imposto_codigo: 'CBS', aliquota: 8.8, reducao_base: 0, retido: false, vigencia_ini: '2027-01-01' },
  ] });
  const calc26 = T.calcularPerfil(ps.id, 1000, '2026-10-15');
  assert.equal(calc26.find((x) => x.imposto === 'ISS')!.valor, 50);
  assert.equal(calc26.find((x) => x.imposto === 'CBS')!.valor, 9);
  assert.equal(T.calcularPerfil(ps.id, 1000, '2027-03-01').find((x) => x.imposto === 'CBS')!.valor, 88);
  assert.equal(T.calcularPerfil(ps.id, 1000, '2025-12-31').find((x) => x.imposto === 'PIS'), undefined, 'antes da vigência');

  const tSaida = T.criarTipo(1, { nome: 'Serviço padrão', sentido: 'SAIDA', modelo: 'NFSE', natureza: 'Serviço', perfil_id: ps.id, gera_credito: false, destino: 'RECEITA', padrao: true });
  assert.throws(() => T.criarTipo(1, { nome: 'x1', sentido: 'SAIDA', modelo: 'NFE', gera_credito: false, destino: 'NENHUM', padrao: false }), /só de entrada/);
  assert.throws(() => T.excluirPerfil(1, ps.id), /usado por 1 tipo/);

  // perfil e tipo de entrada com crédito
  const pe = T.criarPerfil(1, { nome: 'Compra com ICMS', itens: [{ imposto_codigo: 'ICMS', aliquota: 18, reducao_base: 0, retido: false }, { imposto_codigo: 'CBS', aliquota: 0.9, reducao_base: 0, retido: false }] });
  const tEntrada = T.criarTipo(1, { nome: 'Revenda', sentido: 'ENTRADA', modelo: 'NFE', natureza: 'Mercadoria para revenda', perfil_id: pe.id, gera_credito: true, destino: 'DESPESA', padrao: true });
  assert.throws(() => T.conferirTipoDoVinculo(1, tEntrada.id, 'SAIDA'), /saída/);

  // serviço ligado ao tipo de saída: retenções vêm do perfil; sem retenção própria
  const sv = Number(db.prepare("INSERT INTO servicos (empresa_id, nome, descricao, c_trib_nac, aliquota, tipo_documento_id) VALUES (1,'Contábil','x','171901',5,?)").run(tSaida.id).lastInsertRowid);
  const ret = comRetencoesDoServico({ empresaId: 1, servicoId: sv, valor: 5000, competencia: '2026-10-01', descricao: 'x' } as any);
  assert.equal(ret.retencoes?.pis, 32.5);
  // retenção de até R$ 10,00 é dispensada (R$ 1.000 × 0,65% = 6,50)
  assert.equal(comRetencoesDoServico({ empresaId: 1, servicoId: sv, valor: 1000, competencia: '2026-10-01', descricao: 'x' } as any).retencoes?.pis, null);

  // tipo escolhido na própria nota prevalece sobre o do serviço; o perfil completa alíquota, ISSQN e IBS/CBS
  const pIbs = T.criarPerfil(1, { nome: 'Com IBS/CBS', trib_issqn: 1, municipio_prestacao: '4208203', itens: [
    { imposto_codigo: 'ISS', aliquota: 2, reducao_base: 0, retido: false },
    { imposto_codigo: 'CBS', aliquota: 0.9, reducao_base: 0, retido: false, cst: '000', c_class_trib: '000001' }] });
  const tIbs = T.criarTipo(1, { nome: 'Serviço IBS', sentido: 'SAIDA', modelo: 'NFSE', perfil_id: pIbs.id, ind_op: '100301', ind_final: 0, ind_dest: 0, gera_credito: false, destino: 'RECEITA', padrao: false });
  const e2 = comRetencoesDoServico({ empresaId: 1, servicoId: sv, tipoDocumentoId: tIbs.id, valor: 1000, competencia: '2026-10-01', descricao: 'x', tribISSQN: 1, issRetido: 1 } as any);
  assert.equal(e2.tipoDocumentoId, tIbs.id);
  assert.equal(e2.aliquota, 2);
  assert.equal(e2.municipioPrestacao, '4208203');
  assert.deepEqual(e2.ibscbs, { indFinal: 0, cIndOp: '100301', indDest: 0, cst: '000', cClassTrib: '000001' });
  assert.equal(e2.retencoes?.pis, undefined, 'o perfil escolhido não retém PIS');

  // nota autorizada do mês + compra importada
  db.prepare(`INSERT INTO notas (empresa_id, servico_id, ambiente, serie, n_dps, id_dps, status, competencia, valor_servico, descricao, payload_json, n_nfse, tomador_nome)
    VALUES (1, ?, 2, '1', 1, 'DPS1', 'AUTORIZADA', '2026-10-01', 1000, 'x', '{}', '77', 'Cliente X')`).run(sv);
  const comp = importarCompraXml(1, 1, { xml: nfe, gerarDespesas: false, categoria: 'x' });
  assert.equal(db.prepare('SELECT tipo_documento_id AS t FROM compras WHERE id = ?').get(comp.id)!.t, tEntrada.id, 'usa o tipo padrão de entrada');

  // gerar perfis a partir de serviços já cadastrados
  const sv2 = Number(db.prepare(`INSERT INTO servicos (empresa_id, nome, descricao, c_trib_nac, aliquota, tributacao_json) VALUES (1,'Antigo','x','171901',3,'{"pPis":0.65,"pCofins":3,"issRetido":2}')`).run().lastInsertRowid);
  const g = T.gerarPerfisDosServicos(1);
  assert.equal(g.perfisCriados, 1);
  assert.ok(db.prepare('SELECT tipo_documento_id AS t FROM servicos WHERE id = ?').get(sv2)!.t);
  const tipo2 = db.prepare('SELECT tipo_documento_id AS t FROM servicos WHERE id = ?').get(sv2)!.t as number;
  assert.equal(T.tributacaoEfetiva(tipo2)!.issRetido, 2);
  assert.equal(T.tributacaoEfetiva(tipo2)!.aliquota, 3);
  assert.equal(T.tributacaoCompletaDoServico(db.prepare('SELECT * FROM servicos WHERE id = ?').get(sv2)).tributacao.pPis, 0.65);
  assert.equal(T.gerarPerfisDosServicos(1).perfisCriados, 0, 'idempotente');
});
