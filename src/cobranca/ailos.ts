/**
 * Cobrança bancária Ailos (banco 085) – boleto e CNAB 240.
 * Baseado no "Manual Técnico de Cobrança Bancária – CNAB 240" do Sistema Ailos (versão 09, abr/2021).
 */

/** Identificação do banco impressa no boleto deste convênio. */
export const BANCO_BOLETO = { nome: 'AILOS', subtitulo: 'SISTEMA DE COOPERATIVAS DE CRÉDITO', localPagamento: 'Pagar preferencialmente nas cooperativas do Sistema AILOS.' };

// ---------------------------------------------------------------------------
// Formatação de campos
// ---------------------------------------------------------------------------
const SEM_ACENTO = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Alfanumérico: maiúsculo, sem acento, alinhado à esquerda e completado com brancos. */
export const alfa = (v: unknown, n: number) => SEM_ACENTO(String(v ?? '')).toUpperCase().replace(/[^\x20-\x7E]/g, ' ').slice(0, n).padEnd(n, ' ');
/** Numérico: só dígitos, à direita e completado com zeros. */
export const num = (v: unknown, n: number) => {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length > n) throw new Error(`Valor numérico "${d}" não cabe em ${n} posições.`);
  return d.padStart(n, '0');
};
/** Valor em reais com 2 decimais implícitos. */
export const moeda = (v: number, n: number) => num(Math.round(v * 100), n);
/** DDMMAAAA a partir de AAAA-MM-DD. */
export const dataBr8 = (iso: string) => { const [a, m, d] = iso.split('-'); return `${d}${m}${a}`; };
const ZERO_DATA = '00000000';

class Registro {
  private c = Array<string>(240).fill(' ');
  /** Posições de 1 a 240, como no manual. */
  set(de: number, ate: number, valor: string) {
    if (valor.length !== ate - de + 1) throw new Error(`Campo ${de}-${ate} com ${valor.length} caracteres (esperado ${ate - de + 1}).`);
    for (let i = 0; i < valor.length; i++) this.c[de - 1 + i] = valor[i];
    return this;
  }
  toString() { return this.c.join(''); }
}

// ---------------------------------------------------------------------------
// Boleto: nosso número, código de barras e linha digitável
// ---------------------------------------------------------------------------
export interface ContaAilos {
  cooperativa_nome: string;
  agencia: string; agencia_dv: string;
  conta: string; conta_dv: string;
  convenio: string;
  carteira: string;
}

/** Conta corrente com DV em 8 dígitos (7 + DV). Ex.: 0220665-8 → 02206658. */
export const contaOitoDigitos = (c: Pick<ContaAilos, 'conta' | 'conta_dv'>) => num(c.conta, 7) + num(c.conta_dv, 1);
/** Nosso número: 8 dígitos da conta + 9 do boleto = 17 dígitos. */
export const nossoNumero = (c: Pick<ContaAilos, 'conta' | 'conta_dv'>, boleto: number) => contaOitoDigitos(c) + num(boleto, 9);

const DIA = 86400e3;
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DIA);
/** Fator de vencimento: base 07/10/1997 até 21/02/2025; reinicia em 1000 em 22/02/2025. */
export function fatorVencimento(iso: string): string {
  let f = iso <= '2025-02-21' ? dias('1997-10-07', iso) : 1000 + dias('2025-02-22', iso);
  while (f > 9999) f -= 9000;
  if (f < 1000) throw new Error('Vencimento fora do intervalo aceito pelo código de barras.');
  return String(f);
}

