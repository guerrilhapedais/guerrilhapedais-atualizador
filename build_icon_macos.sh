#!/bin/bash
# Gera icon.icns a partir de um PNG em assets/ (apenas no macOS).
# Ordem: assets/logo_final.png (logo aprovado) → assets/guerrilha_icon_1024.png (exemplo/backup).
# Opcional: export GUERRILHA_LOGO_PNG=/caminho/para/logo.png ./build_icon_macos.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
OUT="${ROOT}/icon.icns"
SET="${ROOT}/GuerrilhaPedais.iconset"

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "ignorado: build de ícone .icns só no macOS"
  exit 0
fi

if [[ -n "${GUERRILHA_LOGO_PNG:-}" && -f "${GUERRILHA_LOGO_PNG}" ]]; then
  SRC="${GUERRILHA_LOGO_PNG}"
  echo "A gerar icon.icns a partir de (GUERRILHA_LOGO_PNG) $SRC…"
elif [[ -f "${ROOT}/assets/logo_final.png" ]]; then
  SRC="${ROOT}/assets/logo_final.png"
  echo "A gerar icon.icns a partir de assets/logo_final.png…"
elif [[ -f "${ROOT}/assets/guerrilha_icon_1024.png" ]]; then
  SRC="${ROOT}/assets/guerrilha_icon_1024.png"
  echo "A gerar icon.icns a partir de assets/guerrilha_icon_1024.png (fallback)…"
else
  echo "aviso: mete o logo em ${ROOT}/assets/logo_final.png (PNG, ideal 1024×1024) ou defina GUERRILHA_LOGO_PNG" >&2
  exit 0
fi

if ! command -v sips &>/dev/null || ! command -v iconutil &>/dev/null; then
  echo "aviso: sips/iconutil em falta (Xcode CLT?)" >&2
  exit 0
fi

rm -rf "$SET"
mkdir "$SET"

# Tamanhos exigidos para iconset
sips -z 16 16     "$SRC" --out "$SET/icon_16x16.png"            >/dev/null
sips -z 32 32     "$SRC" --out "$SET/icon_16x16@2x.png"         >/dev/null
sips -z 32 32     "$SRC" --out "$SET/icon_32x32.png"            >/dev/null
sips -z 64 64     "$SRC" --out "$SET/icon_32x32@2x.png"         >/dev/null
sips -z 128 128   "$SRC" --out "$SET/icon_128x128.png"          >/dev/null
sips -z 256 256   "$SRC" --out "$SET/icon_128x128@2x.png"       >/dev/null
sips -z 256 256   "$SRC" --out "$SET/icon_256x256.png"          >/dev/null
sips -z 512 512   "$SRC" --out "$SET/icon_256x256@2x.png"       >/dev/null
sips -z 512 512   "$SRC" --out "$SET/icon_512x512.png"          >/dev/null
sips -z 1024 1024 "$SRC" --out "$SET/icon_512x512@2x.png"      >/dev/null

iconutil -c icns "$SET" -o "$OUT"
rm -rf "$SET"
echo "→ $OUT"
