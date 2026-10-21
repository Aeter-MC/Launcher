; Stub of AeterMC-Setup.exe: electron-builder's portable.nsi plus our animated splash
; (build/splash.exe, see scripts/render-splash.js). scripts/build.js substitutes it for the stock
; template only for the setup build. The splash starts before unpacking and closes itself once
; the installer window is shown or this stub exits.
!include "common.nsh"
!include "extractAppPackage.nsh"

CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

Function .onInit
  SetSilent silent
  !insertmacro check64BitAndSetRegView
FunctionEnd

Section
  InitPluginsDir
  File /oname=$PLUGINSDIR\splash.exe "@AETER_SPLASH@"
  System::Call 'kernel32::GetCurrentProcessId() i .r1'
  Exec '"$PLUGINSDIR\splash.exe" $1'

  StrCpy $INSTDIR "$PLUGINSDIR\app"
  !ifdef UNPACK_DIR_NAME
    StrCpy $INSTDIR "$TEMP\${UNPACK_DIR_NAME}"
  !endif

  RMDir /r $INSTDIR
  SetOutPath $INSTDIR

  !ifdef APP_DIR_64
    File /r "${APP_DIR_64}\*.*"
  !else
    !insertmacro extractEmbeddedAppPackage
  !endif

  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
  ${StdUtils.GetAllParameters} $R0 0

  ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
  SetErrorLevel $0

  SetOutPath $EXEDIR
  RMDir /r $INSTDIR
SectionEnd
