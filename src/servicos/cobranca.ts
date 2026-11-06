import { z } from 'zod';
import { db } from '../db.js';
import { ajustarVencimento } from './diautil.js';
import { ErroNegocio } from './emissao.js';
import { gerarRemessa400 } from '../cobranca/ailos400.js';
import { BANCO_BOLETO, codigoBarras, descreverMotivo, gerarRemessa, lerRetornoAuto, linhaDigitavel, nossoNumero, MOVIMENTO_RETORNO, type ContaAilos, type Titulo } from '../cobranca/ailos.js';
import { gerarBoletoPdf } from '../cobranca/boleto-pdf.js';
import { gerarDemonstrativoPdf } from '../cobranca/demonstrativo-pdf.js';
import { lerPix, montarPix } from '../cobranca/pix.js';

const UF_IBGE: Record<string, string> = { '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO', '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF' };
const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const soDig = (s: string) => s.replace(/\D/g, '');

// ---------------------------------------------------------------------------
// Conta bancária (convênio de cobrança com remessa e retorno)
// ---------------------------------------------------------------------------
export const ContaBancaria = z.object({
  cooperativa_nome: z.string().trim().min(2, 'Informe o nome da cooperativa').max(30),
  agencia: z.string().transform(soDig).refine((v) => v.length >= 1 && v.length <= 5, 'Agência: até 5 dígitos'),
  agencia_dv: z.string().trim().length(1, 'Informe o dígito da agência'),
  conta: z.string().transform(soDig).refine((v) => v.length >= 1 && v.length <= 7, 'Conta: até 7 dígitos, sem o dígito verificador'),
  conta_dv: z.string().trim().length(1, 'Informe o dígito da conta').regex(/^\d$/, 'O dígito da conta deve ser numérico'),
  convenio: z.string().transform(soDig).refine((v) => v.length >= 1 && v.length <= 6, 'Convênio: até 6 dígitos').transform((v) => v.padStart(6, '0')),
  carteira: z.string().transform(soDig).refine((v) => v.length >= 1 && v.length <= 2, 'Carteira: 2 dígitos').transform((v) => v.padStart(2, '0')).default('01'),
  multa_pct: z.number().min(0).max(20).default(2),
  juros_pct_mes: z.number().min(0).max(20).default(1),
  instrucoes: z.string().max(40, 'A instrução cabe em 40 caracteres').nullish(),
  layout: z.enum(['CNAB400', 'CNAB240']).default('CNAB400'),
  /** Só para quem já emitia boletos em outro sistema: continua a numeração (nunca pode repetir um nosso número já usado). */
  proximo_boleto: z.number().int().min(1).max(999999999).nullish(),
  proxima_remessa: z.number().int().min(1).max(9999999).nullish(),
});
export type ContaBancaria = z.infer<typeof ContaBancaria>;

export function obterConta(empresaId: number): (ContaBancaria & { proximo_boleto: number; proxima_remessa: number }) | null {
  return (db.prepare('SELECT * FROM contas_bancarias WHERE empresa_id = ?').get(empresaId) as any) ?? null;
}

export function salvarConta(empresaId: number, d: ContaBancaria) {
  const atual = obterConta(empresaId);
  const usados = (db.prepare('SELECT COUNT(*) AS n FROM cobrancas WHERE empresa_id = ? AND nosso_numero IS NOT NULL').get(empresaId) as { n: number }).n;
  const remessasFeitas = (db.prepare('SELECT COUNT(*) AS n FROM remessas WHERE empresa_id = ?').get(empresaId) as { n: number }).n;
  const pb = d.proximo_boleto ?? atual?.proximo_boleto ?? 1, pr = d.proxima_remessa ?? atual?.proxima_remessa ?? 1;
  if (atual && usados && pb < atual.proximo_boleto) throw new ErroNegocio(`O próximo número de boleto não pode voltar (atual: ${atual.proximo_boleto}): repetiria um nosso número.`);
  if (atual && remessasFeitas && pr < atual.proxima_remessa) throw new ErroNegocio(`O número da próxima remessa não pode voltar (atual: ${atual.proxima_remessa}).`);
  db.prepare(`INSERT INTO contas_bancarias (empresa_id, cooperativa_nome, agencia, agencia_dv, conta, conta_dv, convenio, carteira, multa_pct, juros_pct_mes, instrucoes, layout, proximo_boleto, proxima_remessa)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(empresa_id) DO UPDATE SET layout=excluded.layout, proximo_boleto=excluded.proximo_boleto, proxima_remessa=excluded.proxima_remessa, cooperativa_nome=excluded.cooperativa_nome, agencia=excluded.agencia, agencia_dv=excluded.agencia_dv, conta=excluded.conta, conta_dv=excluded.conta_dv,
      convenio=excluded.convenio, carteira=excluded.carteira, multa_pct=excluded.multa_pct, juros_pct_mes=excluded.juros_pct_mes, instrucoes=excluded.instrucoes, atualizado_em=datetime('now')`)
    .run(empresaId, d.cooperativa_nome, d.agencia, d.agencia_dv, d.conta, d.conta_dv, d.convenio, d.carteira, d.multa_pct, d.juros_pct_mes, d.instrucoes || null, d.layout, pb, pr);
  // quem já tem boleto emitido não pode trocar de conta (o nosso número inclui a conta)
  if (atual && (atual.conta !== d.conta || atual.conta_dv !== d.conta_dv || atual.convenio !== d.convenio)) {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM cobrancas WHERE empresa_id = ? AND nosso_numero IS NOT NULL AND status NOT IN ('PAGO','CANCELADO','REJEITADO')").get(empresaId) as { n: number }).n;
    if (n) throw new ErroNegocio(`Existem ${n} boleto(s) em aberto emitidos com a conta/convênio anteriores. Quite ou cancele esses boletos antes de trocar a conta.`);
  }
  if (!usaCora(empresaId)) for (const c of db.prepare("SELECT id FROM cobrancas WHERE empresa_id = ? AND status = 'AGUARDANDO_BANCO' AND vencimento >= ? AND cora_id IS NULL").all(empresaId, hojeBr()) as { id: number }[]) {
    try { gerarTitulo(c.id); } catch { /* cadastro do cliente incompleto: segue pendente */ }
  }
  return obterConta(empresaId);
}

