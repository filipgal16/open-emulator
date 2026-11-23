; The Windows installer for open-emulator. Built by `cargo xtask dist`, which passes:
;
;   /DVERSION=x.y.z      the app's version
;   /DSTAGE=<folder>     the staged app: open-emulator.exe, android\, and the licence files
;   /DOUTFILE=<path>     where to write the installer
;   /DICON=<path>        optional: the app icon (.ico)
;
; Per-user, like the Electron installer it replaces: no administrator rights, installed under
; %LOCALAPPDATA%\Programs\open-emulator, the folder changeable. App data — settings, the account,
; the downloaded Android — is never touched by installing or uninstalling.
;
; It also takes over from the Electron version. That version's updater runs the newest release's
; installer with `--updated /S --force-run`, into the folder it is installed in; this installer
; removes the Electron files it finds there, and that version's entry in Apps & features, then
; puts itself in their place. Shortcuts keep their paths, so the ones the user has keep working.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !error "pass /DVERSION=x.y.z"
!endif
!ifndef STAGE
  !error "pass /DSTAGE=<folder holding the staged app>"
!endif
!ifndef OUTFILE
  !define OUTFILE "open-emulator-Setup-${VERSION}.exe"
!endif

!define APP "open-emulator"
!define EXE "open-emulator.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
!define SETTINGS_KEY "Software\${APP}"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${SETTINGS_KEY}" "InstallLocation"
BrandingText "${APP} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} installer"
VIAddVersionKey "CompanyName" "open-emulator contributors"
VIAddVersionKey "LegalCopyright" "open-emulator contributors"

!ifdef ICON
  !define MUI_ICON "${ICON}"
  !define MUI_UNICON "${ICON}"
!endif
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; Sets $R2 to 1 when $R1 occurs in $R0 (case-insensitive, as StrCmp is), else 0.
Function StrContains
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrCpy $R4 0
  StrCpy $R2 0
  loop:
    StrCpy $R5 $R0 $R3 $R4
    StrCmp $R5 "" done
    StrCmp $R5 $R1 found
    IntOp $R4 $R4 + 1
    Goto loop
  found:
    StrCpy $R2 1
  done:
  Pop $R5
  Pop $R4
  Pop $R3
FunctionEnd

; Asks a running copy to close — the same request as its close button, so it lets the emulator's
; window go before it exits — and gives it a moment to do so.
!macro CloseRunningApp
  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM ${EXE}'
  Pop $0
  ${If} $0 == 0
    Sleep 2500
  ${EndIf}
!macroend

; Removes what the Electron version installed, file by file: never the folder as a whole, which
; the user may have chosen to be somewhere that holds other things.
Function RemoveElectron
  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\vk_swiftshader_icd.json"
    Delete "$INSTDIR\LICENSE.electron.txt"
    Delete "$INSTDIR\LICENSES.chromium.html"
    Delete "$INSTDIR\Uninstall ${APP}.exe"
    Delete "$INSTDIR\${EXE}"
  ${EndIf}

  ; Its entry in Apps & features, recognised by the name of its uninstaller.
  StrCpy $3 0
  next_key:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $3
    StrCmp $1 "" keys_done
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    StrCpy $R1 "Uninstall ${APP}.exe"
    Call StrContains
    ${If} $R2 == 1
    ${AndIf} $1 != "${APP}"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1"
      Goto next_key
    ${EndIf}
    IntOp $3 $3 + 1
    Goto next_key
  keys_done:
FunctionEnd

Section "${APP}"
  !insertmacro CloseRunningApp
  SetOutPath "$INSTDIR"
  Call RemoveElectron
  File /r "${STAGE}\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${SETTINGS_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "open-emulator contributors"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" $0

  CreateShortCut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"
  CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}"

  ; An update — from the Electron updater or this app's own — asks for the app to come back.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  !insertmacro CloseRunningApp
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LICENSING.md"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.md"
  RMDir /r "$INSTDIR\android"
  ; Only if it is now empty: the folder may hold things that are not ours.
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${SETTINGS_KEY}"
  ; Settings, the account and the downloaded Android are the user's, and stay.
SectionEnd
