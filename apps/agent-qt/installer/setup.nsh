!define CODEXER_SETUP_CHECK_EXE "${__FILEDIR__}\..\build\Release\CodexerAgentSetupCheck.exe"

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.CheckAgentBeforeUninstall
  !else
    Call CheckAgentBeforeInstall
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customPageAfterChangeDir
    # The assisted template skips its section check in the elevated instance.
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW CheckAgentInElevatedInstall
    Function CheckAgentInElevatedInstall
      ${If} ${UAC_IsInnerInstance}
        Call CheckAgentBeforeInstall
      ${EndIf}
    FunctionEnd
  !macroend

  !macro customInit
    ${If} ${Silent}
    ${AndIf} ${UAC_IsInnerInstance}
      !insertmacro setInstallModePerAllUsers
      Call CheckAgentBeforeInstall
    ${EndIf}
  !macroend
!endif

!macro runAgentProcessCheck operation
  InitPluginsDir
  File /oname=$PLUGINSDIR\CodexerAgentSetupCheck.exe "${CODEXER_SETUP_CHECK_EXE}"
  StrCpy $R3 $HWNDPARENT
  ${If} ${Silent}
    StrCpy $R3 "--silent"
  ${EndIf}
  ClearErrors
  ExecWait '"$PLUGINSDIR\CodexerAgentSetupCheck.exe" $R3 ${operation} "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$R1" "$R2"' $R0
  ${If} ${Errors}
    StrCpy $R0 1603
  ${EndIf}
  ${If} $R0 != 0
    ${If} $R0 != 1602
      MessageBox MB_OK|MB_ICONSTOP "无法确认 Codexer Agent 已退出。请退出 Agent 后重试。" /SD IDOK
    ${EndIf}
    SetErrorLevel $R0
    Quit
  ${EndIf}
!macroend

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    Function un.CheckAgentBeforeUninstall
      StrCpy $R1 ""
      StrCpy $R2 ""
      !insertmacro runAgentProcessCheck uninstall
    FunctionEnd
  !else
    Function CheckAgentBeforeInstall
      StrCpy $R1 ""
      ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $R2 != ""
        StrCpy $R1 "$R2\${APP_EXECUTABLE_FILENAME}"
      ${EndIf}
      StrCpy $R2 ""
      ${If} $installMode == "all"
        ReadRegStr $R2 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${If} $R2 != ""
          StrCpy $R2 "$R2\${APP_EXECUTABLE_FILENAME}"
        ${EndIf}
      ${EndIf}
      !insertmacro runAgentProcessCheck install
    FunctionEnd
  !endif
!macroend
