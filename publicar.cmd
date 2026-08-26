@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -File "%~dp0scripts\release\publicar.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" echo Empacotamento encerrado com erro. Verifique a mensagem acima e a política de execução do Windows PowerShell.
pause
exit /b %EXITCODE%
