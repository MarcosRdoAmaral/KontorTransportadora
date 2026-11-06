import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { ErroNegocio } from './emissao.js';
import { categoriasDoExtrato, chaveDescricao } from './extrato.js';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const dinheiro = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));
const ehDinheiro = (s: string) => /^-?\d{1,3}(\.\d{3})*,\d{2}$|^-?\d+,\d{2}$/.test(s);

// ---------------------------------------------------------------------------
// Leitura do PDF da fatura (layout homologado de emissor de cartão): colunas Data, Descrição, Crédito R$ e Débito R$
// ---------------------------------------------------------------------------
export type TipoCartao = 'COMPRA' | 'ANUIDADE' | 'ENCARGO' | 'CREDITO' | 'PAGAMENTO';
export interface ItemCartao {
  data: string; descricao: string; cidade: string | null; parcelaAtual: number | null; parcelaTotal: number | null;
  cartaoFinal: string | null; valor: number; tipo: TipoCartao;
}
export interface FaturaLida {
  referencia?: string; vencimento: string; titular?: string; contaCartao?: string;
  totalFatura?: number; pagamentoMinimo?: number; despesasDebito?: number; encargos?: number; pagamentoCredito?: number; saldoAnterior?: number;
  itens: ItemCartao[]; avisos: string[];
}
interface Item { x: number; y: number; fim: number; s: string }

/** Ano da compra: o mais recente em que dia/mês não passa do vencimento da fatura (compras parceladas vêm com a data original). */
export function anoDaCompra(ddmm: string, vencimento: string): string {
  const [d, m] = ddmm.split('/').map(Number);
  let ano = Number(vencimento.slice(0, 4));
  const iso = (a: number) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (iso(ano) > vencimento) ano -= 1;
  return iso(ano);
}

