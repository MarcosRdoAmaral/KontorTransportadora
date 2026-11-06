/**
 * CNAB 400 do Ailos (ex-Cecred, banco 085).
 * O layout foi levantado a partir de arquivos reais de remessa e retorno do Ailos e conferido byte a byte
 * (ver test/ailos400.test.ts): o gerador reproduz a remessa de exemplo registro por registro.
 */
import { alfa, moeda, num, contaOitoDigitos, type ContaAilos, type DadosRemessa, type ItemRetorno } from './ailos.js';

class Registro400 {
  private c = Array<string>(400).fill(' ');
  set(de: number, ate: number, valor: string) {
    if (valor.length !== ate - de + 1) throw new Error(`Campo ${de}-${ate} com ${valor.length} caracteres (esperado ${ate - de + 1}).`);
    for (let i = 0; i < valor.length; i++) this.c[de - 1 + i] = valor[i];
    return this;
  }
  toString() { return this.c.join(''); }
}

const ddmmaa = (iso: string) => { const [a, m, d] = iso.split('-'); return `${d}${m}${a.slice(2)}`; };
const DIA = 86400e3;
const somaDia = (iso: string, n: number) => new Date(Date.parse(iso) + n * DIA).toISOString().slice(0, 10);
const tipo2 = (doc: string) => (doc.replace(/\D/g, '').length === 14 ? '02' : '01');
const doc14 = (doc: string) => num(doc.replace(/\D/g, ''), 14);
/** Arredondamento para centavos, meio para cima, sem erro de ponto flutuante. */
const centavos = (x: number) => Math.round(x + 1e-9) / 100;

/** Agência com DV em 5 posições (ex.: 0101 + 5 → 01015). */
const agenciaComDv = (c: Pick<ContaAilos, 'agencia' | 'agencia_dv'>) => num(c.agencia, 4) + alfa(c.agencia_dv, 1);

export function gerarRemessa400(d: DadosRemessa): string {
  const { beneficiario: b, conta: c } = d;
  const br = new Date(d.agora.getTime() - 3 * 3600e3);
  const data = ddmmaa(br.toISOString().slice(0, 10));
  const ag = agenciaComDv(c);
  const conta9 = num(contaOitoDigitos(c), 9);
  const conv7 = num(c.convenio, 7);
  let seq = 0;
  const linhas: string[] = [];

  linhas.push(new Registro400()
    .set(1, 2, '01').set(3, 9, 'REMESSA').set(10, 11, '01').set(12, 26, alfa('COBRANCA', 15))
    .set(27, 31, ag).set(32, 40, conta9).set(41, 46, '000000').set(47, 76, alfa(b.nome, 30))
    .set(77, 79, '085').set(80, 94, alfa('CECRED', 15)).set(95, 100, data).set(101, 107, num(d.numeroRemessa, 7))
    .set(130, 136, conv7).set(395, 400, num(++seq, 6)).toString());

  for (const t of d.titulos) {
    const pg = t.pagador;
    const baixa = t.movimento === 'BAIXA';
    const valorCent = Math.round(t.valor * 100);
    const juros = centavos((valorCent * t.jurosPctMes) / 100 / 30);
    linhas.push(new Registro400()
      .set(1, 1, '7').set(2, 3, tipo2(b.documento)).set(4, 17, doc14(b.documento)).set(18, 22, ag).set(23, 31, conta9).set(32, 38, conv7)
      .set(39, 63, alfa(String(t.idInterno), 25)).set(64, 80, alfa(t.nossoNumero, 17)).set(81, 84, '0000')
      .set(92, 101, '0010000000').set(107, 108, '01').set(109, 110, baixa ? '02' : '01').set(111, 120, alfa(String(t.idInterno), 10))
      .set(121, 126, ddmmaa(t.vencimento)).set(127, 139, moeda(t.valor, 13)).set(140, 142, '085').set(143, 146, '0000')
      .set(148, 149, '01').set(150, 150, 'N').set(151, 156, ddmmaa(t.emissao)).set(157, 160, '0000').set(161, 173, moeda(baixa ? 0 : juros, 13))
      .set(174, 179, !baixa && t.descontoPontual ? ddmmaa(t.descontoPontual.ate) : '000000').set(180, 192, moeda(!baixa && t.descontoPontual ? t.descontoPontual.valor : 0, 13)).set(193, 218, '0'.repeat(26)).set(219, 220, tipo2(pg.documento)).set(221, 234, doc14(pg.documento)).set(235, 274, alfa(pg.nome, 40))
      .set(275, 314, alfa(pg.endereco, 40)).set(315, 326, alfa(pg.bairro, 12)).set(327, 334, num(pg.cep, 8)).set(335, 349, alfa(pg.cidade, 15)).set(350, 351, alfa(pg.uf, 2))
      .set(395, 400, num(++seq, 6)).toString());
    if (!baixa && t.multaPct > 0) {
      linhas.push(new Registro400()
        .set(1, 1, '5').set(2, 3, '99').set(4, 4, '1').set(5, 10, ddmmaa(somaDia(t.vencimento, 1))).set(11, 22, moeda(centavos((Math.round(t.valor * 100) * t.multaPct) / 100), 12))
        .set(395, 400, num(++seq, 6)).toString());
    }
  }
  linhas.push(new Registro400().set(1, 1, '9').set(395, 400, num(++seq, 6)).toString());
  return linhas.join('\r\n') + '\r\n';
}

const dataIso = (s: string) => (/^\d{6}$/.test(s) && s !== '000000' ? `20${s.slice(4)}-${s.slice(2, 4)}-${s.slice(0, 2)}` : null);
const valor = (s: string) => Number(s) / 100;

export function lerRetorno400(linhas: string[]): { numeroRetorno: number | null; itens: ItemRetorno[] } {
  const h = linhas[0];
  if (h.slice(0, 2) !== '02' || h.slice(2, 9) !== 'RETORNO') throw new Error('O arquivo não é um retorno de cobrança (CNAB 400).');
  if (h.slice(76, 79) !== '085') throw new Error('O arquivo não é do Ailos (banco 085).');
  const itens: ItemRetorno[] = [];
  for (const l of linhas) {
    if (l[0] !== '7') continue;
    itens.push({
      nossoNumero: l.slice(63, 80).trim(), usoEmpresa: l.slice(38, 63).trim() || l.slice(116, 126).trim(), movimento: l.slice(108, 110),
      motivos: [], vencimento: dataIso(l.slice(146, 152)), valorTitulo: valor(l.slice(152, 165)), tarifa: 0,
      valorPago: valor(l.slice(305, 318)), dataOcorrencia: dataIso(l.slice(110, 116)), dataCredito: dataIso(l.slice(175, 181)),
    });
  }
  const nsa = Number(h.slice(100, 107));
  return { numeroRetorno: Number.isFinite(nsa) ? nsa : null, itens };
}
