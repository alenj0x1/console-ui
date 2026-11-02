; Console UI installer hooks (included by Tauri's NSIS template).
;
; - Welcome page: an optional "install HidHide" check box, shown only when
;   HidHide is not installed. Silent/passive installs take `/HIDHIDE` instead.
; - After installing: runs hidhide.ps1, which downloads the official signed
;   HidHide release, checks its SHA-256 and Authenticode signature and runs
;   it (HidHide asks for administrator rights itself). A failure never stops
;   Console UI's own install.
; - The app hides the controller from other apps while it drives Windows and
;   shows it again when it exits. Updates and uninstalls close it by force,
;   so they show the controller again here (only when Console UI is one of
;   HidHide's allowed apps) and the uninstaller removes it from that list.
;
; This file is included before the template declares its pages and
; variables: functions here use only their own variables; the hook macros
; are expanded inside the template's sections, where everything exists.

!include nsDialogs.nsh
!include LogicLib.nsh

!define HIDHIDE_CLI "$PROGRAMFILES64\Nefarius Software Solutions\HidHide\x64\HidHideCLI.exe"
!define LANGID_SPANISH 1034

${UnStrLoc}

Var HidHideBox
Var HidHideWanted

; Consumed by the template's MUI_PAGE_WELCOME, the first page it declares.
!define MUI_PAGE_CUSTOMFUNCTION_SHOW HidHideWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE HidHideWelcomeLeave

Function HidHideWelcomeShow
  StrCpy $HidHideWanted 0
  ${If} ${FileExists} "${HIDHIDE_CLI}"
    Return
  ${EndIf}
  ${If} $LANGUAGE = ${LANGID_SPANISH}
    StrCpy $1 "Instalar también HidHide (recomendado): evita que el menú Inicio y otras apps reaccionen al control mientras lo usas como mouse. Se descarga de su página oficial en GitHub y pide permiso de administrador."
  ${Else}
    StrCpy $1 "Also install HidHide (recommended): keeps the Start menu and other apps from reacting to the controller while you use it as a mouse. Downloaded from its official GitHub release; asks for administrator rights."
  ${EndIf}
  ; Make room under the welcome text (120u 45u 195u 130u in MUI2): replace it
  ; with a shorter copy. MUI's own variables are declared after this file,
  ; so find it as the page's last control (image, title, text).
  FindWindow $2 "#32770" "" $HWNDPARENT
  System::Call "user32::GetWindow(p r2, i 5) p .r3" ; GW_CHILD
  System::Call "user32::GetWindow(p r3, i 1) p .r3" ; GW_HWNDLAST
  ${NSD_GetText} $3 $0
  ShowWindow $3 ${SW_HIDE}
  ${NSD_CreateLabel} 120u 45u 195u 100u "$0"
  Pop $0
  SetCtlColors $0 "000000" "FFFFFF"
  ${NSD_CreateCheckbox} 120u 145u 195u 44u "$1"
  Pop $HidHideBox
  ${NSD_AddStyle} $HidHideBox ${BS_MULTILINE}|${BS_TOP}
  SetCtlColors $HidHideBox "000000" "FFFFFF"
  ${NSD_Check} $HidHideBox
FunctionEnd

Function HidHideWelcomeLeave
  ${If} $HidHideBox <> 0
    ${NSD_GetState} $HidHideBox $HidHideWanted
  ${EndIf}
FunctionEnd

; Downloads, checks and runs the HidHide installer.
Function HidHideInstall
  ${If} $LANGUAGE = ${LANGID_SPANISH}
    DetailPrint "Descargando e instalando HidHide…"
  ${Else}
    DetailPrint "Downloading and installing HidHide…"
  ${EndIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\hidhide.ps1" "${__FILEDIR__}\hidhide.ps1"
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\hidhide.ps1" -Folder "$PLUGINSDIR"'
  Pop $0
  Delete "$PLUGINSDIR\hidhide.ps1"

  ${If} $0 = 0
  ${OrIf} $0 = 3010
    ${If} ${FileExists} "${HIDHIDE_CLI}"
      ${If} $LANGUAGE = ${LANGID_SPANISH}
        DetailPrint "HidHide quedó instalado."
        ${If} $0 = 3010
          MessageBox MB_ICONINFORMATION|MB_OK "Reinicia Windows para terminar de instalar HidHide." /SD IDOK
        ${EndIf}
      ${Else}
        DetailPrint "HidHide is installed."
        ${If} $0 = 3010
          MessageBox MB_ICONINFORMATION|MB_OK "Restart Windows to finish installing HidHide." /SD IDOK
        ${EndIf}
      ${EndIf}
      Return
    ${EndIf}
  ${EndIf}

  ${If} $LANGUAGE = ${LANGID_SPANISH}
    ${If} $0 = 10
      StrCpy $1 "No se pudo descargar HidHide. Revisa la conexión a internet."
    ${ElseIf} $0 = 11
    ${OrIf} $0 = 12
      StrCpy $1 "La descarga de HidHide no es la versión oficial esperada, así que no se instaló."
    ${ElseIf} $0 = 13
      StrCpy $1 "HidHide no se instaló porque no se dio el permiso de administrador."
    ${Else}
      StrCpy $1 "HidHide no se instaló (código $0)."
    ${EndIf}
    StrCpy $1 "$1$\r$\n$\r$\nConsole UI funciona igual sin él. Puedes instalarlo después desde github.com/nefarius/HidHide."
  ${Else}
    ${If} $0 = 10
      StrCpy $1 "HidHide could not be downloaded. Check the internet connection."
    ${ElseIf} $0 = 11
    ${OrIf} $0 = 12
      StrCpy $1 "The HidHide download is not the expected official release, so it was not installed."
    ${ElseIf} $0 = 13
      StrCpy $1 "HidHide was not installed because administrator rights were not granted."
    ${Else}
      StrCpy $1 "HidHide was not installed (code $0)."
    ${EndIf}
    StrCpy $1 "$1$\r$\n$\r$\nConsole UI works without it. You can install it later from github.com/nefarius/HidHide."
  ${EndIf}
  DetailPrint "$1"
  MessageBox MB_ICONEXCLAMATION|MB_OK "$1" /SD IDOK
FunctionEnd

; Sets $R0 to HidHide's allowed-apps list ("" without HidHide).
!macro HidHideAppList
  StrCpy $R0 ""
  ${If} ${FileExists} "${HIDHIDE_CLI}"
    nsExec::ExecToStack '"${HIDHIDE_CLI}" --app-list'
    Pop $R1
    Pop $R0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2

  ; An update closed the app: make sure games can see the controller.
  !insertmacro HidHideAppList
  ${StrLoc} $R2 $R0 '"$INSTDIR\${MAINBINARYNAME}.exe"' ">"
  ${If} $R2 != ""
    nsExec::Exec '"${HIDHIDE_CLI}" --cloak-off'
    Pop $R1
  ${EndIf}

  ; Optional HidHide: the welcome page's check box, or /HIDHIDE when silent.
  StrCpy $R2 $HidHideWanted
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    StrCpy $R2 0
    ClearErrors
    ${GetOptions} $CMDLINE "/HIDHIDE" $R1
    ${IfNot} ${Errors}
      StrCpy $R2 1
    ${EndIf}
  ${EndIf}
  ${If} $R2 = 1
  ${AndIfNot} ${FileExists} "${HIDHIDE_CLI}"
    Call HidHideInstall
  ${EndIf}

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Push $R0
  Push $R1
  Push $R2

  !insertmacro HidHideAppList
  ${UnStrLoc} $R2 $R0 '"$INSTDIR\${MAINBINARYNAME}.exe"' ">"
  ${If} $R2 != ""
    ; The app was closed by force: show the controller again.
    nsExec::Exec '"${HIDHIDE_CLI}" --cloak-off'
    Pop $R1
    ${If} $UpdateMode <> 1
      nsExec::Exec '"${HIDHIDE_CLI}" --app-unreg "$INSTDIR\${MAINBINARYNAME}.exe"'
      Pop $R1
    ${EndIf}
  ${EndIf}

  Pop $R2
  Pop $R1
  Pop $R0
!macroend
