@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo Guerrilha Pedais - Build Windows (.exe)
echo ========================================

where py >nul 2>&1
if %errorlevel%==0 (
  py -3 -m pip install -r requirements.txt
  if errorlevel 1 exit /b 1
  py -3 -m PyInstaller guerrilhabox_updater_windows.spec --clean --noconfirm
) else (
  where python >nul 2>&1
  if errorlevel 1 (
    echo Instala Python 3: https://www.python.org/downloads/ ^(marca tcl/tk^)
    exit /b 1
  )
  python -m pip install -r requirements.txt
  if errorlevel 1 exit /b 1
  python -m PyInstaller guerrilhabox_updater_windows.spec --clean --noconfirm
)
if errorlevel 1 (
  echo PyInstaller falhou; ver cima.
  exit /b 1
)
if exist "dist\GuerrilhaPedais_Atualizador.exe" (
  echo.
  echo OK: dist\GuerrilhaPedais_Atualizador.exe
  start "" "dist"
) else (
  echo O .exe nao apareceu em dist. Ver cima.
  exit /b 1
)
exit /b 0
