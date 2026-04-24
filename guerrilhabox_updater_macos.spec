# -*- mode: python ; coding: utf-8 -*-
# macOS: .app para qualquer Mac (Intel + Apple Silicon) quando PYINSTALLER_TARGET_ARCH=universal2
# e o Python em uso for build "universal2" (ex.: instalador oficial python.org).

import os

# Definido por build_macos.sh após inspeção com lipo; valores: universal2, arm64, x86_64 ou vazio.
_exe_target_arch = os.environ.get('PYINSTALLER_TARGET_ARCH', '').strip() or None

# icon.icns na pasta do .spec (NÃO uses só os.getcwd(): ao correr
#   pyinstaller /caminho/guerrilhabox_updater_macos.spec
# a pasta de trabalho não é a do projecto e o ícone deixava de ser encontrado).
def _icns_path():
    """Procurar icon.icns junto ao .spec, mesmo com cwd «errado» ou icns só na build temp."""
    g, candidates, seen = globals(), [], set()
    for key in ('SPECPATH',):
        v = g.get(key)
        if v:
            candidates.append(os.path.normpath(v))
    sp = g.get('SPEC')
    if sp:
        candidates.append(os.path.dirname(os.path.normpath(sp)))
    try:
        candidates.append(os.getcwd())
    except OSError:
        pass
    for _root in candidates:
        if not _root or _root in seen:
            continue
        seen.add(_root)
        p = os.path.join(_root, 'icon.icns')
        if os.path.isfile(p):
            return os.path.normpath(p)
    return None


_icns = _icns_path()

# Info.plist: nome do ícone sem extensão (ex.: icon.icns → "icon")
_info_plist = {
    'NSPrincipalClass': 'NSApplication',
    'NSHighResolutionCapable': 'True',
}
if _icns:
    _info_plist['CFBundleIconFile'] = 'icon'
    # Evita o ícone antigo do Python a aparecer unificado no Dock
    _info_plist['CFBundleName'] = 'Guerrilha Pedais Atualizador'

block_cipher = None

a = Analysis(
    ['guerrilhabox_updater.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('esptool', 'esptool'),
    ],
    hiddenimports=[
        'serial',
        'serial.tools',
        'serial.tools.list_ports',
        'esptool',
        'esptool._main',
        'esptool.targets',
        'esptool.targets.esp32',
        'esptool.loader',
        'esptool.util',
        'esptool.cmds',
        'esptool.bin_image',
        'esptool.config',
        'esptool.reset',
        'esptool.uf2_writer',
        'tkinter',
        'tkinter.ttk',
        'tkinter.filedialog',
        'tkinter.messagebox',
        'threading',
        'datetime',
        'platform',
        'io',
        'os',
        'sys',
        'time'
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='GuerrilhaPedais_Atualizador',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX no macOS costuma corromper binários PyInstaller; manter desligado.
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=True,
    target_arch=_exe_target_arch,
    codesign_identity=None,
    entitlements_file=None,
    # macOS: ícone do executável interno (em conjunto com o BUNDLE)
    icon=_icns,
)

# Criar bundle .app para macOS
app = BUNDLE(
    exe,
    name='GuerrilhaPedais_Atualizador.app',
    icon=_icns,
    bundle_identifier='com.guerrilhapedais.updater',
    info_plist=_info_plist,
)