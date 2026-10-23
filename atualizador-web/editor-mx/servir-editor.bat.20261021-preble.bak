@echo off
cd /d "%~dp0"
echo.
echo  Guerrilha PRO - Editor USB ONLY
echo  --------------------------------
echo  SoftAP/Wi-Fi continua no pedal (192.168.4.1).
echo  Este editor fala so por USB CDC.
echo.
echo  1) Ligue o pedal por USB (modo USB = MIDI Device / CDC)
echo  2) Abra no Chrome/Edge:
echo     http://127.0.0.1:8765/controlador-midi.html
echo  3) Clique USB - escolha a porta CDC
echo  4) Edite / restaure backup por cabo
echo.
echo  (Nao abra o .html em file://)
echo.
start "" "http://127.0.0.1:8765/controlador-midi.html"
py -3 -m http.server 8765 2>nul || python -m http.server 8765
pause
