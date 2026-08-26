@echo off
setlocal
chcp 65001 >nul
set "SCRIPT=%~dp0Executar.ps1"
set "MANUAL=%~dp0Documentacao\Gerada\Manual-Usuario\index.html"
if not exist "%SCRIPT%" (
  echo Erro: não foi possível iniciar o Executar.ps1 do SelfMinifier.
  exit /b 1
)
set "PSPOLICY="
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -NonInteractive -Command "Get-ExecutionPolicy" 2^>nul`) do set "PSPOLICY=%%P"
if /I "%PSPOLICY%"=="Restricted" (
  echo Erro: a política de execução do Windows PowerShell não permite executar scripts locais.
  echo O SelfMinifier não altera nem contorna essa política de segurança.
  echo Consulte a seção de solução de problemas no manual offline:
  echo %MANUAL%
  set "EXITCODE=1"
  goto :failure
)
powershell.exe -NoProfile -File "%SCRIPT%"
set "EXITCODE=%ERRORLEVEL%"
if "%EXITCODE%"=="0" exit /b 0
echo.
echo Se a mensagem acima indicar bloqueio de política do PowerShell, consulte:
echo %MANUAL%
:failure
echo.
echo O SelfMinifier foi encerrado com erro. Codigo: %EXITCODE%
pause
exit /b %EXITCODE%
