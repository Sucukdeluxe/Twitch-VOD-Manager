!macro customInit
  ; Kill running Twitch VOD Manager process before installation
  nsExec::ExecToLog 'taskkill /F /IM "Twitch VOD Manager.exe"'
!macroend

!macro customInstall
  CreateDirectory "$LOCALAPPDATA\Twitch VOD Manager\Shortcut Icons"
  CopyFiles /SILENT "$INSTDIR\resources\app-icons\icon-${VERSION}.ico" "$LOCALAPPDATA\Twitch VOD Manager\Shortcut Icons"
  StrCpy $0 "$LOCALAPPDATA\Twitch VOD Manager\Shortcut Icons\icon-${VERSION}.ico"
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
  ${if} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Twitch VOD Manager\Shortcut Icons"
  ${endIf}
!macroend
