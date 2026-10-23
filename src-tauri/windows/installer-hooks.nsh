; The updater always runs the installer with /UPDATE, which skips the Start menu and desktop shortcuts on the
; assumption that they already exist. Started from the portable build nothing is installed yet, so a first install
; drops update mode and gets the shortcuts a passive install makes. An existing install keeps the shortcuts its
; user chose.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
  ${AndIfNot} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $UpdateMode 0
  ${EndIf}
!macroend
