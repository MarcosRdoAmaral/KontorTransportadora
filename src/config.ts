import 'dotenv/config';
import path from 'node:path';

function obrigatorio(nome: string): string {
  const v = process.env[nome];
  if (!v) throw new Error(`Variável de ambiente ${nome} não definida. Veja o arquivo .env.example.`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databasePath: path.resolve(process.env.DATABASE_PATH ?? './data/nfse.db'),
  storageDir: path.resolve(process.env.STORAGE_DIR ?? './data/arquivos'),
  /** Pasta de backups automáticos. Vazio = sem backup automático (modo servidor sem configuração). */
  backupDir: process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : null,
  host: process.env.HOST ?? '0.0.0.0',
  desktop: process.env.NFSE_DESKTOP === '1',
  get masterKey(): Buffer {
    const k = Buffer.from(obrigatorio('MASTER_KEY'), 'base64');
    if (k.length !== 32) throw new Error('MASTER_KEY deve ter 32 bytes em base64.');
    return k;
  },
  get sessionSecret(): string {
    return obrigatorio('SESSION_SECRET');
  },
  verAplic: (process.env.VER_APLIC ?? 'EmissorEscritorio1.0').slice(0, 20),
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@escritorio.com.br',
  adminSenha: process.env.ADMIN_SENHA ?? '',
};

/** URLs oficiais do Sistema Nacional NFS-e. tpAmb 1 = produção, 2 = produção restrita (homologação). */
export const SEFIN_URL: Record<1 | 2, string> = {
  1: 'https://sefin.nfse.gov.br/SefinNacional',
  2: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
};

/** Base da consulta pública (usada no QR Code do DANFSe). */
export const CONSULTA_PUBLICA_URL = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=';