export async function lerPdfFatura(pdf: Buffer): Promise<FaturaLida> {
  // @ts-ignore — build "legacy" do pdf.js roda em Node sem navegador
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc: any;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, useSystemFonts: false }).promise; }
  catch { throw new ErroNegocio('Não foi possível abrir o PDF. Confira se é a fatura em PDF baixada do emissor do cartão.'); }

  const out: FaturaLida = { vencimento: '', itens: [], avisos: [] };
  const linhasTexto: string[] = [];
  let secao: 'FORA' | 'MOV' | 'GASTOS' = 'FORA';
  let final: string | null = null;
  const totaisSecao: number[] = [];
  const somaSecao: number[] = [];
  let ref: { fimCred: number } = { fimCred: 375 };

  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const itens: Item[] = (await pg.getTextContent()).items.filter((i: any) => i.str !== undefined)
      .map((i: any) => ({ x: i.transform[4], y: i.transform[5], fim: i.transform[4] + i.width, s: String(i.str) }));
    const linhas: { y: number; it: Item[] }[] = [];
    for (const it of [...itens].sort((a, b) => b.y - a.y)) {
      const l = linhas.find((k) => Math.abs(k.y - it.y) < 2.5);
      l ? l.it.push(it) : linhas.push({ y: it.y, it: [it] });
    }
    const txt = (it: Item[]) => [...it].sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim();

    for (const l of linhas) {
      const t = txt(l.it);
      if (!t) continue;
      linhasTexto.push(t);
      const cabCols = l.it.find((i) => /^Crédito R\$/.test(i.s.trim()));
      if (cabCols) ref = { fimCred: cabCols.fim };
      const venc = t.match(/FATURA DE (\S+) - VENCIMENTO: (\d{2}\/\d{2}\/\d{4})/);
      if (venc) { out.referencia = venc[1]; out.vencimento = venc[2].split('/').reverse().join('-'); continue; }
      if (/Emiss[ãa]o/.test(t) && !out.titular) { out.titular = t.split(' - ')[0].trim(); continue; }
      const cc = t.match(/Conta Cart[ãa]o:\s*(\d+)/); if (cc) { out.contaCartao = cc[1]; continue; }
      if (/^Movimenta[çc][ãa]o$/.test(t)) { secao = 'MOV'; continue; }
      const gastos = t.match(/^GASTOS DE .+\((\d{4})\)$/);
      if (gastos) { secao = 'GASTOS'; final = gastos[1]; somaSecao.push(0); continue; }
      if (/^TOTAL\b/.test(t) && secao === 'GASTOS') { const n = t.match(/[\d.]+,\d{2}/g); if (n) totaisSecao.push(dinheiro(n.at(-1)!)); secao = 'FORA'; continue; }
      if (/^SALDO ANTERIOR/.test(t) && secao === 'MOV') { const n = t.match(/[\d.]+,\d{2}$/); if (n) out.saldoAnterior = dinheiro(n[0]); continue; }
      const res = (re: RegExp) => { const m = t.match(re); return m ? dinheiro(m[1]) : undefined; };
      out.pagamentoCredito ??= res(/Pagamento \/ Crédito:\s*([\d.]+,\d{2})/);
      out.encargos ??= res(/^Encargos:\s*([\d.]+,\d{2})/) ?? res(/\bEncargos:\s*([\d.]+,\d{2})/);
      out.despesasDebito ??= res(/Despesas \/ Débito:\s*([\d.]+,\d{2})/);

      const data = l.it.find((i) => /^\d{2}\/\d{2}$/.test(i.s.trim()) && i.x < 70);
      if (!data || (secao !== 'MOV' && secao !== 'GASTOS')) continue;
      const valorIt = [...l.it].filter((i) => i.x > 330 && ehDinheiro(i.s.trim())).sort((a, b) => b.fim - a.fim)[0];
      if (!valorIt) { out.avisos.push(`Linha ignorada (sem valor): ${t.slice(0, 80)}`); continue; }
      const credito = valorIt.fim <= ref.fimCred + 8;
      const valorAbs = dinheiro(valorIt.s.trim());
      const desc = txt(l.it.filter((i) => i !== data && i !== valorIt && i.x >= 70 && i.x < 330));
      let tipo: TipoCartao = 'COMPRA';
      if (secao === 'MOV') tipo = credito ? (/PAGTO|PAGAMENTO/i.test(desc) ? 'PAGAMENTO' : 'CREDITO') : /ANUIDADE/i.test(desc) ? 'ANUIDADE' : 'ENCARGO';
      else if (credito) tipo = 'CREDITO';
      let descricao = desc, cidade: string | null = null, pa: number | null = null, pt: number | null = null;
      const par = desc.match(/\s(\d{2})\/(\d{2})(?:\s+(.*))?$/);
      if (par && Number(par[2]) >= Number(par[1]) && Number(par[2]) > 0) {
        descricao = desc.slice(0, par.index).trim(); pa = Number(par[1]); pt = Number(par[2]); cidade = par[3]?.trim() || null;
      }
      const valor = credito ? -valorAbs : valorAbs;
      if (secao === 'GASTOS' && !credito) somaSecao[somaSecao.length - 1] = r2((somaSecao.at(-1) ?? 0) + valorAbs);
      out.itens.push({ data: anoDaCompra(data.s.trim(), out.vencimento || '9999-12-31'), descricao: descricao || desc, cidade, parcelaAtual: pa, parcelaTotal: pt, cartaoFinal: secao === 'GASTOS' ? final : null, valor, tipo });
    }
  }
  if (!out.vencimento) throw new ErroNegocio('Não encontrei o vencimento da fatura. Este modelo de fatura ainda não é reconhecido pelo sistema.');
  // as datas dependem do vencimento, que vem no cabeçalho (antes dos lançamentos); refaz por segurança
  for (const it of out.itens) if (it.data.startsWith('9999')) throw new ErroNegocio('Não foi possível determinar as datas da fatura.');
  if (!out.itens.length) throw new ErroNegocio('Nenhum lançamento encontrado no PDF. Este modelo de fatura ainda não é reconhecido pelo sistema.');

  const i = linhasTexto.findIndex((t) => /Pagamento m[íi]nimo/.test(t));
  if (i >= 0) { const n = (linhasTexto[i + 1] ?? '').match(/[\d.]+,\d{2}/g); if (n && n.length >= 2) { out.pagamentoMinimo = dinheiro(n[0]!); out.totalFatura = dinheiro(n[1]!); } }

  // conferências com os totais impressos pela administradora
  totaisSecao.forEach((tt, k) => { if (somaSecao[k] != null && Math.abs(somaSecao[k] - tt) > 0.005) out.avisos.push(`O total lido de um bloco de gastos (${somaSecao[k]}) difere do total impresso (${tt}).`); });
  const compras = r2(out.itens.filter((x) => x.tipo === 'COMPRA').reduce((a, x) => a + x.valor, 0));
  if (out.despesasDebito != null && Math.abs(compras - out.despesasDebito) > 0.005) out.avisos.push(`Compras lidas (${compras}) diferem de "Despesas / Débito" da fatura (${out.despesasDebito}).`);
  const encLidos = r2(out.itens.filter((x) => x.tipo === 'ANUIDADE' || x.tipo === 'ENCARGO').reduce((a, x) => a + x.valor, 0));
  if (out.encargos != null && Math.abs(encLidos - out.encargos) > 0.005) out.avisos.push(`Encargos lidos (${encLidos}) diferem do resumo (${out.encargos}).`);
  if (out.totalFatura == null) out.avisos.push('Não encontrei o total da fatura; a conferência ficou só pelos blocos de gastos.');
  return out;
}

