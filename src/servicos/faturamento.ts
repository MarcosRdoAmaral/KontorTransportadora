import { z } from 'zod';
import { db } from '../db.js';
import type { Usuario } from '../auth.js';
import { ajustarVencimento } from './diautil.js';
import { EntradaEmissao, ErroNegocio, comRetencoesDoServico, emitir } from './emissao.js';
import { enviarMensagemBoleto, enviarNotaPorEmail } from './email.js';
import type { ItemLista } from './modelos-email.js';
import { exigirLicenca } from '../licenca.js';
import { boletoPdf, criarCobranca, demonstrativoPdf, listarCobrancas as listar, obterConta, obterCobranca, pendenciasPagador, referenciaDa, registrarEmailCobranca } from './cobranca.js';

export type Acao = 'NOTA' | 'NOTA_BOLETO' | 'BOLETO';

/** Dados para "emitir tudo com um comando": o que fazer vem do cadastro do cliente, salvo se informado. */
export const EntradaFaturamento = EntradaEmissao.extend({
  acao: z.enum(['NOTA', 'NOTA_BOLETO', 'BOLETO']).nullish(),
  /** Valor do boleto; padrão = valor líquido a receber (serviço − descontos − retenções). */
  valorBoleto: z.number().positive().nullish(),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  /** Parcelamento do boleto: um boleto por parcela, com o vencimento de cada uma. A soma deve fechar com o valor do boleto. */
  parcelas: z.array(z.object({ vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), valor: z.number().positive() })).min(1).max(24).nullish(),
  enviarEmail: z.boolean().nullish(),
  /** Carteira Pix: o código copia e cola gerado no banco para esta cobrança (uma parcela só). */
  pixCopiaCola: z.string().max(1000).nullish(),
});
export type EntradaFaturamento = z.infer<typeof EntradaFaturamento>;

const dataIso = (d: Date) => d.toISOString().slice(0, 10);

/** Vencimento a partir da regra do cliente: N dias após a emissão, ou dia fixo do mês (próxima ocorrência). */
export function calcularVencimento(base: Date, tipo: 'PRAZO' | 'DIA_FIXO', valor: number): string {
  if (tipo === 'PRAZO') return dataIso(new Date(base.getTime() + valor * 86400e3));
  const ultimoDia = (ano: number, mes: number) => new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  let ano = base.getUTCFullYear(), mes = base.getUTCMonth();
  let dia = Math.min(valor, ultimoDia(ano, mes));
  if (Date.UTC(ano, mes, dia) <= Date.UTC(ano, mes, base.getUTCDate())) {
    mes += 1;
    if (mes > 11) { mes = 0; ano += 1; }
    dia = Math.min(valor, ultimoDia(ano, mes));
  }
  return dataIso(new Date(Date.UTC(ano, mes, dia)));
}

/** Valor líquido a receber: serviço − descontos − retenções federais − ISS retido pelo tomador. */
export function valorLiquido(e: Pick<EntradaEmissao, 'valor' | 'descontoIncondicionado' | 'retencoes' | 'issRetido' | 'aliquota'>): number {
  const r = e.retencoes ?? {};
  const base = e.valor - (e.descontoIncondicionado ?? 0);
  const iss = e.issRetido === 2 ? Math.round(base * (e.aliquota ?? 0)) / 100 : 0;
  const ret = (r.irrf ?? 0) + (r.cp ?? 0) + (r.csll ?? 0) + (r.pis ?? 0) + (r.cofins ?? 0) + iss;
  return Math.round((base - ret) * 100) / 100;
}

