# Guerrilha Pedais – Atualizador de firmware

O projecto pode ficar no **Desktop** (ou noutro sítio) no **Windows** — não precisas de Mac. Tens três formas de usar o atualizador:

## 1) Página no navegador (recomendado para partilhar)

- Pasta **`atualizador-web/`** (e **`docs/`** idêntica para GitHub Pages).
- **No Windows:** duplo clique em **`atualizador-web/servir-local.bat`**, depois abre no **Chrome** ou **Edge** `http://127.0.0.1:8765` — **não** abras o `index.html` a direito (`file://` não chega).
- **Online:** segue **`atualizador-web/HOSPEDAR.md`** (GitHub Pages: branch + pasta `/docs`).

## 2) Aplicação de secretária (Windows) — ficheiro `.exe`

- Instala [Python 3](https://www.python.org/downloads/) (inclui **tcl/tk** se o instalador perguntar).
- Na pasta do projecto, duplo clique em **`build_windows.bat`**.
- Gera: **`dist/GuerrilhaPedais_Atualizador.exe`**

Ou em linha de comando: `py -3 -m pip install -r requirements.txt` e `py -3 guerrilhabox_updater.py` (sem compilar .exe).

## 3) Apenas o script Python (qualquer SO com Python)

```bash
python -m pip install -r requirements.txt
python guerrilhabox_updater.py
```

---

## Compilar no **macOS** (opcional, para quem tiver Mac)

- Script **`build_macos.sh`**, ficheiro **`guerrilhabox_updater_macos.spec`**, `assets/`, `build_icon_macos.sh`, etc.
- Tudo o que for **VM, iCloud, universal2, codesign** está documentado nesses ficheiros e na histórica do repositório; podes ignorar se só usas Windows.

## Requisitos gerais

- Python 3.9+ para script / PyInstaller.
- Navegador **Chrome** ou **Edge** para o atualizador web (Web Serial).
- Mesma lógica de flash que o script: partition opcional em **0x8000**, app em **0x10000**, alvo de flash conforme o script (`CHIP_TYPE` em `guerrilhabox_updater.py`), baud padrão **460800** (no script; na web ajusta o baud no menu).

## Ficheiros principais

| Ficheiro / pasta        | Uso |
|------------------------|-----|
| `guerrilhabox_updater.py` | Aplicação (Tk) |
| `atualizador-web/`     | Site estático (flash no browser); `firmware/latest/manifest.json` + `.bin` para a opção **versão do site** |
| `docs/`                | Cópia do site (GitHub Pages) — manter alinhada com `atualizador-web/` |
| `build_windows.bat`    | Gera o `.exe` no Windows |
| `guerrilhabox_updater_windows.spec` | PyInstaller (Windows) |
| `build_macos.sh`       | Só no Mac |
| `requirements.txt`   | `pyserial`, `esptool`, `pyinstaller` |
| `esptool/`             | Cópia embebida no build PyInstaller |
