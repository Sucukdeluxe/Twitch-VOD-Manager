!macro customInit
  ; Kill running Twitch VOD Manager process before installation
  nsExec::ExecToLog 'taskkill /F /IM "Twitch VOD Manager.exe"'
!macroend
