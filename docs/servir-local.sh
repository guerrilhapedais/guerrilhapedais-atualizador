#!/bin/bash
# Coloca a página a correr em http://localhost:8765 (faz duplo nisto no Mac/Linux ou: chmod +x e ./servir-local.sh)
cd "$(dirname "$0")"
PORT=8765
echo ""
echo "  Guerrilha Pedais — abre no Chrome/Edge: http://127.0.0.1:$PORT"
echo "  (Ctrl+C para parar) Não abras o index.html ficheiro a direito."
echo ""
if command -v open &>/dev/null; then
  ( sleep 1 && open "http://127.0.0.1:$PORT/" ) &
fi
if command -v python3 &>/dev/null; then
  python3 -m http.server "$PORT"
elif command -v python &>/dev/null; then
  python -m http.server "$PORT"
else
  echo "Instala Python 3 (brew install python3) e corre de novo."
  exit 1
fi
