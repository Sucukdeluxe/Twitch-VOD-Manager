; Inno Setup Script for Twitch VOD Manager
; Version 3.3.5

#define MyAppName "Twitch VOD Manager"
#define MyAppVersion "3.5.3"
#define MyAppPublisher "Twitch VOD Manager"
#define MyAppExeName "Twitch_VOD_Manager.exe"

[Setup]
AppId={{8A7B9C0D-1E2F-3A4B-5C6D-7E8F9A0B1C2D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=installer_output
OutputBaseFilename=Twitch_VOD_Manager_Setup_{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Bei normaler Installation: Checkbox "Programm starten"
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  DataDir: String;
  TempDir: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    // Erstelle ProgramData Ordner fuer Settings
    DataDir := ExpandConstant('{commonappdata}\Twitch_VOD_Manager');
    if not DirExists(DataDir) then
      CreateDir(DataDir);

    // Bei Silent Install: Alte _MEI Ordner loeschen und App starten
    if WizardSilent then
    begin
      Sleep(5000);  // 5 Sekunden warten bis alte Prozesse beendet

      // Alte PyInstaller _MEI Ordner loeschen
      TempDir := ExpandConstant('{tmp}\..');
      Exec('cmd.exe', '/c "for /d %i in ("' + TempDir + '\_MEI*") do rd /s /q "%i"" 2>nul', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

      Sleep(1000);  // Kurz warten nach Cleanup
      Exec(ExpandConstant('{app}\{#MyAppExeName}'), '', '', SW_SHOW, ewNoWait, ResultCode);
    end;
  end;
end;