export async function faturar(u: Usuario, entrada: EntradaFaturamento) {
  exigirLicenca();
  entrada = comRetencoesDoServico(entrada);
  const tomador = entrada.tomadorId
    ? (db.prepare('SELECT * FROM tomadores WHERE id = ? AND empresa_id = ?').get(entrada.tomadorId, entrada.empresaId) as any)
    : null;
  if (entrada.tomadorId && !tomador) throw new ErroNegocio('Cliente não encontrado para esta empresa.');
  const acao: Acao = entrada.acao ?? tomador?.modo_faturamento ?? 'NOTA';
  if (acao !== 'NOTA' && !tomador) throw new ErroNegocio('Escolha o cliente para gerar o boleto.');
  const fazNota = acao !== 'BOLETO';
  const fazBoleto = acao !== 'NOTA';

  if (fazBoleto && tomador?.desconto_valor > 0) {
    const base = entrada.parcelas?.[0]?.valor ?? entrada.valorBoleto ?? (fazNota ? valorLiquido(entrada) : entrada.valor);
    if (!(fazNota && (entrada.descontoIncondicionado ?? 0) >= tomador.desconto_valor) && base <= tomador.desconto_valor)
      throw new ErroNegocio(`O desconto cadastrado para ${tomador.nome} (R$ ${tomador.desconto_valor.toFixed(2).replace('.', ',')}) é maior ou igual ao valor do boleto. Ajuste o valor ou o desconto no cadastro do cliente.`);
  }
  const pixCarteira = tomador?.forma_cobranca === 'PIX';
  // confere o cadastro antes de emitir a nota, para não deixar a nota emitida sem o boleto
  if (fazBoleto && !pixCarteira && obterConta(entrada.empresaId)) {
    const falta = pendenciasPagador(tomador);
    if (falta.length) throw new ErroNegocio(`Para gerar o boleto, complete o cadastro de ${tomador.nome}: ${falta.join(', ')}.`);
    const venc = entrada.vencimento ?? calcularVencimento(new Date(Date.now() - 3 * 3600e3), tomador.vencimento_tipo, tomador.vencimento_valor);
    if (venc < new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)) throw new ErroNegocio('O vencimento do boleto não pode estar no passado.');
  }
  if (fazBoleto && entrada.parcelas?.length) {
    const total = entrada.valorBoleto ?? (fazNota ? valorLiquido(entrada) : entrada.valor);
    const soma = Math.round(entrada.parcelas.reduce((a, p) => a + p.valor, 0) * 100) / 100;
    if (Math.abs(soma - total) > 0.01) throw new ErroNegocio(`A soma das parcelas (R$ ${soma.toFixed(2).replace('.', ',')}) não fecha com o valor do boleto (R$ ${total.toFixed(2).replace('.', ',')}).`);
    const hojeIso = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    if (entrada.parcelas.some((p) => p.vencimento < hojeIso)) throw new ErroNegocio('Há parcela com vencimento no passado.');
  }

  const resultado: { acao: Acao; nota?: any; cobranca?: any; cobrancas?: any[]; email?: { status: 'ENVIADO' | 'ERRO' | 'NAO_ENVIADO'; para?: string; erro?: string }; avisos: string[] } = { acao, avisos: [] };

  if (fazNota) {
    resultado.nota = await emitir(u, entrada);
    if (resultado.nota.status !== 'AUTORIZADA') {
      if (fazBoleto) resultado.avisos.push('O boleto não foi gerado porque a nota não foi autorizada. Corrija a nota e tente novamente.');
      return resultado;
    }
  }

  if (fazBoleto) {
    const hoje = new Date(Date.now() - 3 * 3600e3);
    const feriados = (db.prepare('SELECT feriados_extra FROM empresas WHERE id = ?').get(entrada.empresaId) as any)?.feriados_extra;
    const parcelas = entrada.parcelas?.length
      ? entrada.parcelas
      : [{ vencimento: entrada.vencimento ?? calcularVencimento(hoje, tomador.vencimento_tipo, tomador.vencimento_valor), valor: entrada.valorBoleto ?? (fazNota ? valorLiquido(entrada) : entrada.valor) }];
    if (parcelas.some((p) => !(p.valor > 0))) throw new ErroNegocio('O valor do boleto precisa ser maior que zero.');
    // se a nota já foi emitida com desconto igual ou maior que o do cliente, o valor líquido já o contém; no parcelamento o desconto fixo vai só na 1ª parcela
    const jaNaNota = fazNota && (entrada.descontoIncondicionado ?? 0) >= (tomador.desconto_valor ?? 0);
    resultado.cobrancas = [];
    parcelas.forEach((p, i) => {
      const ajuste = ajustarVencimento(p.vencimento, dataIso(hoje), feriados);
      if (ajuste.aviso) resultado.avisos.push(parcelas.length > 1 ? `Parcela ${i + 1}: ${ajuste.aviso}` : ajuste.aviso);
      const c = criarCobranca({ empresaId: entrada.empresaId, tomadorId: tomador.id, notaId: resultado.nota?.id ?? null,
        descricao: parcelas.length > 1 ? `${entrada.descricao} (parcela ${i + 1}/${parcelas.length})`.slice(0, 2000) : entrada.descricao, valor: p.valor, vencimento: ajuste.data, usuarioId: u.id, semDesconto: jaNaNota || i > 0,
        pix: parcelas.length === 1 ? entrada.pixCopiaCola : null });
      resultado.cobrancas!.push(c);
    });
    resultado.cobranca = resultado.cobrancas[0];
    if (pixCarteira) {
      if (resultado.cobrancas.some((c) => !c.pix_copia_cola)) resultado.avisos.push('Cliente da carteira Pix: informe o Pix copia e cola em Cobranças para gerar o demonstrativo com o QR Code e enviar ao cliente.');
    } else if (resultado.cobrancas.some((c) => c.status === 'AGUARDANDO_BANCO')) {
      const c0 = resultado.cobrancas.find((c) => c.status === 'AGUARDANDO_BANCO');
      resultado.avisos.push(obterConta(entrada.empresaId)
        ? (c0.observacao_banco ?? 'O boleto ficou pendente.')
        : 'Boleto registrado como "aguardando banco": cadastre os dados bancários da empresa para gerar o boleto.');
    }
  }

  const queroEmail = entrada.enviarEmail ?? !!tomador?.enviar_email_auto;
  if (queroEmail) {
    const para = [tomador?.email, ...(tomador?.email_cobranca ?? '').split(/[,;\s]+/)].filter((x): x is string => !!x && /@/.test(x));
    const unicos = [...new Set(para.map((e) => e.toLowerCase()))].slice(0, 5);
    const cobs = (resultado.cobrancas ?? []).map((c) => obterCobranca(c.id));
    const cob = cobs[0] ?? null;
    const emitidos = cobs.filter((c) => c?.nosso_numero || (c?.forma === 'PIX' && c.pix_copia_cola));
    const temBoleto = emitidos.length > 0;
    if (!unicos.length) resultado.email = { status: 'ERRO', erro: 'O cliente não tem e-mail cadastrado.' };
    else if (!resultado.nota && !temBoleto) resultado.email = { status: 'NAO_ENVIADO', erro: pixCarteira ? 'Falta o Pix copia e cola: informe-o em Cobranças e envie de lá.' : 'O boleto ainda não foi gerado, então não há o que enviar.' };
    else {
      try {
        const extras: { filename: string; content: Buffer; contentType: string }[] = [];
        const boletos: ItemLista[] = [];
        for (const c of emitidos) {
          const pix = c.forma === 'PIX';
          const n = emitidos.length > 1 ? ` ${emitidos.indexOf(c) + 1}/${emitidos.length}` : '';
          if (!pix) { const b = await boletoPdf(c.id); extras.push({ filename: b.nome, content: b.pdf, contentType: 'application/pdf' }); }
          const dm = await demonstrativoPdf(c.id); extras.push({ filename: emitidos.length > 1 ? dm.nome.replace('.pdf', `_${emitidos.indexOf(c) + 1}.pdf`) : dm.nome, content: dm.pdf, contentType: 'application/pdf' });
          boletos.push({ rotulo: `${pix ? 'Cobrança Pix' : 'Boleto'}${n}`, valor: `R$ ${c.valor.toFixed(2).replace('.', ',')}`,
            detalhe: `Vencimento ${c.vencimento.split('-').reverse().join('/')} · ${pix ? `Pix copia e cola: ${c.pix_copia_cola}` : `Linha digitável ${c.linha_digitavel}`}` });
        }
        if (resultado.nota) await enviarNotaPorEmail(resultado.nota.id, u.escritorio_id, unicos, u.id, 'emissao', { extras, boletos });
        else await enviarMensagemBoleto(u.escritorio_id, unicos, cob, tomador, extras);
        for (const c of cobs) registrarEmailCobranca(c.id, 'ENVIADO', unicos.join(', '));
        resultado.email = { status: 'ENVIADO', para: unicos.join(', ') };
      } catch (e: any) {
        for (const c of cobs) registrarEmailCobranca(c.id, 'ERRO', unicos.join(', '));
        resultado.email = { status: 'ERRO', erro: String(e?.message ?? e) };
      }
    }
  }
  return resultado;
}

