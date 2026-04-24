#!/bin/bash

# Limpar artefactos com permissão de escrita (evita PermissionError no PyInstaller)
limpar_pastas_build() {
  for d in build dist __pycache__; do
    if [ -e "$d" ]; then
      chmod -R u+rwX "$d" 2>/dev/null || true
    fi
  done
  rm -rf build dist __pycache__ 2>/dev/null || true
}

# Ver se podemos criar/alterar a pasta build no diretório actual
pode_compilar_aqui() {
  limpar_pastas_build
  if [ -e build ] || [ -e dist ]; then
    return 1
  fi
  if ! mkdir -p build 2>/dev/null; then
    return 1
  fi
  if ! touch build/.guerrilha_wtest_$$ 2>/dev/null; then
    rm -rf build 2>/dev/null
    return 1
  fi
  rm -f build/.guerrilha_wtest_$$ 2>/dev/null
  rmdir build 2>/dev/null
  return 0
}

# Copia o projecto (menos lixo) para a pasta de build — fica igual ao teu Desktop, mas fora do iCloud
copiar_projeto_completo() {
  local orig="$1" dest="$2"
  rm -rf "$dest"
  mkdir -p "$dest" || return 1
  if command -v rsync &>/dev/null; then
    rsync -a \
      --exclude 'build' --exclude 'dist' --exclude '.git' --exclude 'terminals' \
      --exclude '__pycache__' --exclude '*/__pycache__' --exclude '.DS_Store' \
      "$orig/" "$dest/" || return 1
  else
    ( cd "$orig" && COPYFILE_DISABLE=1 tar -cf - \
        --exclude='./build' --exclude='./dist' --exclude='./.git' \
        --exclude='./__pycache__' --exclude='.DS_Store' \
        . 2>/dev/null | ( cd "$dest" && COPYFILE_DISABLE=1 tar -xf - 2>/dev/null ) ) || {
      for x in "$orig"/* "$orig"/.[!.]* "$orig"/..?*; do
        [ -e "$x" ] || continue
        b=$(basename "$x")
        case "$b" in
          .|..|build|dist|.git) continue ;;
        esac
        cp -R "$x" "$dest/" 2>/dev/null || true
      done
    }
  fi
  return 0
}

# Pasta de build: única a cada run (evita ~/guerrilhabox_build_temp "preso" a root/sudo)
criar_pasta_build_temp() {
  local t
  t=$(mktemp -d "${TMPDIR:-/tmp}/guerrilhabox_build.XXXXXX" 2>/dev/null) || t=""
  if [ -n "$t" ] && [ -d "$t" ]; then
    echo "$t"
    return 0
  fi
  t="${HOME}/guerrilhabox_local_$(date +%s)_$$"
  mkdir -m 700 "$t" 2>/dev/null || { echo "❌ Não foi possível criar pasta temporária em \$TMPDIR nem em \${HOME}."; return 1; }
  echo "$t"
  return 0
}

echo "========================================"
echo "Guerrilha Pedais - Build para macOS"
echo "========================================"
echo ""

# Verificar Xcode Command Line Tools
if ! xcode-select -p &> /dev/null; then
    echo "⚠️  Xcode Command Line Tools não encontrado!"
    echo "Instalando Xcode Command Line Tools..."
    xcode-select --install
    echo ""
    echo "Aguarde a instalação terminar e execute este script novamente."
    exit 1
fi

echo "✅ Xcode Command Line Tools encontrado!"

# Verificar Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 não encontrado!"
    echo "Instale Python 3: brew install python3"
    exit 1
fi

echo "✅ Python encontrado!"
python3 --version

echo ""
echo "Instalando dependências..."
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt

unset PYINSTALLER_TARGET_ARCH
PY_EXE=$(python3 -c 'import sys; print(sys.executable)')
if command -v lipo &>/dev/null; then
  LIPO_OUT=$(lipo -archs "$PY_EXE" 2>/dev/null || true)
  if echo "$LIPO_OUT" | grep -qw arm64 && echo "$LIPO_OUT" | grep -qw x86_64; then
    export PYINSTALLER_TARGET_ARCH=universal2
    echo ""
    echo "→ Python universal2 (arm64 + x86_64): a gerar .app para qualquer Mac (Intel e Apple Silicon)."
  else
    echo ""
    echo "→ Aviso: este Python é só uma arquitetura: ${LIPO_OUT:-?}"
    echo "  O .app só funcionará nessa família de Mac. Para abranger todos os Macs:"
    echo "  instale o pacote \"macOS 64-bit universal2\" de https://www.python.org/downloads/macos/"
    echo "  e volte a correr: ./build_macos.sh"
  fi
else
  echo ""
  echo "→ lipo indisponível; PyInstaller usa a arquitetura nativa do Python."
fi

echo ""
echo "========================================"
echo "Compilando para macOS..."
echo "========================================"

CURRENT_DIR=$(pwd)
USAR_PASTA_TEMP=0
MOTIVO_TEMP=""

# Pasta de rede VM
if [[ "$CURRENT_DIR" == *"VMware Shared Folders"* ]] || [[ "$CURRENT_DIR" == *"Parallels Shared Folders"* ]]; then
    USAR_PASTA_TEMP=1
    MOTIVO_TEMP="Pasta de rede da VM (VMware/Parallels)."
fi

# Desktop do Mac: pasta ~/Desktop/… (e iCloud) — o script compila noutro sítio e devolve o .app a dist/ aqui.
# 1) Compara o caminho real com o teu "Desktop" (incl. quando o iCloud muda o path).
_desktop_cannon=""
if [ -d "$HOME/Desktop" ]; then
  _desktop_cannon=$( (cd "$HOME/Desktop" 2>/dev/null && pwd -P) 2>/dev/null ) || _desktop_cannon=""
fi
if [ "$USAR_PASTA_TEMP" -eq 0 ] && [ -n "$_desktop_cannon" ]; then
  _cur_p=$( (cd "$CURRENT_DIR" 2>/dev/null && pwd -P) 2>/dev/null ) || _cur_p="$CURRENT_DIR"
  if [[ "$_cur_p" == "$_desktop_cannon"/* || "$_cur_p" == "$_desktop_cannon" ]]; then
    USAR_PASTA_TEMP=1
    MOTIVO_TEMP="Projecto na pasta Desktop do Mac (ou dentro dela) — a compilar noutra localização (pasta temporária com mktemp, evita iCloud) e a devolver o .app a dist/ desta localização."
  fi
fi
# 2) Fallback: texto "Desktop" no path
if [ "$USAR_PASTA_TEMP" -eq 0 ]; then
  case "$CURRENT_DIR" in
    *"/Desktop/"*|*"/Desktop" )
      USAR_PASTA_TEMP=1
      MOTIVO_TEMP="Caminho do projecto contém 'Desktop' — a compilar noutro sítio (cópia completa) e a devolver o .app a dist/."
      ;;
  esac
  if [ "$USAR_PASTA_TEMP" -eq 0 ]; then
    if [[ "$CURRENT_DIR" = *"iCloud"* || "$CURRENT_DIR" = *"iCloud Drive"* || "$CURRENT_DIR" = *"com~apple~CloudDocs"* || "$CURRENT_DIR" = *"CloudDocs"* ]]; then
      USAR_PASTA_TEMP=1
      MOTIVO_TEMP="Pasta no iCloud / CloudDocs — a compilar em pasta local no teu home (cópia completa do projecto)."
    fi
  fi
fi

# Sem permissão local
if [ "$USAR_PASTA_TEMP" -eq 0 ] && ! pode_compilar_aqui; then
    USAR_PASTA_TEMP=1
    MOTIVO_TEMP="Sem permissão de escrita para a pasta 'build' aqui. A compilar noutra localização (pasta temporária única) com cópia completa do projecto."
fi

# Forçar: GUERRILHABOX_BUILD_IN_HOME=1 ./build_macos.sh
if [ "${GUERRILHABOX_BUILD_IN_HOME:-0}" = "1" ]; then
    USAR_PASTA_TEMP=1
    MOTIVO_TEMP="Variável GUERRILHABOX_BUILD_IN_HOME=1 (cópia completa do projecto)."
fi

# --- build em folder temporário: cópia INTeira (incl. assets, scripts) ---
if [ "$USAR_PASTA_TEMP" -eq 1 ]; then
    echo "⚠️  $MOTIVO_TEMP"
    echo ""
    # Nunca usar a mesma pasta fixa no $HOME: se alguém correu com sudo, rm/mkdir dist falham
    if [ -d "$HOME/guerrilhabox_build_temp" ]; then
        echo "A limpar build antiga: $HOME/guerrilhabox_build_temp (se for 'denied', corre: sudo chown -R \$(whoami) \$HOME/guerrilhabox_build_temp  &&  rm -rf \$HOME/guerrilhabox_build_temp)…"
        chmod -R u+rwX "$HOME/guerrilhabox_build_temp" 2>/dev/null || true
        rm -rf "$HOME/guerrilhabox_build_temp" 2>/dev/null || true
    fi
    _td="$(criar_pasta_build_temp)" || exit 1
    TEMP_DIR="$_td"
    if [ -z "$TEMP_DIR" ] || [ ! -d "$TEMP_DIR" ]; then
        echo "❌ Pasta temporária inválida."
        exit 1
    fi
    echo "Pasta de compilação (só tua, não uses sudo): $TEMP_DIR"
    echo "A copiar o projecto (sem build/dist/.git)…"
    if ! copiar_projeto_completo "$CURRENT_DIR" "$TEMP_DIR"; then
      echo "❌ Falha ao copiar o projecto. Verifica espaço em disco e permissões."
      rm -rf "$TEMP_DIR" 2>/dev/null
      exit 1
    fi
    # Garantir que nada fica só-leitura (cópia do iCloud, etc.)
    chmod -R u+rwX "$TEMP_DIR" 2>/dev/null || true

    cd "$TEMP_DIR" || { rm -rf "$TEMP_DIR" 2>/dev/null; exit 1; }
    # Ícone: usa assets/ aqui; gera icon.icns nesta mesma árvore
    if [ -f "build_icon_macos.sh" ]; then
      chmod +x build_icon_macos.sh
      ./build_icon_macos.sh || echo "⚠️  Aviso: icon.icns não gerado; o .app pode sair com ícone genérico."
    fi

    limpar_pastas_build
    if ! python3 -m PyInstaller guerrilhabox_updater_macos.spec --clean --noconfirm; then
        echo ""
        echo "❌ PyInstaller falhou. Lê a mensagem em cima."
        echo "   Não corras o build com 'sudo'."
        echo "   Se for PermissionError: Sistema  >  Privacidade  >  Acesso completo ao disco: activa o Terminal (ou a app que usas em vez do Terminal)."
        echo "Pasta de debug: $TEMP_DIR  (podes: rm -rf \"\$TEMP_DIR\")"
        cd "$CURRENT_DIR" || true
        exit 1
    fi
    if [ -d "dist/GuerrilhaPedais_Atualizador.app" ]; then
        mkdir -p "$CURRENT_DIR/dist"
        echo ""
        echo "A copiar o .app de volta para: $CURRENT_DIR/dist/"
        rm -rf "$CURRENT_DIR/dist/GuerrilhaPedais_Atualizador.app" 2>/dev/null
        cp -R "dist/GuerrilhaPedais_Atualizador.app" "$CURRENT_DIR/dist/"
    fi
    cd "$HOME" || true
    rm -rf "$TEMP_DIR"
    cd "$CURRENT_DIR" || true
else
    # Completar in-place: ícone, depois PyInstaller
    if [ -f "build_icon_macos.sh" ]; then
      chmod +x build_icon_macos.sh
      ./build_icon_macos.sh || echo "⚠️  Aviso: não foi possível gerar icon.icns; o .app pode sair com ícone genérico."
    fi
    limpar_pastas_build
    if ! python3 -m PyInstaller guerrilhabox_updater_macos.spec --clean --noconfirm; then
        echo ""
        echo "❌ PyInstaller falhou. Se o erro for permissão: move o projecto para ~/Projetos (fora do Desktop) ou"
        echo "   GUERRILHABOX_BUILD_IN_HOME=1 ./build_macos.sh"
    fi
fi

echo ""
if [ -d "dist/GuerrilhaPedais_Atualizador.app" ]; then
    APP_PATH="dist/GuerrilhaPedais_Atualizador.app"
    if command -v codesign &>/dev/null; then
        echo "Assinatura ad-hoc (opcional, ajuda no Gatekeeper)…"
        codesign --force --deep --sign - "$APP_PATH" 2>/dev/null || true
    fi
    if command -v lipo &>/dev/null && [ -f "$APP_PATH/Contents/MacOS/GuerrilhaPedais_Atualizador" ]; then
        echo "Arquiteturas do binário (universal2 = arm64 e x86_64):"
        lipo -archs "$APP_PATH/Contents/MacOS/GuerrilhaPedais_Atualizador" 2>/dev/null || true
        echo ""
    fi
    echo "========================================"
    echo "✅ BUILD CONCLUÍDO COM SUCESSO!"
    echo "========================================"
    echo ""
    echo "Aplicativo criado em: dist/GuerrilhaPedais_Atualizador.app"
    echo ""
    echo "Para usar:"
    echo "1. Abra a pasta dist"
    echo "2. Arraste o aplicativo para a pasta Aplicativos"
    echo "3. Execute o aplicativo"
    echo ""
    open dist
else
    echo "========================================"
    echo "❌ ERRO NO BUILD!"
    echo "========================================"
    echo ""
    echo "Dica: o build usa uma pasta em /var/folders ou /tmp (mktemp) — nunca 'sudo'."
    echo "Se tiveres pasta antiga corrompida: rm -rf ~/guerrilhabox_build_temp  (ou sudo chown -R \$(whoami)  antes, se tiver ficheiros de root)."
    echo "      GUERRILHABOX_BUILD_IN_HOME=1 ./build_macos.sh  — ainda podes forçar build temporário a partir de qualquer sítio."
fi

echo ""
