// Troca o ícone e os textos de versão dentro do .exe do Electron, sem precisar de wine/rcedit.
import fs from 'node:fs';
import * as ResEdit from 'resedit';

const [, , exe, ico, versao] = process.argv;
const bin = ResEdit.NtExecutable.from(fs.readFileSync(exe));
const res = ResEdit.NtExecutableResource.from(bin);

// ícone
const icones = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
const grupo = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)[0];
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, grupo.id, grupo.lang, icones.icons.map((i) => i.data));

// versão e nomes exibidos no Windows (Gerenciador de Tarefas, propriedades do arquivo)
const [v] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const partes = versao.split('.').map(Number);
v.setFileVersion(partes[0], partes[1] ?? 0, partes[2] ?? 0, 0, v.lang ?? 1033);
v.setProductVersion(partes[0], partes[1] ?? 0, partes[2] ?? 0, 0, v.lang ?? 1033);
v.setStringValues({ lang: v.getAllLanguagesForStringValues()[0]?.lang ?? 1033, codepage: 1200 }, {
  ProductName: 'Kontor Gestão Transportadora', FileDescription: 'Kontor Gestão Transportadora', CompanyName: 'Kontor Gestão Transportadora',
  InternalName: 'Kontor Gestão Transportadora', OriginalFilename: 'Kontor Gestão Transportadora.exe', LegalCopyright: 'Kontor Gestão Transportadora',
});
v.outputToResourceEntries(res.entries);
res.outputResource(bin);
fs.writeFileSync(exe, Buffer.from(bin.generate()));
console.log('ícone e versão embutidos em', exe);
