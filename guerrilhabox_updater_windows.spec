# -*- mode: python ; coding: utf-8 -*-
# Windows: PyInstaller gera .exe (onefile) — compila no teu PC com Windows.
# (Opcional) ícone: colocar 'icon.ico' na mesma pasta que este ficheiro.

import os
_ico = 'icon.ico' if os.path.isfile('icon.ico') else None

block_cipher = None

a = Analysis(
    ['guerrilhabox_updater.py'],
    pathex=[],
    binaries=[],
    datas=[('esptool', 'esptool')],
    hiddenimports=[
        'serial', 'serial.tools', 'serial.tools.list_ports',
        'esptool', 'esptool._main', 'esptool.targets', 'esptool.targets.esp32',
        'esptool.loader', 'esptool.util', 'esptool.cmds', 'esptool.bin_image',
        'esptool.config', 'esptool.reset', 'esptool.uf2_writer',
        'tkinter', 'tkinter.ttk', 'tkinter.filedialog', 'tkinter.messagebox',
        'threading', 'datetime', 'platform', 'io', 'os', 'sys', 'time',
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
    pyz, a.scripts, a.binaries, a.zipfiles, a.datas, [],
    name='GuerrilhaPedais_Atualizador',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    icon=_ico,
)
