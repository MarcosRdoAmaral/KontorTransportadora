import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';

const hojeISO = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

export function criarBackup(destinoDir: string, nome?: string): string {
  fs.mkdirSync(destinoDir, { recursive: true });
  const arquivo = path.join(destinoDir, nome ?? `nfse-backup-${hojeISO()}.db`);
  db.copiarPara(arquivo);
  return arquivo;
}

export function listarBackups() {
  if (!config.backupDir || !fs.existsSync(config.backupDir)) return [];
  return fs.readdirSync(config.backupDir)
    .filter((f) => /^nfse-backup-.*\.db$/.test(f))
    .map((f) => ({ nome: f, bytes: fs.statSync(path.join(config.backupDir!, f)).size, data: fs.statSync(path.join(config.backupDir!, f)).mtime.toISOString() }))
    .sort((a, b) => b.nome.localeCompare(a.nome));
}

/** Um backup por dia, mantendo os 30 mais recentes. Roda ao abrir o sistema e depois de hora em hora. */
export function backupAutomatico(): void {
  if (!config.backupDir) return;
  try {
    const hoje = path.join(config.backupDir, `nfse-backup-${hojeISO()}.db`);
    if (!fs.existsSync(hoje)) criarBackup(config.backupDir);
    for (const antigo of listarBackups().slice(30)) fs.rmSync(path.join(config.backupDir, antigo.nome), { force: true });
  } catch (e) {
    console.error('Falha no backup automático:', e);
  }
}