const contaAilos = (c: any): ContaAilos => ({ cooperativa_nome: c.cooperativa_nome, agencia: c.agencia, agencia_dv: c.agencia_dv, conta: c.conta, conta_dv: c.conta_dv, convenio: c.convenio, carteira: c.carteira });

// ---------------------------------------------------------------------------
// Cobranças
// ---------------------------------------------------------------------------
/** Itens do cadastro do cliente que o boleto exige. */
export function pendenciasPagador(t: any): string[] {
  const f: string[] = [];
  if (!t.documento || t.tipo_doc === 'SEM') f.push('CPF/CNPJ');
  if (!t.logradouro) f.push('logradouro');
  if (!t.cep || soDig(t.cep).length !== 8) f.push('CEP');
  if (!t.bairro) f.push('bairro');
  if (!t.cidade) f.push('cidade');
  if (!(t.uf || UF_IBGE[String(t.cod_municipio ?? '').slice(0, 2)])) f.push('UF');
  return f;
}

/**
 * `valor` é o valor ANTES do desconto do cliente. O desconto fixo cadastrado no cliente (motivo + valor) é abatido aqui,
 * para valer em todo boleto dele; `semDesconto` evita abater duas vezes quando a nota já carrega o mesmo desconto.
 */
export function criarCobranca(d: { empresaId: number; tomadorId: number; notaId: number | null; descricao: string; valor: number; vencimento: string; usuarioId: number; semDesconto?: boolean; pix?: string | null }) {
  const t = db.prepare('SELECT forma_cobranca, desconto_valor, desconto_motivo, multa_pct, juros_pct_mes, desc_pontual_pct, desc_pontual_dias FROM tomadores WHERE id = ?').get(d.tomadorId) as { forma_cobranca: 'BOLETO' | 'PIX'; desconto_valor: number | null; desconto_motivo: string | null; multa_pct: number | null; juros_pct_mes: number | null; desc_pontual_pct: number | null; desc_pontual_dias: number | null } | undefined;
  const desconto = !d.semDesconto && t?.desconto_valor && t.desconto_valor > 0 ? Math.round(t.desconto_valor * 100) / 100 : 0;
  if (desconto && desconto >= d.valor) throw new ErroNegocio(`O desconto do cliente (R$ ${desconto.toFixed(2).replace('.', ',')}) é maior ou igual ao valor do boleto. Ajuste o valor ou o desconto no cadastro do cliente.`);
  const valor = Math.round((d.valor - desconto) * 100) / 100;
  if (valor > 99999999.99) throw new ErroNegocio('Valor do boleto acima do limite.');
  const forma = t?.forma_cobranca ?? 'BOLETO';
  const pix = forma === 'PIX' && d.pix?.trim() ? conferirPix(d.pix, valor) : null;
  const pixProprio = forma === 'PIX' && !pix ? configPix(d.empresaId) : null; // Pix gerado pelo Kontor com a chave da empresa
  const r = db.prepare(`INSERT INTO cobrancas (empresa_id, tomador_id, nota_id, descricao, valor, vencimento, emissao, criado_por, desconto, desconto_motivo, multa_pct, juros_pct_mes, desc_pontual_pct, desc_pontual_dias, forma, pix_copia_cola, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(d.empresaId, d.tomadorId, d.notaId, d.descricao, valor, d.vencimento, hojeBr(), d.usuarioId, desconto, desconto ? t!.desconto_motivo : null, t?.multa_pct ?? null, t?.juros_pct_mes ?? null, t?.desc_pontual_pct ?? null, t?.desc_pontual_dias ?? null,
      forma, pix, pix ? 'REGISTRADO' : 'AGUARDANDO_BANCO');
  const id = Number(r.lastInsertRowid);
  if (pixProprio?.ativo) { try { gerarPixCobranca(id); } catch { /* fica pendente, para informar o Pix */ } }
  if (!pix && usaCora(d.empresaId)) { import('./cora.js').then((m) => m.emitirEmSegundoPlano(id)); }
  else if (forma === 'BOLETO' && obterConta(d.empresaId)) { try { gerarTitulo(id); } catch { /* fica pendente, com o motivo na tela */ } }
  return obterCobranca(id)!;
}

/** A empresa tem conta Cora ativa: as novas cobranças são registradas na Cora, não em remessa. */
export const usaCora = (empresaId: number) => !!db.prepare('SELECT 1 FROM contas_cora WHERE empresa_id = ? AND ativa = 1').get(empresaId);

/** Reserva o número do boleto e calcula nosso número, código de barras e linha digitável. */
export function gerarTitulo(cobrancaId: number) {
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(cobrancaId) as any;
  if (!c || c.status !== 'AGUARDANDO_BANCO' || c.forma === 'PIX' || c.cora_id) return;
  const conta = obterConta(c.empresa_id);
  if (!conta) return;
  const t = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(c.tomador_id) as any;
  const falta = pendenciasPagador(t);
  if (falta.length) {
    db.prepare('UPDATE cobrancas SET observacao_banco = ? WHERE id = ?').run(`Complete o cadastro do cliente: ${falta.join(', ')}.`, cobrancaId);
    throw new ErroNegocio(`Para gerar o boleto, complete o cadastro de ${t.nome}: ${falta.join(', ')}.`);
  }
  if (c.vencimento < hojeBr()) throw new ErroNegocio('O vencimento do boleto não pode estar no passado.');
  db.transaction(() => {
    const numero = (db.prepare('SELECT proximo_boleto AS n FROM contas_bancarias WHERE empresa_id = ?').get(c.empresa_id) as { n: number }).n;
    db.prepare('UPDATE contas_bancarias SET proximo_boleto = proximo_boleto + 1 WHERE empresa_id = ?').run(c.empresa_id);
    const ca = contaAilos(conta);
    const barras = codigoBarras(ca, numero, c.vencimento, c.valor);
    db.prepare(`UPDATE cobrancas SET status = 'A_REMETER', numero_boleto = ?, nosso_numero = ?, codigo_barras = ?, linha_digitavel = ?, observacao_banco = NULL WHERE id = ?`)
      .run(numero, nossoNumero(ca, numero), barras, linhaDigitavel(barras), cobrancaId);
  })();
}

export function obterCobranca(id: number) {
  return db.prepare(`SELECT c.*, t.nome AS tomador_nome, t.email AS tomador_email, n.n_nfse FROM cobrancas c
    JOIN tomadores t ON t.id = c.tomador_id LEFT JOIN notas n ON n.id = c.nota_id WHERE c.id = ?`).get(id) as any;
}

export function listarCobrancas(empresaId: number) {
  return db.prepare(`SELECT c.id, c.nota_id, c.tomador_id, c.descricao, c.valor, c.vencimento, c.status, c.nosso_numero, c.linha_digitavel, c.baixa_pendente, c.pago_em, c.valor_pago,
      c.observacao_banco, c.email_status, c.email_para, c.criado_em, c.forma, c.pix_copia_cola, c.desconto, c.desconto_motivo, t.nome AS tomador_nome, t.fone AS tomador_fone, c.codigo_barras, n.n_nfse FROM cobrancas c
    JOIN tomadores t ON t.id = c.tomador_id LEFT JOIN notas n ON n.id = c.nota_id
    WHERE c.empresa_id = ? ORDER BY c.vencimento DESC, c.id DESC LIMIT 500`).all(empresaId);
}

/** Multa, juros e desconto por pontualidade deste boleto: o que o cliente tem cadastrado, senão o da conta bancária. */
export function condicoesDoBoleto(conta: any, c: any) {
  const multa = c?.multa_pct ?? conta.multa_pct ?? 0, juros = c?.juros_pct_mes ?? conta.juros_pct_mes ?? 0;
  let pontual: { valor: number; ate: string } | null = null;
  if (c?.desc_pontual_pct > 0 && c.valor > 0) {
    const ate = new Date(Date.parse(c.vencimento) - (c.desc_pontual_dias ?? 0) * 86400e3).toISOString().slice(0, 10);
    const valor = Math.round(c.valor * c.desc_pontual_pct) / 100;
    if (valor > 0 && valor < c.valor && ate >= (c.emissao ?? c.criado_em?.slice(0, 10) ?? '0000')) pontual = { valor, ate };
  }
  return { multa: Number(multa), juros: Number(juros), pontual };
}

function mensagens(conta: any, c?: any): string[] {
  const m: string[] = [];
  const semAcento = (x: string) => x.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const cond = condicoesDoBoleto(conta, c);
  if (cond.pontual) m.push(semAcento(`DESCONTO DE R$ ${cond.pontual.valor.toFixed(2).replace('.', ',')} SE PAGO ATE ${cond.pontual.ate.split('-').reverse().join('/')}`).slice(0, 40));
  if (c?.desconto && c.desconto > 0) m.push(semAcento(`DESCONTO CONCEDIDO R$ ${c.desconto.toFixed(2).replace('.', ',')} - ${c.desconto_motivo ?? ''}`).slice(0, 40));
  if (conta.instrucoes) m.push(String(conta.instrucoes).slice(0, 40));
  const f = (n: number) => String(n).replace('.', ',');
  if (cond.juros > 0 || cond.multa > 0) {
    const partes = [cond.juros > 0 && `JUROS ${f(cond.juros)}% AO MES`, cond.multa > 0 && `MULTA ${f(cond.multa)}%`].filter(Boolean);
    m.push(`APOS VENCIMENTO: ${partes.join(' + ')}`.slice(0, 40));
  }
  return m;
}

export async function boletoPdf(cobrancaId: number): Promise<{ pdf: Buffer; nome: string }> {
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(cobrancaId) as any;
  if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
  if (c.cora_id) return (await import('./cora.js')).pdfDaCora(cobrancaId);
  if (!c.nosso_numero) throw new ErroNegocio(c.observacao_banco ?? 'Este boleto ainda não foi gerado: configure os dados bancários da empresa.');
  const conta = obterConta(c.empresa_id)!;
  const emp = db.prepare('SELECT razao_social, documento FROM empresas WHERE id = ?').get(c.empresa_id) as any;
  const t = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(c.tomador_id) as any;
  const end = [t.logradouro, t.numero].filter(Boolean).join(', ') + (t.complemento ? ` - ${t.complemento}` : '');
  const uf = t.uf || UF_IBGE[String(t.cod_municipio ?? '').slice(0, 2)] || '';
  const pdf = await gerarBoletoPdf({
    beneficiario: { nome: emp.razao_social, documento: emp.documento },
    agenciaCodigo: `${conta.agencia.padStart(4, '0')}-${conta.agencia_dv} / ${conta.conta}-${conta.conta_dv}`,
    pagador: { nome: t.nome, documento: t.documento ?? '', endereco: `${end} - ${t.bairro ?? ''} - ${soDig(t.cep ?? '').replace(/(\d{5})(\d{3})/, '$1-$2')} ${t.cidade ?? ''}/${uf}` },
    nossoNumero: c.nosso_numero, numeroDocumento: c.nota_id ? `NFS-e ${(db.prepare('SELECT n_nfse FROM notas WHERE id = ?').get(c.nota_id) as any)?.n_nfse ?? ''}`.trim() : `COB ${c.id}`,
    vencimento: c.vencimento, valor: c.valor, emissao: c.emissao ?? c.criado_em.slice(0, 10), carteira: conta.carteira,
    instrucoes: mensagens(conta, c).length ? mensagens(conta, c) : ['Não receber após o vencimento sem consultar o beneficiário.'],
    linhaDigitavel: c.linha_digitavel, codigoBarras: c.codigo_barras, banco: BANCO_BOLETO,
  });
  return { pdf, nome: `Boleto_${c.nosso_numero}.pdf` };
}

// ---------------------------------------------------------------------------
// Carteira Pix: o escritório gera a cobrança Pix no banco e cola o código aqui
// ---------------------------------------------------------------------------
// ---- Pix gerado pelo Kontor com a chave Pix da empresa (InfinitePay ou qualquer banco): BR Code estático ----
export const TIPOS_CHAVE_PIX = { CNPJ: 'CNPJ', CPF: 'CPF', EMAIL: 'E-mail', TELEFONE: 'Celular', ALEATORIA: 'Chave aleatória' } as const;
export const ConfigPix = z.object({
  ativo: z.boolean(),
  tipo: z.enum(Object.keys(TIPOS_CHAVE_PIX) as [keyof typeof TIPOS_CHAVE_PIX]),
  chave: z.string().trim().min(1, 'Informe a chave Pix').max(77),
  nome: z.string().trim().min(1, 'Informe o nome do recebedor').max(60),
  cidade: z.string().trim().min(1, 'Informe a cidade').max(40),
});
const P_PIX = (empresaId: number) => `pix_kontor:${empresaId}`;
const semAcentoPix = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 .\-]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();

/** Chave no formato do Banco Central: CPF/CNPJ só números, celular +55DDDNÚMERO, e-mail e chave aleatória em minúsculas. */
export function normalizarChavePix(tipo: keyof typeof TIPOS_CHAVE_PIX, chave: string): string {
  const so = chave.replace(/\D/g, '');
  if (tipo === 'CPF') { if (so.length !== 11) throw new ErroNegocio('CPF da chave Pix deve ter 11 números.'); return so; }
  if (tipo === 'CNPJ') { if (so.length !== 14) throw new ErroNegocio('CNPJ da chave Pix deve ter 14 números.'); return so; }
  if (tipo === 'TELEFONE') {
    const n = so.length === 13 && so.startsWith('55') ? so.slice(2) : so;
    if (!/^\d{2}9?\d{8}$/.test(n)) throw new ErroNegocio('Celular da chave Pix: informe DDD e número, ex.: (47) 99901-7034.');
    return `+55${n}`;
  }
  if (tipo === 'EMAIL') { const e = chave.trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ErroNegocio('E-mail da chave Pix inválido.'); return e; }
  const evp = chave.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(evp)) throw new ErroNegocio('Chave aleatória inválida: copie a chave completa (36 caracteres, com os hífens) do aplicativo do banco.');
  return evp;
}

export function configPix(empresaId: number): (z.infer<typeof ConfigPix> & { pendentes?: number }) | null {
  const v = (db.prepare('SELECT valor FROM parametros WHERE nome = ?').get(P_PIX(empresaId)) as any)?.valor;
  return v ? JSON.parse(v) : null;
}
export function configPixPublica(empresaId: number) {
  const c = configPix(empresaId);
  const pendentes = (db.prepare("SELECT COUNT(*) AS n FROM cobrancas WHERE empresa_id = ? AND forma = 'PIX' AND status = 'AGUARDANDO_BANCO'").get(empresaId) as any).n;
  return { config: c, pendentes, tipos: TIPOS_CHAVE_PIX };
}
export function salvarConfigPix(empresaId: number, d: z.infer<typeof ConfigPix>) {
  const chave = normalizarChavePix(d.tipo, d.chave);
  const nova = { ativo: d.ativo, tipo: d.tipo, chave, nome: semAcentoPix(d.nome).slice(0, 25), cidade: semAcentoPix(d.cidade).slice(0, 15) };
  if (!nova.nome || !nova.cidade) throw new ErroNegocio('Informe o nome do recebedor e a cidade (sem só símbolos).');
  db.prepare('INSERT INTO parametros (nome, valor) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor = excluded.valor').run(P_PIX(empresaId), JSON.stringify(nova));
  return configPixPublica(empresaId);
}

/** Gera o Pix copia e cola da cobrança com a chave da empresa (valor fixo, identificador KONTOR + número da cobrança). */
export function gerarPixCobranca(id: number) {
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(id) as any;
  if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
  if (c.forma !== 'PIX') throw new ErroNegocio('Esta cobrança é da carteira de boleto.');
  if (c.status === 'PAGO' || c.status === 'CANCELADO') throw new ErroNegocio('Esta cobrança já está encerrada.');
  const cfg = configPix(c.empresa_id);
  if (!cfg) throw new ErroNegocio('Cadastre a chave Pix da empresa em Cadastros > Empresas > Dados bancários.');
  const codigo = montarPix({ chave: cfg.chave, valor: c.valor, nome: cfg.nome, cidade: cfg.cidade, txid: `KONTOR${id}` });
  db.prepare("UPDATE cobrancas SET pix_copia_cola = ?, status = 'REGISTRADO', observacao_banco = NULL WHERE id = ?").run(conferirPix(codigo, c.valor), id);
  return obterCobranca(id);
}

/** Gera o Pix de todas as cobranças Pix pendentes da empresa. */
export function gerarPixPendentes(empresaId: number) {
  const ids = (db.prepare("SELECT id FROM cobrancas WHERE empresa_id = ? AND forma = 'PIX' AND status = 'AGUARDANDO_BANCO'").all(empresaId) as { id: number }[]).map((x) => x.id);
  for (const id of ids) gerarPixCobranca(id);
  return { gerados: ids.length };
}

/** Confere o Pix copia e cola e devolve o código limpo; recusa se o valor do Pix for diferente do da cobrança. */
export function conferirPix(codigo: string, valor: number): string {
  let p;
  try { p = lerPix(codigo); } catch (e: any) { throw new ErroNegocio(e.message); }
  if (p.valor != null && Math.abs(p.valor - valor) > 0.009)
    throw new ErroNegocio(`O valor deste Pix (R$ ${p.valor.toFixed(2).replace('.', ',')}) é diferente do valor da cobrança (R$ ${valor.toFixed(2).replace('.', ',')}). Gere o Pix com o valor certo ou ajuste a cobrança.`);
  return p.codigo;
}
export function informarPix(id: number, codigo: string) {
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(id) as any;
  if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
  if (c.forma !== 'PIX') throw new ErroNegocio('Esta cobrança é da carteira de boleto.');
  if (c.status === 'PAGO' || c.status === 'CANCELADO') throw new ErroNegocio('Esta cobrança já está encerrada.');
  const pix = conferirPix(codigo, c.valor);
  const lido = lerPix(pix);
  db.prepare("UPDATE cobrancas SET pix_copia_cola = ?, status = 'REGISTRADO', observacao_banco = NULL WHERE id = ?").run(pix, id);
  return { ...obterCobranca(id), pix_lido: { valor: lido.valor, recebedor: lido.recebedor, cidade: lido.cidade, chave: lido.chave } };
}

/** Referência do demonstrativo: a competência da nota, senão o mês anterior ao vencimento. */
export function referenciaDa(c: any): string {
  const comp = c.nota_id ? (db.prepare('SELECT competencia FROM notas WHERE id = ?').get(c.nota_id) as any)?.competencia : null;
  if (comp) return `${comp.slice(5, 7)}/${comp.slice(0, 4)}`;
  const [a, m] = c.vencimento.split('-').map(Number);
  return m === 1 ? `12/${a - 1}` : `${String(m - 1).padStart(2, '0')}/${a}`;
}

/** Demonstrativo de cobrança (PDF) nos moldes do escritório: serviços, total e o Pix (QR Code) ou o boleto. */
export async function demonstrativoPdf(cobrancaId: number): Promise<{ pdf: Buffer; nome: string }> {
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(cobrancaId) as any;
  if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
  if (c.forma === 'PIX' && !c.pix_copia_cola) throw new ErroNegocio('Informe o Pix copia e cola desta cobrança para gerar o demonstrativo.');
  const e = db.prepare('SELECT * FROM empresas WHERE id = ?').get(c.empresa_id) as any;
  const t = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(c.tomador_id) as any;
  const ufT = t.uf || UF_IBGE[String(t.cod_municipio ?? '').slice(0, 2)] || '';
  const endT = [[t.logradouro, t.numero ? `nº ${t.numero}` : null].filter(Boolean).join(', '), t.complemento, t.bairro, t.cidade ? `${t.cidade}${ufT ? '/' + ufT : ''}` : null].filter(Boolean).join(', ');
  const endE = [[e.logradouro, e.numero ? `nº ${e.numero}` : null].filter(Boolean).join(', '), e.bairro, e.cidade ? `${e.cidade}${e.uf ? '/' + e.uf : ''}` : null].filter(Boolean).join(', ');
  const bruto = Math.round((c.valor + (c.desconto ?? 0)) * 100) / 100;
  const nome = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  const referencia = referenciaDa(c);
  const pdf = await gerarDemonstrativoPdf({
    emitente: { nome: e.nome_fantasia || e.razao_social, documento: e.documento, endereco: endE, contato: e.email ?? '', logo: e.logo ? Buffer.from(e.logo) : null },
    cliente: { nome: t.nome, documento: t.documento ?? '', endereco: endT },
    referencia, vencimento: c.vencimento,
    itens: [{ descricao: c.descricao, qtd: 1, valor: bruto }],
    desconto: c.desconto > 0 ? { valor: c.desconto, motivo: c.desconto_motivo } : null,
    total: c.valor,
    pix: c.forma === 'PIX' ? c.pix_copia_cola : null,
    boleto: c.forma === 'BOLETO' && c.linha_digitavel && c.codigo_barras ? { linhaDigitavel: c.linha_digitavel, codigoBarras: c.codigo_barras } : null,
    rodape: e.demonstrativo_rodape,
  });
  return { pdf, nome: `Demonstrativo_Cobranca_${nome(t.nome)}_${referencia.replace('/', '-')}.pdf` };
}

export function cancelarCobranca(id: number) {
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(id) as any;
  if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
  if (c.status === 'PAGO' || c.status === 'CANCELADO') throw new ErroNegocio('Esta cobrança já está encerrada.');
  if (c.forma === 'PIX' || c.status === 'AGUARDANDO_BANCO' || c.status === 'A_REMETER' || c.status === 'REJEITADO') {
    db.prepare("UPDATE cobrancas SET status = 'CANCELADO' WHERE id = ?").run(id);
    return { baixaNoBanco: false };
  }
  db.prepare('UPDATE cobrancas SET baixa_pendente = 1 WHERE id = ?').run(id); // pedido de baixa vai na próxima remessa
  return { baixaNoBanco: true };
}

export function marcarPago(id: number, data?: string, valor?: number) {
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(id) as any;
  if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
  if (c.status === 'PAGO' || c.status === 'CANCELADO') throw new ErroNegocio('Esta cobrança já está encerrada.');
  db.prepare("UPDATE cobrancas SET status = 'PAGO', pago_em = ?, valor_pago = ?, baixa_pendente = 0 WHERE id = ?").run(data ?? hojeBr(), valor ?? c.valor, id);
}

export function registrarEmailCobranca(id: number, status: 'ENVIADO' | 'ERRO', para: string) {
  db.prepare("UPDATE cobrancas SET email_status = ?, email_para = ?, email_em = datetime('now') WHERE id = ?").run(status, para, id);
}

// ---------------------------------------------------------------------------
// Remessa e retorno
// ---------------------------------------------------------------------------
export function gerarRemessaEmpresa(empresaId: number, usuarioId: number) {
  const conta = obterConta(empresaId);
  if (!conta) throw new ErroNegocio('Configure os dados bancários da empresa antes de gerar a remessa.');
  const emp = db.prepare('SELECT razao_social, documento FROM empresas WHERE id = ?').get(empresaId) as any;
  const linhas = db.prepare(`SELECT c.*, t.nome AS t_nome, t.documento AS t_doc, t.logradouro, t.numero, t.complemento, t.bairro, t.cep, t.cidade, t.uf, t.cod_municipio
    FROM cobrancas c JOIN tomadores t ON t.id = c.tomador_id
    WHERE c.empresa_id = ? AND ((c.status = 'A_REMETER') OR (c.baixa_pendente = 1 AND c.status IN ('REMETIDO','REGISTRADO'))) ORDER BY c.id`).all(empresaId) as any[];
  if (!linhas.length) throw new ErroNegocio('Não há boletos novos nem baixas para enviar ao banco.');
  const titulos: Titulo[] = linhas.map((c) => ({
    idInterno: c.id, nossoNumero: c.nosso_numero, numeroDocumento: c.nota_id ? `NFSE ${(db.prepare('SELECT n_nfse FROM notas WHERE id = ?').get(c.nota_id) as any)?.n_nfse ?? c.id}` : `COB ${c.id}`,
    vencimento: c.vencimento, valor: c.valor, emissao: c.emissao ?? c.criado_em.slice(0, 10),
    multaPct: condicoesDoBoleto(conta, c).multa, jurosPctMes: condicoesDoBoleto(conta, c).juros, descontoPontual: condicoesDoBoleto(conta, c).pontual, mensagens: mensagens(conta, c), movimento: c.status === 'A_REMETER' ? 'ENTRADA' : 'BAIXA',
    pagador: { documento: c.t_doc, nome: c.t_nome, endereco: [c.logradouro, c.numero].filter(Boolean).join(', ') + (c.complemento ? ` - ${c.complemento}` : ''), bairro: c.bairro ?? '', cep: c.cep ?? '', cidade: c.cidade ?? '', uf: c.uf || UF_IBGE[String(c.cod_municipio ?? '').slice(0, 2)] || '' },
  }));
  const numero = conta.proxima_remessa;
  const gerar = (conta as any).layout === 'CNAB240' ? gerarRemessa : gerarRemessa400;
  const conteudo = gerar({ beneficiario: { documento: emp.documento, nome: emp.razao_social }, conta: contaAilos(conta), numeroRemessa: numero, agora: new Date(), titulos });
  const entradas = linhas.filter((c) => c.status === 'A_REMETER');
  const total = entradas.reduce((a, c) => a + c.valor, 0);
  const brHoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('');
  const hojeN = (db.prepare("SELECT COUNT(*) AS n FROM remessas WHERE empresa_id = ? AND nome_arquivo LIKE ?").get(empresaId, `${brHoje}%`) as { n: number }).n;
  const nome = `${brHoje}${hojeN ? `_${hojeN + 1}` : ''}.rem`;
  return db.transaction(() => {
    db.prepare('UPDATE contas_bancarias SET proxima_remessa = proxima_remessa + 1 WHERE empresa_id = ?').run(empresaId);
    const r = db.prepare('INSERT INTO remessas (empresa_id, numero, nome_arquivo, conteudo, qtd_titulos, valor_total, criado_por) VALUES (?,?,?,?,?,?,?)')
      .run(empresaId, numero, nome, conteudo, linhas.length, total, usuarioId);
    const rid = Number(r.lastInsertRowid);
    for (const c of linhas) {
      if (c.status === 'A_REMETER') db.prepare("UPDATE cobrancas SET status = 'REMETIDO', remessa_id = ? WHERE id = ?").run(rid, c.id);
      else db.prepare('UPDATE cobrancas SET baixa_pendente = 2 WHERE id = ?').run(c.id);
    }
    return { id: rid, numero, nome_arquivo: nome, qtd_titulos: linhas.length, entradas: entradas.length, baixas: linhas.length - entradas.length, valor_total: total };
  })();
}

export const listarRemessas = (empresaId: number) =>
  db.prepare('SELECT id, numero, nome_arquivo, qtd_titulos, valor_total, criado_em FROM remessas WHERE empresa_id = ? ORDER BY id DESC LIMIT 50').all(empresaId);

export function obterRemessa(id: number) {
  return db.prepare('SELECT * FROM remessas WHERE id = ?').get(id) as { id: number; empresa_id: number; nome_arquivo: string; conteudo: string } | undefined;
}

export function processarRetorno(empresaId: number, texto: string) {
  let r;
  try { r = lerRetornoAuto(texto); } catch (e: any) { throw new ErroNegocio(e.message); }
  const resumo = { titulos: r.itens.length, registrados: 0, rejeitados: 0, pagos: 0, baixados: 0, tarifas: 0, naoEncontrados: [] as string[], detalhes: [] as string[] };
  db.transaction(() => {
    for (const i of r.itens) {
      const c = db.prepare('SELECT * FROM cobrancas WHERE empresa_id = ? AND nosso_numero = ?').get(empresaId, i.nossoNumero.slice(0, 17)) as any;
      if (!c) { if (i.movimento !== '28') resumo.naoEncontrados.push(i.nossoNumero); continue; }
      const motivos = i.motivos.map(descreverMotivo).join('; ');
      const rotulo = MOVIMENTO_RETORNO[i.movimento] ?? `Movimento ${i.movimento}`;
      switch (i.movimento) {
        case '02': if (c.status !== 'PAGO') db.prepare("UPDATE cobrancas SET status = 'REGISTRADO', observacao_banco = NULL WHERE id = ?").run(c.id); resumo.registrados++; break;
        case '03': db.prepare("UPDATE cobrancas SET status = 'REJEITADO', observacao_banco = ? WHERE id = ?").run(motivos || 'Entrada rejeitada pelo banco (veja o motivo no internet banking do banco)', c.id); resumo.rejeitados++; resumo.detalhes.push(`${c.id}: ${motivos}`); break;
        case '06': case '15': case '17': case '76': case '77':
          db.prepare("UPDATE cobrancas SET status = 'PAGO', pago_em = ?, valor_pago = ?, baixa_pendente = 0, observacao_banco = NULL WHERE id = ?").run(i.dataCredito ?? i.dataOcorrencia ?? hojeBr(), i.valorPago || c.valor, c.id); resumo.pagos++; break;
        case '09': case '10': if (c.status !== 'PAGO') db.prepare("UPDATE cobrancas SET status = 'CANCELADO', baixa_pendente = 0 WHERE id = ?").run(c.id); resumo.baixados++; break;
        case '26': db.prepare('UPDATE cobrancas SET observacao_banco = ? WHERE id = ?').run(`Instrução rejeitada: ${motivos}`, c.id); resumo.detalhes.push(`${c.id}: instrução rejeitada – ${motivos}`); break;
        case '28': resumo.tarifas++; break;
        default: resumo.detalhes.push(`${c.id}: ${rotulo}${motivos ? ' – ' + motivos : ''}`);
      }
    }
  })();
  return resumo;
}

/** Nova cobrança (só boleto) copiando cliente, descrição e valor de uma anterior, com outro vencimento em dia útil. */
export function reemitirCobranca(usuarioId: number, id: number, vencimento: string, valor?: number | null) {
  const c = obterCobranca(id);
  if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
  const v = valor ?? Math.round((c.valor + (c.desconto ?? 0)) * 100) / 100; // valor antes do desconto; o do cadastro atual é aplicado de novo
  if (!(v > 0)) throw new ErroNegocio('O valor precisa ser maior que zero.');
  const extras = (db.prepare('SELECT feriados_extra FROM empresas WHERE id = ?').get(c.empresa_id) as any)?.feriados_extra;
  const ajuste = ajustarVencimento(vencimento, hojeBr(), extras);
  const nova = criarCobranca({ empresaId: c.empresa_id, tomadorId: c.tomador_id, notaId: null, descricao: c.descricao, valor: v, vencimento: ajuste.data, usuarioId });
  return { cobranca: nova, aviso: ajuste.aviso ?? null };
}

export const MODELOS_WHATSAPP = {
  lembrete: 'Olá, {cliente}! Passando para lembrar que o boleto de {valor} vence em {vencimento}.{linha}\nQualquer dúvida, estamos à disposição. {empresa}',
  atraso: 'Olá, {cliente}! Identificamos que o boleto de {valor}, com vencimento em {vencimento}, ainda não consta como pago.{linha}\nSe já pagou, desconsidere esta mensagem. {empresa}',
};
export function obterModelosWhatsapp(empresaId: number) {
  const e = db.prepare('SELECT wa_lembrete, wa_atraso FROM empresas WHERE id = ?').get(empresaId) as any;
  return { lembrete: e?.wa_lembrete || MODELOS_WHATSAPP.lembrete, atraso: e?.wa_atraso || MODELOS_WHATSAPP.atraso, padrao: MODELOS_WHATSAPP };
}
export function salvarModelosWhatsapp(empresaId: number, m: { lembrete: string; atraso: string }) {
  db.prepare('UPDATE empresas SET wa_lembrete = ?, wa_atraso = ? WHERE id = ?').run(m.lembrete.trim() || null, m.atraso.trim() || null, empresaId);
}
