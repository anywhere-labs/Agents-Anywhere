@echo off
@rem ---------------------------------------------------------------------------
@rem Agents Anywhere HarmonyOS build entry point.
@rem
@rem Unlike a DevEco-generated project this wrapper does not download hvigor from
@rem the network. It resolves the hvigor bundled with the local DevEco Studio
@rem installation, which keeps the build reproducible offline and pins the build
@rem system to the same version the IDE uses.
@rem
@rem Set DEVECO_HOME to override the installation directory.
@rem
@rem Usage:
@rem   hvigorw.bat assembleHap
@rem   hvigorw.bat clean
@rem ---------------------------------------------------------------------------
setlocal

if not defined DEVECO_HOME (
  if exist "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js" (
    set "DEVECO_HOME=C:\Program Files\Huawei\DevEco Studio"
  ) else if exist "%LOCALAPPDATA%\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js" (
    set "DEVECO_HOME=%LOCALAPPDATA%\Huawei\DevEco Studio"
  )
)

if not defined DEVECO_HOME (
  echo ERROR: DevEco Studio was not found.
  echo Set DEVECO_HOME to the DevEco Studio installation directory and retry.
  exit /b 1
)

if not defined DEVECO_SDK_HOME set "DEVECO_SDK_HOME=%DEVECO_HOME%\sdk"

set "HVIGOR_JS=%DEVECO_HOME%\tools\hvigor\bin\hvigorw.js"
set "NODE_EXE=%DEVECO_HOME%\tools\node\node.exe"

if not exist "%HVIGOR_JS%" (
  echo ERROR: hvigor was not found at "%HVIGOR_JS%".
  exit /b 1
)

if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"

"%NODE_EXE%" "%HVIGOR_JS%" %*
exit /b %ERRORLEVEL%
