@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ============================================================
echo   Guerrilha Pedais - servidor local (NÃO abrir index.html a direito)
echo   O browser TEM de usar http://localhost:8765
echo  ============================================================
echo.
set PORT=8765
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" "http://127.0.0.1:%PORT%/"
  py -3 -m http.server %PORT%
  exit /b 0
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" "http://127.0.0.1:%PORT%/"
  python -m http.server %PORT%
  exit /b 0
)
echo  ERRO: Instala Python 3 e volta a correr este ficheiro.
echo  https://www.python.org/downloads/
pause
exit /b 1
