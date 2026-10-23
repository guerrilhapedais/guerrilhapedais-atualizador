@echo off
cd /d "%~dp0"
echo.
echo  Guerrilha PRO - Editor (USB ou Bluetooth)
echo  --------------------------------
echo  SoftAP/Wi-Fi continua no pedal (192.168.4.1).
echo  Este editor liga por USB CDC ou por Bluetooth.
echo.
echo  1) USB: modo USB = MIDI Device / CDC. Bluetooth: Periferico ou Dual
echo  2) Abra no Chrome/Edge:
echo     http://127.0.0.1:8765/controlador-midi.html
echo  3) Clique no botao de ligar - escolha USB ou Bluetooth
echo  4) Edite / restaure backup (pelo cabo e mais rapido)
echo.
echo  (Nao abra o .html em file://)
echo.
start "" "http://127.0.0.1:8765/controlador-midi.html"
py -3 -m http.server 8765 2>nul || python -m http.server 8765
pause
