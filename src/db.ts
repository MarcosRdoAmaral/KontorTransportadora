import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

/**
 * SQLite embutido no Node (node:sqlite): não exige módulo nativo, então o mesmo código
 * roda no servidor e dentro do aplicativo de desktop (Electron) sem recompilar nada.
 * Esta camada mantém a interface usada no resto do sistema: prepare/run/get/all, pragma e transaction.
 */
class Banco {
  private conn = new DatabaseSync(config.databasePath);

  exec(sql: string) {
    this.conn.exec(sql);
  }

  prepare(sql: string) {
    const st: StatementSync = this.conn.prepare(sql);
    return {
      run: (...p: any[]) => st.run(...p),
      get: (...p: any[]) => st.get(...p) as any,
      all: (...p: any[]) => st.all(...p) as any[],
    };
  }

  pragma(texto: string, opcoes?: { simple?: boolean }) {
    if (opcoes?.simple) {
      const linha = this.conn.prepare(`PRAGMA ${texto}`).get() as Record<string, unknown> | undefined;
      return linha ? Object.values(linha)[0] : undefined;
    }
    this.conn.exec(`PRAGMA ${texto}`);
  }

  /** Executa fn dentro de uma transação; desfaz tudo se lançar erro. */
  transaction<A extends any[], R>(fn: (...a: A) => R) {
    return (...a: A): R => {
      this.conn.exec('BEGIN IMMEDIATE');
      try {
        const r = fn(...a);
        this.conn.exec('COMMIT');
        return r;
      } catch (e) {
        this.conn.exec('ROLLBACK');
        throw e;
      }
    };
  }

  /** Cópia consistente do banco (usada no backup), mesmo com o sistema em uso. */
  copiarPara(destino: string) {
    if (fs.existsSync(destino)) fs.rmSync(destino);
    this.conn.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  }
}

export const db = new Banco();
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Migrações em ordem. Cada uma roda uma única vez (controle por user_version).
 * Modelo multi-escritório desde o início: cada registro pertence a um escritório,
 * o que permite virar SaaS depois sem refazer o banco.
 */
