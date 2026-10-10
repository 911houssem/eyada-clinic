@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
cd /d "%~dp0"

title نظام عيادة - الخادم المحلي

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js غير مثبت على هذا الجهاز.
  echo.
  echo       الخادم يحتاج Node.js لتشغيله. ثبّته من:
  echo       https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM ── إذا كانت هناك نسخة تعمل بالفعل: افتح المتصفح ولا تبدأ نسخة ثانية ──
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   [!] There is already a server running on http://localhost:3000
  echo       Opening it in your browser instead of starting a second copy.
  echo.
  start "" "http://localhost:3000"
  timeout /t 4 >nul
  exit /b 0
)

REM ── تشغيل الخادم ──
echo.
echo   Starting the local server...  (close this window with Ctrl+C to stop)
echo.
node server.js %*
set EXITCODE=%errorlevel%

echo.
if "%EXITCODE%"=="0" (
  echo   Server stopped.
) else (
  echo   [X] The server stopped with an error ^(code %EXITCODE%^).
  echo       If the message above says the port is already in use, another
  echo       copy is running - open http://localhost:3000 , or start this
  echo       file again with:  start-server.bat --auto-port
)
echo.
echo   Full details: "%~dp0data\server.log"
echo.
pause
exit /b %EXITCODE%