; Instalador do Kontor Gestão Transportadora (Windows). Instalação por usuário: não pede senha de administrador.
Unicode true
!include "MUI2.nsh"

!ifndef VERSAO
  !define VERSAO "3.13.1"
!endif
!define NOME "Kontor Gestão Transportadora"
!define EXE "Kontor Gestão Transportadora.exe"
!define CHAVE "Software\Microsoft\Windows\CurrentVersion\Uninstall\KontorTransportadora"

Name "${NOME}"
OutFile "${SAIDA}"
; Pasta própria. As versões 1.0.0 a 1.0.3 instalavam por engano em "Programs\Kontor Gestao", a pasta do Kontor Gestão Empresas.
; O valor "Pasta" do registro apontava para lá, por isso a leitura usa um valor novo ("PastaPrograma").
InstallDir "$LOCALAPPDATA\Programs\Kontor Gestao Transportadora"
InstallDirRegKey HKCU "Software\KontorTransportadora" "PastaPrograma"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${NOME} ${VERSAO}"

VIProductVersion "${VERSAO}.0"
VIAddVersionKey /LANG=1046 "ProductName" "${NOME}"
VIAddVersionKey /LANG=1046 "FileDescription" "Instalador do ${NOME}"
VIAddVersionKey /LANG=1046 "FileVersion" "${VERSAO}"

!define MUI_ICON "${ICONE}"
!define MUI_UNICON "${ICONE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o ${NOME} agora"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

!define PASTA_EMPRESAS "$LOCALAPPDATA\Programs\Kontor Gestao"

Function .onVerifyInstDir
  ; a pasta do Kontor Gestão Empresas não pode ser usada
  StrCmp "$INSTDIR" "${PASTA_EMPRESAS}" 0 +2
    Abort
  IfFileExists "$INSTDIR\Kontor Gestão.exe" 0 +2
    Abort
FunctionEnd

Section "Instalar"
  ; fecha o programa se estiver aberto (atualização)
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Pop $0
  Sleep 600

  ; restos das versões 1.0.0 a 1.0.3, que se instalaram dentro da pasta do Kontor Gestão Empresas:
  ; remove só o executável da Transportadora de lá (nada do Empresas é apagado aqui)
  IfFileExists "${PASTA_EMPRESAS}\Kontor Gestão Transportadora.exe" 0 semResto
    Delete "${PASTA_EMPRESAS}\Kontor Gestão Transportadora.exe"
    Delete "${PASTA_EMPRESAS}\kontor-transp-verde.ico"
    IfFileExists "${PASTA_EMPRESAS}\Kontor Gestão.exe" 0 semResto
      MessageBox MB_OK|MB_ICONEXCLAMATION "Uma versão anterior deste instalador gravou arquivos dentro da pasta do Kontor Gestão Empresas.$\r$\n$\r$\nDepois desta instalação, reinstale o Kontor Gestão Empresas (última versão) para restaurar o programa. Os dados do Empresas não foram apagados."
  semResto:

  ; atualização: limpa só os arquivos do programa da versão anterior (os dados ficam em %APPDATA%)
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"

  SetOutPath "$INSTDIR"
  File /r "${ORIGEM}/*.*"
  WriteUninstaller "$INSTDIR\Desinstalar.exe"

  ; atalhos com o nome antigo (versões anteriores)
  Delete "$DESKTOP\Kontor Gestão Transportadora.lnk"
  RMDir /r "$SMPROGRAMS\Kontor Gestão Transportadora"
  ; ícone dos atalhos em arquivo próprio: trocar o nome do arquivo quando o ícone mudar obriga o Windows a
  ; descartar o ícone guardado em cache (área de trabalho, menu Iniciar e o fixado na barra de tarefas)
  Delete "$INSTDIR\kontor-transp*.ico"
  File "/oname=$INSTDIR\kontor-transp-verde.ico" "${ICONE}"
  CreateShortcut "$DESKTOP\${NOME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\kontor-transp-verde.ico" 0
  CreateDirectory "$SMPROGRAMS\${NOME}"
  CreateShortcut "$SMPROGRAMS\${NOME}\${NOME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\kontor-transp-verde.ico" 0
  IfFileExists "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${NOME}.lnk" 0 +2
    CreateShortcut "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${NOME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\kontor-transp-verde.ico" 0
  CreateShortcut "$SMPROGRAMS\${NOME}\Desinstalar.lnk" "$INSTDIR\Desinstalar.exe"
  ; avisa o Windows que os ícones mudaram (atualiza o cache sem precisar reiniciar)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  WriteRegStr HKCU "Software\KontorTransportadora" "PastaPrograma" "$INSTDIR"
  DeleteRegValue HKCU "Software\KontorTransportadora" "Pasta"
  WriteRegStr HKCU "${CHAVE}" "DisplayName" "${NOME}"
  WriteRegStr HKCU "${CHAVE}" "DisplayVersion" "${VERSAO}"
  WriteRegStr HKCU "${CHAVE}" "Publisher" "${NOME}"
  WriteRegStr HKCU "${CHAVE}" "DisplayIcon" "$INSTDIR\kontor-transp-verde.ico"
  WriteRegStr HKCU "${CHAVE}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${CHAVE}" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegDWORD HKCU "${CHAVE}" "NoModify" 1
  WriteRegDWORD HKCU "${CHAVE}" "NoRepair" 1
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Pop $0
  Sleep 600
  Delete "$DESKTOP\${NOME}.lnk"
  RMDir /r "$SMPROGRAMS\${NOME}"
  StrCmp "$INSTDIR" "${PASTA_EMPRESAS}" 0 +3
    Delete "$INSTDIR\${EXE}"
    Goto fimPasta
  RMDir /r "$INSTDIR"
  fimPasta:
  DeleteRegKey HKCU "${CHAVE}"
  DeleteRegKey HKCU "Software\KontorTransportadora"
  ; Os dados (notas, cadastros, backups) ficam em %APPDATA%\Kontor Gestão Transportadora e NÃO são apagados.
  MessageBox MB_OK|MB_ICONINFORMATION "${NOME} foi removido.$\r$\n$\r$\nSuas notas e cadastros continuam guardados em:$\r$\n$APPDATA\Kontor Gestão Transportadora$\r$\n$\r$\nApague essa pasta somente se não precisar mais dos dados."
SectionEnd