/** Só o boleto, a partir da tela de Cobranças (sem nota fiscal): mesmas regras e e-mail do faturamento. */
export const BoletoAvulso = z.object({
  tomadorId: z.number().int(),
  descricao: z.string().trim().min(2, 'Informe a descrição do boleto').max(2000),
  valor: z.number().positive('O valor precisa ser maior que zero'),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  enviarEmail: z.boolean().nullish(),
  pixCopiaCola: z.string().max(1000).nullish(),
});
export function gerarBoletoAvulso(u: Usuario, empresaId: number, d: z.infer<typeof BoletoAvulso>) {
  return faturar(u, { acao: 'BOLETO', empresaId, tomadorId: d.tomadorId, descricao: d.descricao, valor: d.valor, vencimento: d.vencimento, enviarEmail: d.enviarEmail, pixCopiaCola: d.pixCopiaCola } as EntradaFaturamento);
}

export const listarCobrancas = listar;

/** Envia (ou reenvia) uma cobrança por e-mail a partir da tela de Cobranças: boleto ou Pix, com o demonstrativo. */
export async function enviarCobrancaPorEmail(escritorioId: number, cobrancaId: number) {
  const c = obterCobranca(cobrancaId);
  if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
  if (c.status === 'CANCELADO') throw new ErroNegocio('Esta cobrança está cancelada.');
  if (c.forma === 'PIX' ? !c.pix_copia_cola : !c.nosso_numero) throw new ErroNegocio(c.forma === 'PIX' ? 'Informe o Pix copia e cola antes de enviar.' : (c.observacao_banco ?? 'O boleto ainda não foi gerado.'));
  const t = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(c.tomador_id) as any;
  const para = [...new Set([t.email, ...(t.email_cobranca ?? '').split(/[,;\s]+/)].filter((x: any) => x && /@/.test(x)).map((x: string) => x.toLowerCase()))].slice(0, 5) as string[];
  if (!para.length) throw new ErroNegocio('O cliente não tem e-mail cadastrado.');
  const anexos: { filename: string; content: Buffer; contentType: string }[] = [];
  if (c.forma !== 'PIX') { const b = await boletoPdf(c.id); anexos.push({ filename: b.nome, content: b.pdf, contentType: 'application/pdf' }); }
  const dm = await demonstrativoPdf(c.id); anexos.push({ filename: dm.nome, content: dm.pdf, contentType: 'application/pdf' });
  try { await enviarMensagemBoleto(escritorioId, para, { ...c, referencia: referenciaDa(c) }, t, anexos); }
  catch (e) { registrarEmailCobranca(c.id, 'ERRO', para.join(', ')); throw e; }
  registrarEmailCobranca(c.id, 'ENVIADO', para.join(', '));
  return { para: para.join(', ') };
}
