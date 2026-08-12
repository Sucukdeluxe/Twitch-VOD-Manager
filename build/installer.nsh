!macro customInit
  ; Kill running Twitch VOD Manager process before installation
  nsExec::ExecToLog 'taskkill /F /IM "Twitch VOD Manager.exe"'
!macroend

!macro preInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $0 != ""
  ${ifNot} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  ${endIf}
  ${endIf}
!macroend

!macro customInstall
  CreateDirectory "$LOCALAPPDATA\Twitch VOD Manager\Shortcut Icons"
  CopyFiles /SILENT "$INSTDIR\resources\app-icons\icon-${VERSION}.ico" "$LOCALAPPDATA\Twitch VOD Manager\Shortcut Icons"
  StrCpy $0 "$LOCALAPPDATA\Twitch VOD Manager\Shortcut Icons\icon-${VERSION}.ico"
  Delete "$SMPROGRAMS\Twitch VOD Manager v*.lnk"
  Delete "$DESKTOP\Twitch VOD Manager v*.lnk"
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  System::Call 'shell32::SHChangeNotify(i 0x00001000, i 0x0005, w "$SMPROGRAMS", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Twitch VOD Manager\Shortcut Icons"
  ${endIf}
!macroend