const migracoes: string[] = [
  `
  CREATE TABLE escritorios (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    cnpj TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    papel TEXT NOT NULL CHECK (papel IN ('admin','operador','cliente')),
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE empresas (
    id INTEGER PRIMARY KEY,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    documento TEXT NOT NULL,                 -- CNPJ (14, aceita alfanumérico) ou CPF (11)
    razao_social TEXT NOT NULL,
    nome_fantasia TEXT,
    inscricao_municipal TEXT,
    cod_municipio TEXT NOT NULL,             -- IBGE 7 dígitos (cLocEmi)
    uf TEXT,
    email TEXT,
    op_simp_nac INTEGER NOT NULL DEFAULT 3,  -- 1 Não optante, 2 MEI, 3 ME/EPP
    reg_ap_trib_sn INTEGER,                  -- 1, 2 ou 3 (só para opSimpNac=3)
    reg_esp_trib INTEGER NOT NULL DEFAULT 0,
    p_tot_trib_sn REAL,                      -- % aproximado de tributos do Simples (Lei 12.741)
    ambiente INTEGER NOT NULL DEFAULT 2 CHECK (ambiente IN (1,2)),
    serie TEXT NOT NULL DEFAULT '1',
    cert_pfx_enc BLOB,
    cert_senha_enc TEXT,
    cert_titular TEXT,
    cert_validade TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (escritorio_id, documento)
  );

  CREATE TABLE usuario_empresas (
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    PRIMARY KEY (usuario_id, empresa_id)
  );

  CREATE TABLE sequencias_dps (
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    ambiente INTEGER NOT NULL,
    serie TEXT NOT NULL,
    ultimo_numero INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (empresa_id, ambiente, serie)
  );

  CREATE TABLE tomadores (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    tipo_doc TEXT NOT NULL CHECK (tipo_doc IN ('CPF','CNPJ','SEM')),
    documento TEXT,
    nome TEXT NOT NULL,
    inscricao_municipal TEXT,
    email TEXT,
    fone TEXT,
    cep TEXT,
    cod_municipio TEXT,
    logradouro TEXT,
    numero TEXT,
    complemento TEXT,
    bairro TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX ix_tomadores_empresa ON tomadores(empresa_id);

  CREATE TABLE servicos (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    nome TEXT NOT NULL,                      -- apelido interno ("Consultoria mensal")
    descricao TEXT NOT NULL,                 -- xDescServ padrão
    c_trib_nac TEXT NOT NULL,                -- 6 dígitos
    c_trib_mun TEXT,                         -- 3 dígitos (desdobro municipal, quando houver)
    c_nbs TEXT,                              -- 9 dígitos
    aliquota REAL,                           -- pAliq (%), quando exigida
    valor_padrao REAL,
    ibscbs_json TEXT,                        -- grupo IBS/CBS opcional (regime regular)
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX ix_servicos_empresa ON servicos(empresa_id);

  CREATE TABLE notas (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    tomador_id INTEGER REFERENCES tomadores(id),
    servico_id INTEGER REFERENCES servicos(id),
    ambiente INTEGER NOT NULL,
    serie TEXT NOT NULL,
    n_dps INTEGER NOT NULL,
    id_dps TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('PENDENTE','AUTORIZADA','REJEITADA','ERRO_COMUNICACAO','CANCELADA')),
    competencia TEXT NOT NULL,
    valor_servico REAL NOT NULL,
    descricao TEXT NOT NULL,
    tomador_nome TEXT,
    tomador_documento TEXT,
    payload_json TEXT NOT NULL,
    xml_dps TEXT,
    xml_nfse TEXT,
    chave_acesso TEXT UNIQUE,
    n_nfse TEXT,
    erros_json TEXT,
    alertas_json TEXT,
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    autorizada_em TEXT,
    cancelada_em TEXT,
    UNIQUE (empresa_id, ambiente, serie, n_dps)
  );
  CREATE INDEX ix_notas_empresa ON notas(empresa_id, criado_em);

  CREATE TABLE eventos (
    id INTEGER PRIMARY KEY,
    nota_id INTEGER NOT NULL REFERENCES notas(id),
    tipo TEXT NOT NULL,
    status TEXT NOT NULL,
    motivo TEXT,
    xml_pedido TEXT,
    xml_retorno TEXT,
    erros_json TEXT,
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE log_comunicacao (
    id INTEGER PRIMARY KEY,
    nota_id INTEGER REFERENCES notas(id),
    metodo TEXT NOT NULL,
    url TEXT NOT NULL,
    status_http INTEGER,
    resposta TEXT,
    duracao_ms INTEGER,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 2: logo da empresa para o DANFSe
  `ALTER TABLE empresas ADD COLUMN logo BLOB;`,
  // 3: lembra a última empresa escolhida por usuário
  `ALTER TABLE usuarios ADD COLUMN ultima_empresa_id INTEGER;`,
  // 4: envio de NFS-e por e-mail (SMTP do escritório, senha criptografada) + histórico
  `ALTER TABLE escritorios ADD COLUMN smtp_enc TEXT;
  CREATE TABLE emails_enviados (
    id INTEGER PRIMARY KEY,
    nota_id INTEGER NOT NULL REFERENCES notas(id),
    para TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ENVIADO','ERRO')),
    erro TEXT,
    enviado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_emails_nota ON emails_enviados(nota_id);`,
  // 5: faturamento por cliente (nota / nota + boleto / só boleto) e cobranças (boleto ainda sem banco)
  `ALTER TABLE tomadores ADD COLUMN modo_faturamento TEXT NOT NULL DEFAULT 'NOTA' CHECK (modo_faturamento IN ('NOTA','NOTA_BOLETO','BOLETO'));
  ALTER TABLE tomadores ADD COLUMN vencimento_tipo TEXT NOT NULL DEFAULT 'PRAZO' CHECK (vencimento_tipo IN ('PRAZO','DIA_FIXO'));
  ALTER TABLE tomadores ADD COLUMN vencimento_valor INTEGER NOT NULL DEFAULT 10;
  ALTER TABLE tomadores ADD COLUMN email_cobranca TEXT;
  ALTER TABLE tomadores ADD COLUMN enviar_email_auto INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE cobrancas (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    tomador_id INTEGER NOT NULL REFERENCES tomadores(id),
    nota_id INTEGER REFERENCES notas(id),
    descricao TEXT NOT NULL,
    valor REAL NOT NULL,
    vencimento TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'AGUARDANDO_BANCO' CHECK (status IN ('AGUARDANDO_BANCO','EMITIDO','PAGO','CANCELADO')),
    nosso_numero TEXT,
    linha_digitavel TEXT,
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_cobrancas_empresa ON cobrancas(empresa_id, vencimento);
  CREATE INDEX idx_cobrancas_nota ON cobrancas(nota_id);`,
  // 6: controle de licença (código de ativação por computador, teste de 30 dias)
  `CREATE TABLE licenca (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    codigo TEXT,
    cliente TEXT,
    ate TEXT,
    ativada_em TEXT,
    inicio_teste TEXT,
    ultimo_visto TEXT,
    maquina_alt TEXT
  );`,
  // 7: cobrança bancária Ailos (conta, boletos, remessas e retornos)
  `ALTER TABLE tomadores ADD COLUMN cidade TEXT;
  ALTER TABLE tomadores ADD COLUMN uf TEXT;
  CREATE TABLE contas_bancarias (
    empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id),
    banco TEXT NOT NULL DEFAULT '085',
    cooperativa_nome TEXT NOT NULL DEFAULT 'AILOS',
    agencia TEXT NOT NULL, agencia_dv TEXT NOT NULL,
    conta TEXT NOT NULL, conta_dv TEXT NOT NULL,
    convenio TEXT NOT NULL,
    carteira TEXT NOT NULL DEFAULT '01',
    multa_pct REAL NOT NULL DEFAULT 2,
    juros_pct_mes REAL NOT NULL DEFAULT 1,
    instrucoes TEXT,
    proximo_boleto INTEGER NOT NULL DEFAULT 1,
    proxima_remessa INTEGER NOT NULL DEFAULT 1,
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE remessas (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    numero INTEGER NOT NULL,
    nome_arquivo TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    qtd_titulos INTEGER NOT NULL,
    valor_total REAL NOT NULL,
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_remessas_empresa ON remessas(empresa_id, id);
  CREATE TABLE cobrancas_nova (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    tomador_id INTEGER NOT NULL REFERENCES tomadores(id),
    nota_id INTEGER REFERENCES notas(id),
    descricao TEXT NOT NULL,
    valor REAL NOT NULL,
    vencimento TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'AGUARDANDO_BANCO' CHECK (status IN ('AGUARDANDO_BANCO','A_REMETER','REMETIDO','REGISTRADO','REJEITADO','PAGO','CANCELADO')),
    emissao TEXT,
    numero_boleto INTEGER,
    nosso_numero TEXT,
    linha_digitavel TEXT,
    codigo_barras TEXT,
    remessa_id INTEGER REFERENCES remessas(id),
    baixa_pendente INTEGER NOT NULL DEFAULT 0,
    pago_em TEXT,
    valor_pago REAL,
    observacao_banco TEXT,
    email_status TEXT,
    email_para TEXT,
    email_em TEXT,
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO cobrancas_nova (id, empresa_id, tomador_id, nota_id, descricao, valor, vencimento, status, nosso_numero, linha_digitavel, criado_por, criado_em)
    SELECT id, empresa_id, tomador_id, nota_id, descricao, valor, vencimento,
      CASE status WHEN 'EMITIDO' THEN 'A_REMETER' ELSE status END, nosso_numero, linha_digitavel, criado_por, criado_em FROM cobrancas;
  DROP TABLE cobrancas;
  ALTER TABLE cobrancas_nova RENAME TO cobrancas;
  CREATE INDEX idx_cobrancas_empresa ON cobrancas(empresa_id, vencimento);
  CREATE INDEX idx_cobrancas_nota ON cobrancas(nota_id);
  CREATE UNIQUE INDEX idx_cobrancas_nosso ON cobrancas(empresa_id, nosso_numero) WHERE nosso_numero IS NOT NULL;`,
  // 8: layout do arquivo de cobrança (CNAB 400 é o padrão do Ailos; CNAB 240 também suportado)
  `ALTER TABLE contas_bancarias ADD COLUMN layout TEXT NOT NULL DEFAULT 'CNAB400' CHECK (layout IN ('CNAB400','CNAB240'));`,
  // 9: acesso por usuário (nome em maiúsculas), tipos adm/normal, permissões por módulo, troca obrigatória de senha, usuário master
  `ALTER TABLE usuarios ADD COLUMN login TEXT;
  ALTER TABLE usuarios ADD COLUMN tipo TEXT NOT NULL DEFAULT 'normal' CHECK (tipo IN ('adm','normal'));
  ALTER TABLE usuarios ADD COLUMN permissoes TEXT;            -- JSON com os módulos liberados (NULL = todos os módulos de trabalho)
  ALTER TABLE usuarios ADD COLUMN trocar_senha INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usuarios ADD COLUMN mestre INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usuarios ADD COLUMN sessao_v INTEGER NOT NULL DEFAULT 0;   -- muda ao trocar/redefinir a senha e encerra sessões antigas
  UPDATE usuarios SET tipo = CASE WHEN papel = 'admin' THEN 'adm' ELSE 'normal' END;
  UPDATE usuarios SET login = upper(substr(email, 1, instr(email || '@', '@') - 1));
  UPDATE usuarios SET login = login || id WHERE EXISTS (SELECT 1 FROM usuarios u2 WHERE u2.login = usuarios.login AND u2.id < usuarios.id);
  CREATE UNIQUE INDEX idx_usuarios_login ON usuarios(login);
  CREATE TABLE recuperacao_senha (
    usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
    codigo_hash TEXT NOT NULL,
    expira_em INTEGER NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 0,
    pedidos_em TEXT NOT NULL DEFAULT '[]'
  );`,
  // 10: despesas e categorias por empresa, feriados locais (vencimento em dia útil)
  `ALTER TABLE empresas ADD COLUMN feriados_extra TEXT;     -- ex.: "24/06, 19/03" (municipais)
  CREATE TABLE despesa_categorias (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    nome TEXT NOT NULL,
    UNIQUE (empresa_id, nome)
  );
  CREATE TABLE despesas (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    data TEXT NOT NULL,
    categoria TEXT NOT NULL,
    descricao TEXT,
    valor REAL NOT NULL CHECK (valor > 0),
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_despesas_empresa ON despesas(empresa_id, data);`,
  // 11: modelos de mensagem de WhatsApp para cobrança (lembrete e atraso)
  `ALTER TABLE empresas ADD COLUMN wa_lembrete TEXT;
  ALTER TABLE empresas ADD COLUMN wa_atraso TEXT;`,
  // 12: desconto fixo por cliente (motivo e valor), levado a todos os boletos dele
  `ALTER TABLE tomadores ADD COLUMN desconto_valor REAL;
  ALTER TABLE tomadores ADD COLUMN desconto_motivo TEXT;
  ALTER TABLE cobrancas ADD COLUMN desconto REAL NOT NULL DEFAULT 0;
  ALTER TABLE cobrancas ADD COLUMN desconto_motivo TEXT;`,
  // 13: serviços padrão por cliente (serviço + valor), base para emissão recorrente/agendada
  `CREATE TABLE tomador_servicos (
    id INTEGER PRIMARY KEY,
    tomador_id INTEGER NOT NULL REFERENCES tomadores(id) ON DELETE CASCADE,
    servico_id INTEGER NOT NULL REFERENCES servicos(id),
    valor REAL NOT NULL CHECK (valor > 0),
    descricao TEXT,                           -- texto da nota (vazio = descrição padrão do serviço)
    padrao INTEGER NOT NULL DEFAULT 0,        -- 1 = o principal, escolhido ao selecionar o cliente
    UNIQUE (tomador_id, servico_id)
  );
  CREATE INDEX ix_tomador_servicos ON tomador_servicos(tomador_id);`,
  // 14: tributação padrão do serviço (ISSQN, retenções, totais de tributos, município, informações complementares)
  `ALTER TABLE servicos ADD COLUMN tributacao_json TEXT;`,
  // 15: extrato bancário importado (PDF), classificação e conciliação com boletos
  `CREATE TABLE extrato_importacoes (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    arquivo TEXT NOT NULL,
    hash TEXT NOT NULL,
    periodo_ini TEXT, periodo_fim TEXT,
    saldo_anterior REAL, saldo_final REAL,
    qtd INTEGER NOT NULL,
    conta TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (empresa_id, hash)
  );
  CREATE TABLE extrato_lancamentos (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    importacao_id INTEGER NOT NULL REFERENCES extrato_importacoes(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    descricao TEXT NOT NULL,
    documento TEXT,
    valor REAL NOT NULL,                      -- positivo = entrada, negativo = saída
    saldo REAL,
    categoria TEXT,
    categoria_origem TEXT,                    -- auto | regra | manual
    cobranca_id INTEGER REFERENCES cobrancas(id),
    chave TEXT NOT NULL,
    UNIQUE (empresa_id, chave)
  );
  CREATE INDEX ix_extrato_data ON extrato_lancamentos(empresa_id, data);
  CREATE TABLE extrato_regras (
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    chave TEXT NOT NULL,
    categoria TEXT NOT NULL,
    PRIMARY KEY (empresa_id, chave)
  );`,
  // 16: empresas que emitem pelo portal (CNPJ e senha), sem certificado digital
  `ALTER TABLE empresas ADD COLUMN modo_emissao TEXT NOT NULL DEFAULT 'CERTIFICADO';
  ALTER TABLE empresas ADD COLUMN portal_login TEXT;
  ALTER TABLE empresas ADD COLUMN portal_senha_enc TEXT;`,
  // 17: emissão automática mensal (agenda por cliente) e histórico do que foi emitido em cada mês
  `ALTER TABLE tomadores ADD COLUMN agenda_ativa INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tomadores ADD COLUMN agenda_dia INTEGER;
  CREATE TABLE agenda_execucoes (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    tomador_id INTEGER NOT NULL REFERENCES tomadores(id),
    servico_id INTEGER NOT NULL REFERENCES servicos(id),
    competencia TEXT NOT NULL,                 -- AAAA-MM
    status TEXT NOT NULL CHECK (status IN ('EMITIDA','ERRO','PULADA')),
    valor REAL,
    nota_id INTEGER REFERENCES notas(id),
    cobranca_id INTEGER REFERENCES cobrancas(id),
    mensagem TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tomador_id, servico_id, competencia)
  );`,
  // 18: compras (NF-e de entrada importada por XML ou lançada à mão), itens e parcelas; parcelas podem gerar despesas
  `CREATE TABLE compras (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    fornecedor_documento TEXT,
    fornecedor_nome TEXT NOT NULL,
    numero TEXT,
    serie TEXT,
    chave_acesso TEXT,
    emissao TEXT NOT NULL,
    natureza TEXT,
    categoria TEXT,
    observacao TEXT,
    valor_produtos REAL NOT NULL DEFAULT 0,
    valor_frete REAL NOT NULL DEFAULT 0,
    valor_desconto REAL NOT NULL DEFAULT 0,
    valor_outras REAL NOT NULL DEFAULT 0,
    valor_icms REAL NOT NULL DEFAULT 0,
    valor_ipi REAL NOT NULL DEFAULT 0,
    valor_total REAL NOT NULL,
    xml TEXT,
    origem TEXT NOT NULL DEFAULT 'XML' CHECK (origem IN ('XML','MANUAL')),
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (empresa_id, chave_acesso)
  );
  CREATE INDEX idx_compras_empresa ON compras(empresa_id, emissao);
  CREATE TABLE compra_itens (
    id INTEGER PRIMARY KEY,
    compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
    n_item INTEGER NOT NULL,
    codigo TEXT, descricao TEXT NOT NULL, ncm TEXT, cfop TEXT, unidade TEXT,
    quantidade REAL NOT NULL DEFAULT 0, valor_unitario REAL NOT NULL DEFAULT 0, valor_total REAL NOT NULL DEFAULT 0, desconto REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_compra_itens ON compra_itens(compra_id);
  CREATE TABLE compra_parcelas (
    id INTEGER PRIMARY KEY,
    compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
    numero TEXT,
    vencimento TEXT NOT NULL,
    valor REAL NOT NULL,
    despesa_id INTEGER REFERENCES despesas(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_compra_parcelas ON compra_parcelas(compra_id);`,
  // 19: tributação — catálogo de impostos, perfis (com vigência), tipos de documento e apuração assistida
  `CREATE TABLE impostos (
    codigo TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    grupo TEXT NOT NULL CHECK (grupo IN ('MUNICIPAL','ESTADUAL','FEDERAL','IBS_CBS')),
    pode_reter INTEGER NOT NULL DEFAULT 0,
    credita INTEGER NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    ordem INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO impostos (codigo, nome, grupo, pode_reter, credita, ordem) VALUES
    ('ISS','ISS (imposto sobre serviços)','MUNICIPAL',1,0,1),
    ('ICMS','ICMS','ESTADUAL',0,1,2),
    ('IPI','IPI','FEDERAL',0,1,3),
    ('PIS','PIS','FEDERAL',1,1,4),
    ('COFINS','COFINS','FEDERAL',1,1,5),
    ('CSLL','CSLL','FEDERAL',1,0,6),
    ('IRRF','IRRF','FEDERAL',1,0,7),
    ('INSS','INSS (contribuição previdenciária)','FEDERAL',1,0,8),
    ('IBS_UF','IBS — parcela estadual','IBS_CBS',0,1,9),
    ('IBS_MUN','IBS — parcela municipal','IBS_CBS',0,1,10),
    ('CBS','CBS','IBS_CBS',0,1,11);
  CREATE TABLE perfis_tributacao (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    nome TEXT NOT NULL,
    descricao TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_perfis_empresa ON perfis_tributacao(empresa_id);
  CREATE TABLE perfil_itens (
    id INTEGER PRIMARY KEY,
    perfil_id INTEGER NOT NULL REFERENCES perfis_tributacao(id) ON DELETE CASCADE,
    imposto_codigo TEXT NOT NULL REFERENCES impostos(codigo),
    aliquota REAL NOT NULL DEFAULT 0,
    reducao_base REAL NOT NULL DEFAULT 0,
    retido INTEGER NOT NULL DEFAULT 0,
    cst TEXT,
    c_class_trib TEXT,
    vigencia_ini TEXT,
    vigencia_fim TEXT
  );
  CREATE INDEX idx_perfil_itens ON perfil_itens(perfil_id);
  CREATE TABLE tipos_documento (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    nome TEXT NOT NULL,
    sentido TEXT NOT NULL CHECK (sentido IN ('SAIDA','ENTRADA')),
    modelo TEXT NOT NULL DEFAULT 'NFSE' CHECK (modelo IN ('NFSE','NFE','MANUAL')),
    natureza TEXT,
    perfil_id INTEGER REFERENCES perfis_tributacao(id) ON DELETE SET NULL,
    c_trib_nac TEXT,
    cfop TEXT,
    ind_op TEXT,
    gera_credito INTEGER NOT NULL DEFAULT 0,
    destino TEXT NOT NULL DEFAULT 'NENHUM' CHECK (destino IN ('RECEITA','DESPESA','NENHUM')),
    padrao INTEGER NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_tipos_empresa ON tipos_documento(empresa_id, sentido);
  ALTER TABLE servicos ADD COLUMN tipo_documento_id INTEGER REFERENCES tipos_documento(id);
  ALTER TABLE compras ADD COLUMN tipo_documento_id INTEGER REFERENCES tipos_documento(id);
  CREATE TABLE documento_tributos (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    origem TEXT NOT NULL CHECK (origem IN ('NOTA','COMPRA')),
    documento_id INTEGER NOT NULL,
    competencia TEXT NOT NULL,
    imposto_codigo TEXT NOT NULL REFERENCES impostos(codigo),
    base REAL NOT NULL DEFAULT 0,
    aliquota REAL,
    valor REAL NOT NULL DEFAULT 0,
    retido INTEGER NOT NULL DEFAULT 0,
    fonte TEXT NOT NULL CHECK (fonte IN ('CALCULADO','XML')),
    perfil_id INTEGER,
    calculado_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (origem, documento_id, imposto_codigo, fonte)
  );
  CREATE INDEX idx_doc_tributos ON documento_tributos(empresa_id, competencia);`,
  // 20: o perfil passa a carregar também os dados da DPS (ISSQN, imunidade, totais aproximados, município, informações);
  // o tipo de documento carrega o indicador IBS/CBS; a nota guarda o tipo usado
  `ALTER TABLE perfis_tributacao ADD COLUMN trib_issqn INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE perfis_tributacao ADD COLUMN tp_imunidade INTEGER;
  ALTER TABLE perfis_tributacao ADD COLUMN p_tot_fed REAL;
  ALTER TABLE perfis_tributacao ADD COLUMN p_tot_est REAL;
  ALTER TABLE perfis_tributacao ADD COLUMN p_tot_mun REAL;
  ALTER TABLE perfis_tributacao ADD COLUMN municipio_prestacao TEXT;
  ALTER TABLE perfis_tributacao ADD COLUMN info_complementar TEXT;
  ALTER TABLE tipos_documento ADD COLUMN ind_final INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tipos_documento ADD COLUMN ind_dest INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE notas ADD COLUMN tipo_documento_id INTEGER REFERENCES tipos_documento(id);`,
  // 21: estoque básico de insumos (material de expediente etc.): itens e movimentos (saldo = soma dos movimentos)
  `CREATE TABLE estoque_itens (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    nome TEXT NOT NULL,
    unidade TEXT NOT NULL DEFAULT 'un',
    categoria TEXT,
    estoque_minimo REAL NOT NULL DEFAULT 0,
    observacao TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_estoque_itens ON estoque_itens(empresa_id, ativo);
  CREATE TABLE estoque_movimentos (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    item_id INTEGER NOT NULL REFERENCES estoque_itens(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('ENTRADA','SAIDA','AJUSTE')),
    quantidade REAL NOT NULL,
    custo_unitario REAL,
    data TEXT NOT NULL,
    compra_item_id INTEGER REFERENCES compra_itens(id) ON DELETE SET NULL,
    observacao TEXT,
    usuario_id INTEGER,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_estoque_mov ON estoque_movimentos(item_id, data);
  CREATE UNIQUE INDEX idx_estoque_mov_compra ON estoque_movimentos(compra_item_id) WHERE compra_item_id IS NOT NULL;`,
  // 22: modelo de descrição composta por cliente (período, ordem de compra, linhas de valor com retenção de INSS)
  `ALTER TABLE tomadores ADD COLUMN descricao_modelo TEXT;`,
  // 23: despesas com forma de pagamento e ligação ao extrato (origem EXTRATO = espelho do lançamento bancário; MANUAL pode ser vinculada para justificar o gasto)
  `ALTER TABLE despesas ADD COLUMN forma_pagamento TEXT CHECK (forma_pagamento IN ('PIX','DEBITO','CREDITO','DINHEIRO'));
  ALTER TABLE despesas ADD COLUMN origem TEXT NOT NULL DEFAULT 'MANUAL';
  ALTER TABLE despesas ADD COLUMN extrato_lancamento_id INTEGER REFERENCES extrato_lancamentos(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX idx_despesas_extrato ON despesas(extrato_lancamento_id) WHERE extrato_lancamento_id IS NOT NULL;`,
  // 24: fatura de cartão de crédito importada (PDF); os gastos classificados espelham em despesas (forma CRÉDITO)
  `CREATE TABLE cartao_faturas (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    arquivo TEXT NOT NULL,
    hash TEXT NOT NULL,
    referencia TEXT,
    vencimento TEXT NOT NULL,
    titular TEXT, conta_cartao TEXT,
    total_fatura REAL, pagamento_minimo REAL, despesas_debito REAL,
    qtd INTEGER NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (empresa_id, hash)
  );
  CREATE TABLE cartao_lancamentos (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    fatura_id INTEGER NOT NULL REFERENCES cartao_faturas(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    descricao TEXT NOT NULL,
    cidade TEXT,
    parcela_atual INTEGER, parcela_total INTEGER,
    cartao_final TEXT,
    valor REAL NOT NULL,                      -- positivo = gasto, negativo = crédito/estorno
    tipo TEXT NOT NULL CHECK (tipo IN ('COMPRA','ANUIDADE','ENCARGO','CREDITO','PAGAMENTO')),
    categoria TEXT,
    categoria_origem TEXT,
    chave TEXT NOT NULL,
    UNIQUE (empresa_id, chave)
  );
  CREATE INDEX ix_cartao_fatura ON cartao_lancamentos(fatura_id);
  ALTER TABLE despesas ADD COLUMN cartao_lancamento_id INTEGER REFERENCES cartao_lancamentos(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX idx_despesas_cartao ON despesas(cartao_lancamento_id) WHERE cartao_lancamento_id IS NOT NULL;`,
  // 25: multa, juros e desconto por pontualidade por cliente (em branco = usa o da conta bancária); o boleto guarda o que valia na criação
  `ALTER TABLE tomadores ADD COLUMN multa_pct REAL;
  ALTER TABLE tomadores ADD COLUMN juros_pct_mes REAL;
  ALTER TABLE tomadores ADD COLUMN desc_pontual_pct REAL;
  ALTER TABLE tomadores ADD COLUMN desc_pontual_dias INTEGER;
  ALTER TABLE cobrancas ADD COLUMN multa_pct REAL;
  ALTER TABLE cobrancas ADD COLUMN juros_pct_mes REAL;
  ALTER TABLE cobrancas ADD COLUMN desc_pontual_pct REAL;
  ALTER TABLE cobrancas ADD COLUMN desc_pontual_dias INTEGER;`,
  // 26: NF-e recebidas direto da SEFAZ (Distribuição DF-e): resumo/XML por chave, controle de NSU por empresa
  //     e parâmetros gerais do sistema (cadeia ICP-Brasil para a conexão com a SEFAZ)
  `CREATE TABLE IF NOT EXISTS parametros (nome TEXT PRIMARY KEY, valor TEXT);
  CREATE TABLE nfe_recebidas (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    chave TEXT NOT NULL,
    numero TEXT,
    serie TEXT,
    emitente_documento TEXT,
    emitente_nome TEXT,
    emissao TEXT,
    valor REAL,
    situacao TEXT NOT NULL DEFAULT 'AUTORIZADA' CHECK (situacao IN ('AUTORIZADA','DENEGADA','CANCELADA')),
    xml TEXT,                       -- procNFe completo; NULL enquanto só há o resumo
    ciencia_em TEXT,                -- quando a Ciência da Operação foi registrada
    ciencia_erro TEXT,              -- recusa da SEFAZ ao registrar a ciência
    nsu TEXT,
    oculta INTEGER NOT NULL DEFAULT 0,
    recebida_em TEXT NOT NULL DEFAULT (datetime('now')),
    atualizada_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (empresa_id, chave)
  );
  CREATE INDEX idx_nfe_recebidas ON nfe_recebidas(empresa_id, emissao);
  CREATE TABLE nfe_distribuicao (
    empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id),
    ult_nsu TEXT NOT NULL DEFAULT '0',
    proxima_consulta TEXT,          -- ISO; a SEFAZ exige 1 hora de intervalo quando não há documentos novos
    ultima_consulta TEXT,
    ultimo_resultado TEXT,
    ultimo_erro TEXT,
    automatica INTEGER NOT NULL DEFAULT 1
  );`,
  // 26: clientes criados por planilha ficam marcados para conferência
  `ALTER TABLE tomadores ADD COLUMN conferir INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tomadores ADD COLUMN conferir_motivo TEXT;`,
  // 27: e-mail da contabilidade e fechamento mensal automático
  `ALTER TABLE empresas ADD COLUMN contabilidade_email TEXT;
  ALTER TABLE empresas ADD COLUMN fechamento_ativo INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE empresas ADD COLUMN fechamento_dia INTEGER;
  ALTER TABLE empresas ADD COLUMN fechamento_ultimo TEXT;
  ALTER TABLE empresas ADD COLUMN fechamento_em TEXT;
  ALTER TABLE empresas ADD COLUMN fechamento_resultado TEXT;`,
  // 28: carteira Pix (copia e cola, sem boleto) e rodapé do demonstrativo de cobrança
  `ALTER TABLE tomadores ADD COLUMN forma_cobranca TEXT NOT NULL DEFAULT 'BOLETO' CHECK (forma_cobranca IN ('BOLETO','PIX'));
  ALTER TABLE cobrancas ADD COLUMN forma TEXT NOT NULL DEFAULT 'BOLETO' CHECK (forma IN ('BOLETO','PIX'));
  ALTER TABLE cobrancas ADD COLUMN pix_copia_cola TEXT;
  ALTER TABLE empresas ADD COLUMN demonstrativo_rodape TEXT;`,
  // 29: modelos de e-mail editáveis e imagem de assinatura
  `CREATE TABLE email_modelos (
    chave TEXT PRIMARY KEY,
    assunto TEXT NOT NULL,
    corpo TEXT NOT NULL,
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE escritorios ADD COLUMN assinatura_img BLOB;
  ALTER TABLE escritorios ADD COLUMN assinatura_mime TEXT;`,
  // 30: banco Cora (API): credenciais por empresa e vínculo das cobranças com o boleto da Cora
  `CREATE TABLE contas_cora (
    empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id),
    ativa INTEGER NOT NULL DEFAULT 1,
    ambiente TEXT NOT NULL DEFAULT 'producao' CHECK (ambiente IN ('teste','producao')),
    client_id TEXT NOT NULL,
    cert_enc TEXT NOT NULL,
    chave_enc TEXT NOT NULL,
    multa_pct REAL NOT NULL DEFAULT 2,
    juros_pct_mes REAL NOT NULL DEFAULT 1,
    ultima_sync_pagos TEXT,
    ultima_sync_extrato TEXT,
    saldo REAL,
    saldo_em TEXT,
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE cobrancas ADD COLUMN cora_id TEXT;
  ALTER TABLE cobrancas ADD COLUMN cora_idem TEXT;
  ALTER TABLE cobrancas ADD COLUMN cora_pdf_url TEXT;
  ALTER TABLE cobrancas ADD COLUMN cora_pdf BLOB;
  CREATE UNIQUE INDEX idx_cobrancas_cora ON cobrancas(cora_id) WHERE cora_id IS NOT NULL;`,
  // avatar escolhido pelo usuário (Configurações > Minha conta)
  `ALTER TABLE usuarios ADD COLUMN avatar TEXT;`,
  // orçamentos de serviços, com itens e vínculo com as notas emitidas a partir deles
  `CREATE TABLE orcamentos (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    numero INTEGER NOT NULL,
    tomador_id INTEGER REFERENCES tomadores(id),
    cliente_nome TEXT,
    cliente_email TEXT,
    cliente_fone TEXT,
    situacao TEXT NOT NULL DEFAULT 'RASCUNHO' CHECK (situacao IN ('RASCUNHO','ENVIADO','APROVADO','RECUSADO')),
    validade TEXT,
    condicoes TEXT,
    observacoes TEXT,
    desconto REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    motivo_recusa TEXT,
    enviado_em TEXT,
    decidido_em TEXT,
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (empresa_id, numero)
  );
  CREATE INDEX ix_orcamentos_empresa ON orcamentos(empresa_id, criado_em);
  CREATE TABLE orcamento_itens (
    id INTEGER PRIMARY KEY,
    orcamento_id INTEGER NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
    ordem INTEGER NOT NULL,
    servico_id INTEGER REFERENCES servicos(id),
    descricao TEXT NOT NULL,
    quantidade REAL NOT NULL DEFAULT 1,
    valor_unitario REAL NOT NULL,
    total REAL NOT NULL
  );
  CREATE TABLE orcamento_notas (
    id INTEGER PRIMARY KEY,
    orcamento_id INTEGER NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
    nota_id INTEGER NOT NULL UNIQUE REFERENCES notas(id),
    item_id INTEGER REFERENCES orcamento_itens(id) ON DELETE SET NULL,
    valor REAL NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );`,
];

export function migrar(): void {
  const atual = db.pragma('user_version', { simple: true }) as number;
  if (atual > 0 && atual < migracoes.length) {
    // cópia de segurança antes de atualizar a estrutura do banco
    try {
      const pasta = path.join(path.dirname(config.databasePath), 'antes-de-atualizar');
      fs.mkdirSync(pasta, { recursive: true });
      db.copiarPara(path.join(pasta, `nfse-v${atual}-${new Date().toISOString().slice(0, 10)}.db`));
    } catch { /* não impede a atualização */ }
  }
  for (let i = atual; i < migracoes.length; i++) {
    db.transaction(() => {
      db.exec(migracoes[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}