function mod10(s: string): number {
  let soma = 0, peso = 2;
  for (let i = s.length - 1; i >= 0; i--) {
    const p = Number(s[i]) * peso;
    soma += p > 9 ? Math.floor(p / 10) + (p % 10) : p;
    peso = peso === 2 ? 1 : 2;
  }
  const r = soma % 10;
  return r === 0 ? 0 : 10 - r;
}
function mod11(s: string): number {
  let soma = 0, peso = 2;
  for (let i = s.length - 1; i >= 0; i--) { soma += Number(s[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const dv = 11 - (soma % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

/** Código de barras de 44 posições. */
export function codigoBarras(c: ContaAilos, boleto: number, vencimento: string, valor: number): string {
  const livre = num(c.convenio, 6) + contaOitoDigitos(c) + num(boleto, 9) + num(c.carteira, 2); // 25 posições
  const sem = '085' + '9' + fatorVencimento(vencimento) + moeda(valor, 10) + livre;
  const dv = mod11(sem);
  return sem.slice(0, 4) + dv + sem.slice(4);
}

/** Linha digitável: AAAAA.AAAAA BBBBB.BBBBBB CCCCC.CCCCCC D EEEEEEEEEEEEEE */
export function linhaDigitavel(barras: string): string {
  const c1 = barras.slice(0, 4) + barras.slice(19, 24);
  const c2 = barras.slice(24, 34);
  const c3 = barras.slice(34, 44);
  const f = (c: string) => c + mod10(c);
  const a = f(c1), b = f(c2), d = f(c3);
  return `${a.slice(0, 5)}.${a.slice(5)} ${b.slice(0, 5)}.${b.slice(5)} ${d.slice(0, 5)}.${d.slice(5)} ${barras[4]} ${barras.slice(5, 19)}`;
}

// ---------------------------------------------------------------------------
// Remessa CNAB 240
// ---------------------------------------------------------------------------
export interface Beneficiario { documento: string; nome: string }
export interface Titulo {
  /** Código para identificar o título na empresa (vai em "uso da empresa"). */
  idInterno: number;
  nossoNumero: string;
  numeroDocumento: string;
  vencimento: string; // AAAA-MM-DD
  valor: number;
  emissao: string;    // AAAA-MM-DD
  multaPct: number;
  jurosPctMes: number;
  /** Desconto fixo até a data (código 1 do segmento P), calculado do percentual do cliente. */
  descontoPontual?: { valor: number; ate: string } | null;
  mensagens: string[];
  pagador: { documento: string; nome: string; endereco: string; bairro: string; cep: string; cidade: string; uf: string };
  /** 'ENTRADA' = 01 | 'BAIXA' = 02 */
  movimento: 'ENTRADA' | 'BAIXA';
}
export interface DadosRemessa { beneficiario: Beneficiario; conta: ContaAilos; numeroRemessa: number; agora: Date; titulos: Titulo[]; mensagemLote?: string[] }

const tipoInsc = (doc: string) => (doc.replace(/\D/g, '').length === 14 ? '2' : '1');
const docNum = (doc: string, n: number) => num(doc.replace(/\D/g, ''), n);
const hoje = (d: Date) => new Date(d.getTime() - 3 * 3600e3);
const somaDia = (iso: string, n: number) => new Date(Date.parse(iso) + n * DIA).toISOString().slice(0, 10);

export function gerarRemessa(d: DadosRemessa): string {
  const { beneficiario: b, conta: c } = d;
  const br = hoje(d.agora);
  const dataArq = dataBr8(br.toISOString().slice(0, 10));
  const hora = br.toISOString().slice(11, 19).replace(/:/g, '');
  const agencia = num(c.agencia, 5), conta12 = num(c.conta, 12);
  const linhas: string[] = [];

  linhas.push(new Registro()
    .set(1, 3, '085').set(4, 7, '0000').set(8, 8, '0').set(9, 17, ' '.repeat(9))
    .set(18, 18, tipoInsc(b.documento)).set(19, 32, docNum(b.documento, 14))
    .set(33, 52, alfa(c.convenio, 20)).set(53, 57, agencia).set(58, 58, alfa(c.agencia_dv, 1))
    .set(59, 70, conta12).set(71, 71, alfa(c.conta_dv, 1)).set(72, 72, ' ')
    .set(73, 102, alfa(b.nome, 30)).set(103, 132, alfa(c.cooperativa_nome || 'AILOS', 30)).set(133, 142, ' '.repeat(10))
    .set(143, 143, '1').set(144, 151, dataArq).set(152, 157, hora).set(158, 163, num(d.numeroRemessa, 6))
    .set(164, 166, '087').set(167, 171, '00000').set(172, 191, ' '.repeat(20)).set(192, 211, ' '.repeat(20)).set(212, 240, ' '.repeat(29))
    .toString());

  const msgLote = d.mensagemLote ?? [];
  linhas.push(new Registro()
    .set(1, 3, '085').set(4, 7, '0001').set(8, 8, '1').set(9, 9, 'R').set(10, 11, '01').set(12, 13, '  ').set(14, 16, '045').set(17, 17, ' ')
    .set(18, 18, tipoInsc(b.documento)).set(19, 33, docNum(b.documento, 15)).set(34, 53, alfa(c.convenio, 20))
    .set(54, 58, agencia).set(59, 59, alfa(c.agencia_dv, 1)).set(60, 71, conta12).set(72, 72, alfa(c.conta_dv, 1)).set(73, 73, ' ')
    .set(74, 103, alfa(b.nome, 30)).set(104, 143, alfa(msgLote[0], 40)).set(144, 183, alfa(msgLote[1], 40))
    .set(184, 191, num(d.numeroRemessa, 8)).set(192, 199, dataArq).set(200, 207, ZERO_DATA).set(208, 240, ' '.repeat(33))
    .toString());

  let seq = 0, qtdSimples = 0, totalSimples = 0;
  for (const t of d.titulos) {
    const mov = t.movimento === 'BAIXA' ? '02' : '01';
    const cab = (r: Registro, seg: string) => r.set(1, 3, '085').set(4, 7, '0001').set(8, 8, '3').set(9, 13, num(++seq, 5)).set(14, 14, seg).set(15, 15, ' ').set(16, 17, mov);
    const diaSeguinte = dataBr8(somaDia(t.vencimento, 1));
    const p = cab(new Registro(), 'P')
      .set(18, 22, agencia).set(23, 23, alfa(c.agencia_dv, 1)).set(24, 35, conta12).set(36, 36, alfa(c.conta_dv, 1)).set(37, 37, ' ')
      .set(38, 57, alfa(t.nossoNumero, 20)).set(58, 58, '1').set(59, 59, '1').set(60, 60, '1').set(61, 61, '2').set(62, 62, '2')
      .set(63, 77, alfa(t.numeroDocumento, 15)).set(78, 85, dataBr8(t.vencimento)).set(86, 100, moeda(t.valor, 15))
      .set(101, 105, '00000').set(106, 106, '0').set(107, 108, '04').set(109, 109, 'N').set(110, 117, dataBr8(t.emissao))
      .set(118, 118, t.jurosPctMes > 0 ? '2' : '3').set(119, 126, t.jurosPctMes > 0 ? diaSeguinte : ZERO_DATA).set(127, 141, moeda(t.jurosPctMes, 15))
      .set(142, 142, t.descontoPontual ? '1' : '0').set(143, 150, t.descontoPontual ? dataBr8(t.descontoPontual.ate) : ZERO_DATA).set(151, 165, moeda(t.descontoPontual?.valor ?? 0, 15)).set(166, 180, moeda(0, 15)).set(181, 195, moeda(0, 15))
      .set(196, 220, alfa(`KG${t.idInterno}`, 25)).set(221, 221, '3').set(222, 223, '00').set(224, 224, '2').set(225, 227, '   ')
      .set(228, 229, '09').set(230, 239, '0'.repeat(10)).set(240, 240, ' ');
    linhas.push(p.toString());

    const pg = t.pagador;
    const cep = pg.cep.replace(/\D/g, '').padStart(8, '0');
    linhas.push(cab(new Registro(), 'Q')
      .set(18, 18, tipoInsc(pg.documento)).set(19, 33, docNum(pg.documento, 15)).set(34, 73, alfa(pg.nome, 40))
      .set(74, 113, alfa(pg.endereco, 40)).set(114, 128, alfa(pg.bairro, 15)).set(129, 133, cep.slice(0, 5)).set(134, 136, cep.slice(5))
      .set(137, 151, alfa(pg.cidade, 15)).set(152, 153, alfa(pg.uf, 2))
      .set(154, 154, '0').set(155, 169, '0'.repeat(15)).set(170, 209, ' '.repeat(40)).set(210, 212, '000').set(213, 232, ' '.repeat(20)).set(233, 240, ' '.repeat(8))
      .toString());

    if (t.movimento === 'ENTRADA' && (t.multaPct > 0 || t.mensagens.length)) {
      linhas.push(cab(new Registro(), 'R')
        .set(18, 18, '0').set(19, 26, ZERO_DATA).set(27, 41, moeda(0, 15)).set(42, 42, '0').set(43, 50, ZERO_DATA).set(51, 65, moeda(0, 15))
        .set(66, 66, t.multaPct > 0 ? '2' : '0').set(67, 74, t.multaPct > 0 ? diaSeguinte : ZERO_DATA).set(75, 89, moeda(t.multaPct, 15))
        .set(90, 99, ' '.repeat(10)).set(100, 139, alfa(t.mensagens[0], 40)).set(140, 179, alfa(t.mensagens[1], 40)).set(180, 199, ' '.repeat(20))
        .set(200, 207, '0'.repeat(8)).set(208, 210, '000').set(211, 215, '00000').set(216, 216, ' ').set(217, 228, '0'.repeat(12)).set(229, 229, ' ').set(230, 230, ' ')
        .set(231, 231, '0').set(232, 240, ' '.repeat(9))
        .toString());
    }
    if (t.movimento === 'ENTRADA') { qtdSimples++; totalSimples += t.valor; }
  }

  const qtdLote = linhas.length - 1 + 1; // registros do lote = tudo menos o header de arquivo, mais o trailer de lote
  linhas.push(new Registro()
    .set(1, 3, '085').set(4, 7, '0001').set(8, 8, '5').set(9, 17, ' '.repeat(9))
    .set(18, 23, num(qtdLote, 6)).set(24, 29, num(qtdSimples, 6)).set(30, 46, moeda(totalSimples, 17))
    .set(47, 52, '000000').set(53, 69, moeda(0, 17)).set(70, 75, '000000').set(76, 92, moeda(0, 17)).set(93, 98, '000000').set(99, 115, moeda(0, 17))
    .set(116, 123, ' '.repeat(8)).set(124, 240, ' '.repeat(117))
    .toString());
  linhas.push(new Registro()
    .set(1, 3, '085').set(4, 7, '9999').set(8, 8, '9').set(9, 17, ' '.repeat(9))
    .set(18, 23, '000001').set(24, 29, num(linhas.length + 1, 6)).set(30, 35, '000000').set(36, 240, ' '.repeat(205))
    .toString());
  return linhas.join('\r\n') + '\r\n';
}

import { lerRetorno400 } from './ailos400.js';

// ---------------------------------------------------------------------------
// Retorno CNAB 240 (segmentos T e U)
// ---------------------------------------------------------------------------
export interface ItemRetorno {
  nossoNumero: string;
  usoEmpresa: string;
  movimento: string;
  motivos: string[];
  vencimento: string | null;
  valorTitulo: number;
  tarifa: number;
  valorPago?: number;
  valorLiquido?: number;
  jurosMulta?: number;
  dataOcorrencia?: string | null;
  dataCredito?: string | null;
}
const dataIso = (s: string) => (/^\d{8}$/.test(s) && s !== ZERO_DATA ? `${s.slice(4)}-${s.slice(2, 4)}-${s.slice(0, 2)}` : null);
const valor = (s: string) => Number(s) / 100;

/** Lê um retorno do Ailos em CNAB 400 ou CNAB 240 (identificado pelo tamanho das linhas). */
export function lerRetornoAuto(texto: string): { numeroRetorno: number | null; itens: ItemRetorno[]; layout: 'CNAB240' | 'CNAB400' } {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim().length);
  if (!linhas.length) throw new Error('Arquivo vazio.');
  if (linhas.every((l) => l.length === 400)) return { ...lerRetorno400(linhas), layout: 'CNAB400' };
  return { ...lerRetorno(texto), layout: 'CNAB240' };
}

export function lerRetorno(texto: string): { numeroRetorno: number | null; itens: ItemRetorno[] } {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim().length);
  if (!linhas.length) throw new Error('Arquivo vazio.');
  if (linhas.some((l) => l.length !== 240)) throw new Error('O arquivo não está no formato CNAB 240 nem CNAB 400 (as linhas devem ter 240 ou 400 posições).');
  if (linhas[0].slice(0, 3) !== '085' || linhas[0][7] !== '0') throw new Error('O arquivo não é um retorno do Ailos (banco 085).');
  if (linhas[0][142] !== '2') throw new Error('Este arquivo é uma remessa, não um retorno.');
  const itens: ItemRetorno[] = [];
  let atual: ItemRetorno | null = null;
  for (const l of linhas) {
    if (l[7] !== '3') continue;
    const seg = l[13];
    if (seg === 'T') {
      const mot = l.slice(213, 223);
      atual = {
        nossoNumero: l.slice(37, 57).trim(), usoEmpresa: l.slice(105, 130).trim(), movimento: l.slice(15, 17),
        motivos: [0, 2, 4, 6, 8].map((i) => mot.slice(i, i + 2).trim()).filter(Boolean),
        vencimento: dataIso(l.slice(73, 81)), valorTitulo: valor(l.slice(81, 96)), tarifa: valor(l.slice(198, 213)),
      };
      itens.push(atual);
    } else if (seg === 'U' && atual) {
      atual.jurosMulta = valor(l.slice(17, 32));
      atual.valorPago = valor(l.slice(77, 92));
      atual.valorLiquido = valor(l.slice(92, 107));
      atual.dataOcorrencia = dataIso(l.slice(137, 145));
      atual.dataCredito = dataIso(l.slice(145, 153));
    }
  }
  const nsa = Number(linhas[0].slice(157, 163));
  return { numeroRetorno: Number.isFinite(nsa) ? nsa : null, itens };
}

export const MOVIMENTO_RETORNO: Record<string, string> = {
  '02': 'Entrada confirmada', '03': 'Entrada rejeitada', '06': 'Liquidação', '09': 'Baixa', '17': 'Liquidação após baixa',
  '26': 'Instrução rejeitada', '28': 'Débito de tarifas/custas', '76': 'Liquidação', '77': 'Liquidação após baixa', '91': 'Título em aberto não enviado ao pagador',
};
export const MOTIVOS_REJEICAO: Record<string, string> = {
  '01': 'Código do banco inválido', '04': 'Código de movimento não permitido para a carteira', '05': 'Código de movimento inválido',
  '06': 'Tipo/número de inscrição do beneficiário inválidos', '07': 'Agência/conta/DV inválido', '08': 'Nosso número inválido', '09': 'Nosso número duplicado',
  '10': 'Carteira inválida', '11': 'Forma de cadastramento do título inválida', '12': 'Tipo de documento inválido', '13': 'Identificação da emissão do boleto inválida',
  '14': 'Identificação da distribuição do boleto inválida', '15': 'Características da cobrança incompatíveis', '16': 'Data de vencimento inválida',
  '17': 'Data de vencimento anterior à data de emissão', '18': 'Vencimento fora do prazo de operação', '20': 'Valor do título inválido', '21': 'Espécie do título inválida',
  '22': 'Espécie do título não permitida para a carteira', '23': 'Aceite inválido', '24': 'Data da emissão inválida', '25': 'Data da emissão posterior à data de entrada',
  '26': 'Código de juros de mora inválido', '27': 'Valor/taxa de juros de mora inválido', '28': 'Código do desconto inválido', '29': 'Valor do desconto maior ou igual ao valor do título',
  '37': 'Código para protesto inválido', '38': 'Prazo para protesto inválido', '42': 'Código para baixa/devolução inválido', '43': 'Prazo para baixa/devolução inválido',
  '44': 'Código da moeda inválido', '45': 'Nome do pagador não informado', '46': 'Tipo/número de inscrição do pagador inválidos', '47': 'Endereço do pagador não informado',
  '48': 'CEP inválido', '49': 'CEP sem praça de cobrança', '51': 'CEP incompatível com a UF', '52': 'UF inválida', '57': 'Código da multa inválido', '58': 'Data da multa inválida',
  '59': 'Valor/percentual da multa inválido', '60': 'Movimento para título não cadastrado', '63': 'Entrada para título já cadastrado', '86': 'Seu número inválido',
  '96': 'Número do convênio inválido', 'A5': 'Título já liquidado', 'A7': 'Título já se encontra na situação pretendida', 'BI': 'Beneficiário divergente',
};
export const descreverMotivo = (m: string) => MOTIVOS_REJEICAO[m] ? `${m} – ${MOTIVOS_REJEICAO[m]}` : m;

// ---------------------------------------------------------------------------
// Código de barras ITF (2 de 5 intercalado) para o boleto
// ---------------------------------------------------------------------------
const ITF = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn'];
/** Sequência alternada barra/espaço com larguras em módulos (estreito=1, largo=3). */
export function barrasItf(digitos: string): number[] {
  if (!/^\d+$/.test(digitos) || digitos.length % 2) throw new Error('ITF exige quantidade par de dígitos.');
  const larg = (c: string) => (c === 'w' ? 3 : 1);
  const out = [1, 1, 1, 1]; // início: barra, espaço, barra, espaço (estreitos)
  for (let i = 0; i < digitos.length; i += 2) {
    const a = ITF[Number(digitos[i])], b = ITF[Number(digitos[i + 1])];
    for (let k = 0; k < 5; k++) out.push(larg(a[k]), larg(b[k]));
  }
  out.push(3, 1, 1); // fim: barra larga, espaço, barra
  return out;
}
