// Monta o instalador .exe a partir de release/win-unpacked usando o makensis (Linux/macOS/Windows), sem wine.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const versao = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const origem = path.resolve('release/win-unpacked');
const ico = path.resolve('build/icon.ico');
const saida = path.resolve(`release/Kontor-Transportadora-Instalador-${versao}.exe`);

// localiza o NSIS: o que o electron-builder baixou ou, se não houver, o makensis instalado no sistema (apt install nsis)
const cache = path.join(process.env.ELECTRON_BUILDER_CACHE ?? path.join(os.homedir(), '.cache', 'electron-builder'), 'nsis-3.0.4.1');
const pasta = fs.existsSync(cache) ? fs.readdirSync(cache).map((d) => path.join(cache, d)).find((d) => fs.existsSync(path.join(d, 'Stubs'))) : undefined;
let makensis = 'makensis';
if (pasta) makensis = process.platform === 'win32' ? path.join(pasta, 'makensis.exe') : path.join(pasta, process.platform === 'darwin' ? 'mac' : 'linux', 'makensis');

execFileSync('node', ['scripts/embutir-icone.mjs', path.join(origem, 'Kontor Gestão Transportadora.exe'), ico, versao], { stdio: 'inherit' });
fs.rmSync(saida, { force: true });
execFileSync(makensis, [`-DVERSAO=${versao}`, `-DSAIDA=${saida}`, `-DORIGEM=${origem}`, `-DICONE=${ico}`, 'build/instalador.nsi'],
  { stdio: 'inherit', env: { ...process.env, ...(pasta ? { NSISDIR: pasta } : {}), LC_ALL: process.platform === 'win32' ? process.env.LC_ALL : 'C.UTF-8' } });
console.log('Instalador gerado:', saida);