// ---------------------------------------------------------------------------
// Importação, classificação e espelho em despesas
// ---------------------------------------------------------------------------
function categoriaAutomatica(empresaId: number, it: ItemCartao): { categoria: string; origem: 'regra' | 'auto' } | null {
  if (it.valor <= 0) return null;
  const aprendida = db.prepare('SELECT categoria FROM extrato_regras WHERE empresa_id = ? AND chave = ?').get(empresaId, chaveDescricao(it.descricao)) as { categoria: string } | undefined;
  if (aprendida) return { categoria: aprendida.categoria, origem: 'regra' };
  if (it.tipo === 'ANUIDADE' || it.tipo === 'ENCARGO') return { categoria: 'Tarifas e juros', origem: 'auto' };
  return null;
}

export async function importarFatura(empresaId: number, nomeArquivo: string, pdf: Buffer) {
  const lida = await lerPdfFatura(pdf);
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  if (db.prepare('SELECT 1 FROM cartao_faturas WHERE empresa_id = ? AND hash = ?').get(empresaId, hash)) throw new ErroNegocio('Este arquivo já foi importado.');
  return db.transaction(() => {
    const fid = Number(db.prepare(`INSERT INTO cartao_faturas (empresa_id, arquivo, hash, referencia, vencimento, titular, conta_cartao, total_fatura, pagamento_minimo, despesas_debito, qtd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(empresaId, nomeArquivo.slice(0, 120), hash, lida.referencia ?? null, lida.vencimento, lida.titular ?? null, lida.contaCartao ?? null, lida.totalFatura ?? null, lida.pagamentoMinimo ?? null, lida.despesasDebito ?? null, lida.itens.length).lastInsertRowid);
    const ins = db.prepare(`INSERT OR IGNORE INTO cartao_lancamentos (empresa_id, fatura_id, data, descricao, cidade, parcela_atual, parcela_total, cartao_final, valor, tipo, categoria, categoria_origem, chave)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const vistos = new Map<string, number>();
    let novos = 0;
    for (const it of lida.itens) {
      const base = `${lida.contaCartao ?? ''}|${lida.vencimento}|${it.data}|${it.descricao}|${it.parcelaAtual ?? ''}|${it.valor}|${it.tipo}`;
      const n = (vistos.get(base) ?? 0) + 1; vistos.set(base, n);
      const c = categoriaAutomatica(empresaId, it);
      novos += Number(ins.run(empresaId, fid, it.data, it.descricao, it.cidade, it.parcelaAtual, it.parcelaTotal, it.cartaoFinal, it.valor, it.tipo, c?.categoria ?? null, c?.origem ?? null,
        crypto.createHash('sha1').update(base + '#' + n).digest('hex')).changes);
    }
    sincronizarDespesasDoCartao(empresaId);
    return { faturaId: fid, vencimento: lida.vencimento, lidos: lida.itens.length, novos, repetidos: lida.itens.length - novos, totalFatura: lida.totalFatura ?? null, avisos: lida.avisos };
  })();
}

export const ClassificacaoCartao = z.object({ categoria: z.string().trim().min(1, 'Informe a categoria').max(60).nullable(), aplicarSemelhantes: z.boolean().default(false) });

export function classificarCartao(empresaId: number, lid: number, d: z.infer<typeof ClassificacaoCartao>) {
  const l = db.prepare('SELECT * FROM cartao_lancamentos WHERE id = ? AND empresa_id = ?').get(lid, empresaId) as any;
  if (!l) throw new ErroNegocio('Lançamento não encontrado.', 404);
  if (l.valor <= 0) throw new ErroNegocio('Créditos e pagamentos da fatura não são classificados.');
  db.transaction(() => {
    db.prepare('UPDATE cartao_lancamentos SET categoria = ?, categoria_origem = ? WHERE id = ?').run(d.categoria, d.categoria ? 'manual' : null, lid);
    if (d.aplicarSemelhantes) {
      const k = chaveDescricao(l.descricao);
      // a mesma regra serve ao extrato bancário (o mesmo fornecedor costuma aparecer nos dois)
      if (d.categoria) db.prepare('INSERT INTO extrato_regras (empresa_id, chave, categoria) VALUES (?,?,?) ON CONFLICT(empresa_id, chave) DO UPDATE SET categoria = excluded.categoria').run(empresaId, k, d.categoria);
      else db.prepare('DELETE FROM extrato_regras WHERE empresa_id = ? AND chave = ?').run(empresaId, k);
      for (const o of db.prepare("SELECT id, descricao FROM cartao_lancamentos WHERE empresa_id = ? AND id <> ? AND valor > 0 AND categoria_origem IS NOT 'manual'").all(empresaId, lid) as any[])
        if (chaveDescricao(o.descricao) === k) db.prepare('UPDATE cartao_lancamentos SET categoria = ?, categoria_origem = ? WHERE id = ?').run(d.categoria, d.categoria ? 'regra' : null, o.id);
    }
    sincronizarDespesasDoCartao(empresaId);
  })();
}

/** Gastos classificados viram despesas (forma Crédito), na data do vencimento da fatura, que é quando o dinheiro sai. Anuidade abatida por desconto não vira despesa. */
export function sincronizarDespesasDoCartao(empresaId: number) {
  const lancs = db.prepare(`SELECT c.id, c.data, c.descricao, c.parcela_atual, c.parcela_total, c.valor, c.tipo, c.categoria, c.fatura_id, f.vencimento
    FROM cartao_lancamentos c JOIN cartao_faturas f ON f.id = c.fatura_id WHERE c.empresa_id = ?`).all(empresaId) as any[];
  // crédito de mesmo valor na mesma fatura cancela a tarifa (ex.: ANUIDADE x DESC ANUIDADE)
  const cancelados = new Set<number>();
  for (const cr of lancs.filter((x) => x.tipo === 'CREDITO')) {
    const par = lancs.find((x) => x.fatura_id === cr.fatura_id && (x.tipo === 'ANUIDADE' || x.tipo === 'ENCARGO') && !cancelados.has(x.id) && Math.abs(x.valor + cr.valor) < 0.005);
    if (par) cancelados.add(par.id);
  }
  const espelhos = new Map((db.prepare("SELECT id, cartao_lancamento_id AS lid FROM despesas WHERE empresa_id = ? AND origem = 'CARTAO'").all(empresaId) as any[]).map((x) => [x.lid, x.id]));
  const ins = db.prepare("INSERT INTO despesas (empresa_id, data, categoria, descricao, valor, forma_pagamento, origem, cartao_lancamento_id) VALUES (?,?,?,?,?,'CREDITO','CARTAO',?)");
  const upd = db.prepare('UPDATE despesas SET data = ?, categoria = ?, descricao = ?, valor = ? WHERE id = ?');
  const vivos = new Set<number>();
  const dataBr = (d: string) => d.split('-').reverse().join('/');
  for (const l of lancs) {
    if (!l.categoria || l.valor <= 0 || !['COMPRA', 'ANUIDADE', 'ENCARGO'].includes(l.tipo) || cancelados.has(l.id)) continue;
    vivos.add(l.id);
    const descricao = `${l.descricao}${l.parcela_total ? ` (${l.parcela_atual}/${l.parcela_total})` : ''} · compra ${dataBr(l.data)}`.slice(0, 200);
    const ex = espelhos.get(l.id);
    if (ex) upd.run(l.vencimento, l.categoria, descricao, l.valor, ex);
    else ins.run(empresaId, l.vencimento, l.categoria, descricao, l.valor, l.id);
  }
  for (const [lid, did] of espelhos) if (!vivos.has(lid)) db.prepare('DELETE FROM despesas WHERE id = ?').run(did);
}

export function faturasDoMes(empresaId: number, mes: string) {
  const faturas = db.prepare('SELECT * FROM cartao_faturas WHERE empresa_id = ? AND substr(vencimento,1,7) = ? ORDER BY vencimento, id').all(empresaId, mes) as any[];
  const lancs = db.prepare(`SELECT c.*, f.vencimento FROM cartao_lancamentos c JOIN cartao_faturas f ON f.id = c.fatura_id
    WHERE c.empresa_id = ? AND substr(f.vencimento,1,7) = ? ORDER BY f.vencimento, c.cartao_final, c.data, c.id`).all(empresaId, mes) as any[];
  const gastos = lancs.filter((l) => l.valor > 0);
  return {
    mes, faturas, lancamentos: lancs,
    totalGastos: r2(gastos.reduce((s, l) => s + l.valor, 0)),
    semClassificacao: gastos.filter((l) => !l.categoria).length,
    meses: (db.prepare('SELECT DISTINCT substr(vencimento,1,7) AS m FROM cartao_faturas WHERE empresa_id = ? ORDER BY m DESC').all(empresaId) as { m: string }[]).map((x) => x.m),
    categorias: categoriasDoExtrato(empresaId).saidas,
  };
}

export function excluirFatura(empresaId: number, id: number) {
  if (!db.prepare('SELECT 1 FROM cartao_faturas WHERE id = ? AND empresa_id = ?').get(id, empresaId)) throw new ErroNegocio('Fatura não encontrada.', 404);
  db.transaction(() => {
    db.prepare("DELETE FROM despesas WHERE empresa_id = ? AND origem = 'CARTAO' AND cartao_lancamento_id IN (SELECT id FROM cartao_lancamentos WHERE fatura_id = ?)").run(empresaId, id);
    db.prepare('DELETE FROM cartao_lancamentos WHERE fatura_id = ?').run(id);
    db.prepare('DELETE FROM cartao_faturas WHERE id = ?').run(id);
  })();
}
