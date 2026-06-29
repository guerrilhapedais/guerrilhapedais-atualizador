# Guerrilha Editor S — USB CDC Editor

Editor web para o controlador ESP32-S3 **linha S** via **USB CDC ACM** (Web Serial API).

## Como usar

### Online (GitHub Pages)
Acesse a URL do seu repositório publicado em GitHub Pages.

### Offline / local
Abra o arquivo `index.html` diretamente no Chrome ou Edge.  
> ⚠️ Web Serial não funciona em `file://` no Chrome. Use um servidor local:
> ```bash
> # Python 3
> python -m http.server 8080
> # ou
> npx serve .
> ```
> Depois acesse `http://localhost:8080`

### Modo de teste (sem hardware)
Clique em **"Modo Teste"** para usar o editor com dados simulados, sem necessidade de hardware.

---

## Requisitos

| Item | Versão |
|------|--------|
| Browser | Chrome 89+ / Edge 89+ |
| Firmware | ESP32-S3 com `editor_cdc.c` |
| USB Mode | Modo USB = 2 (MIDI USB PC) — o CDC está ativo |

---

## Protocolo USB CDC

O editor se comunica com o controlador via **Web Serial API** usando o protocolo JSON-line implementado em `editor_cdc.c`:

```
→ {"cmd":"midi_config","bank":0,"id":1}\n
← {"ok":true,"cmd":"midi_config","id":1,"data":{...}}\n
```

### Comandos disponíveis

| Comando | Direção | Descrição |
|---------|---------|-----------|
| `ping` | GET | Verifica conexão e versão do firmware |
| `system_status` | GET | Status geral (USB, SPIFFS, banco, etc.) |
| `active_key` | GET | Footswitch ativo no momento |
| `usb_config` | GET/POST | Configurações globais (LED, PC/CC, presets) |
| `midi_config` | GET/POST | Config MIDI por banco (FS1–FS8) |
| `set_current_bank` | POST | Muda banco/profile activo |
| `tap_tempo` | POST | Dispara tap tempo |

> ⛔ **NUNCA** enviar `update_request` ou `GUERRILHA_UPDATE` através deste editor.  
> O modo de atualização de firmware é gerido exclusivamente pelo site oficial.

---

## Estrutura de ficheiros

```
controlador-editor_s/
├── index.html    — Estrutura HTML (abas, formulários, templates)
├── editor.css    — Estilos modernos dark theme
├── editor.js     — Lógica: Web Serial transport, state, UI
├── mock.js       — Dados simulados para teste offline
└── README.md     — Esta documentação
```

---

## Publicar no GitHub Pages

1. Crie um repositório novo no GitHub
2. Copie estes 4 ficheiros para a pasta raiz (ou `docs/`)
3. Em **Settings → Pages** selecione a branch e pasta
4. Acesse a URL gerada — o editor estará online!

---

## Funcionalidades

- ✅ Conexão USB CDC via Web Serial API
- ✅ Modo de teste offline (Mock)
- ✅ Dashboard com estado em tempo real
- ✅ Editor MIDI por banco (A–I) e footswitch (FS1–FS8)
- ✅ Click, Hold, PC/CC Up-Down, Ricochet, Extras
- ✅ Cores LED por footswitch (ON, OFF, HOLD ON, HOLD OFF)
- ✅ Aplicar modelo LED a todo o banco
- ✅ Configurações globais (LED, PC/CC contadores)
- ✅ Backup e restauro em JSON
- ✅ Copiar/colar footswitch e banco
- ✅ Tap Tempo via USB
- ✅ 5 profiles independentes

## Limitações (via USB)

As seguintes configurações **requerem conexão Wi-Fi** ao editor web do controlador:

- Configuração de Bluetooth
- Configuração de MIDI Serial (DIN)
- Menu Stomp (efeitos globais, scenes)
- Pedal de expressão EXP (calibração, mapeamentos)
- Configuração do ponto de acesso Wi-Fi

---

## Ícones (Stomp / Live)

### Como o `controlador-midi.js` trata ícones

No app web embarcado, os ícones são tratados por **chaves curtas** (strings) e um “catálogo” local:

- **Biblioteca base**: `LIVE_ICON_LIBRARY` é um dicionário `iconKey -> {label, on, off}`.
  - Se existir PNG: `on/off` apontam para `data:image/png;base64,...` (embutido em `LIVE_PNG_ICON_DATA`).
  - Se não existir PNG: gera fallback em SVG (`LIVE_SVG_ICON()`), que escreve texto no quadrado do ícone.
- **Tipo/categoria (opcional)**: `LIVE_PNG_ICON_TYPE` agrupa alguns ícones por categoria (ex.: “guitar amps”).
- **Ícone do FX global (Stomp)**: cada FX global tem `icon` (string curta) e o app limita o tamanho em 23 chars (`getStompFxIconMaxLen()`).
- **Render no Live**:
  - `getLiveIconSrcForKey(key, on)` resolve `iconKey -> data:image/...` (PNG ou SVG).
  - O Live tem estilos (ex.: Unicode vs Graphic) e pode mostrar texto/emoji quando não há PNG.

Referências no firmware/app:
- Catálogo e dados: [controlador-midi.js](file:///E:/tonex/controlador/TonexOne-main/TonexOne-main-S/main/controlador-midi.js#L1-L271)
- Tamanho máximo e resolução: [controlador-midi.js](file:///E:/tonex/controlador/TonexOne-main/TonexOne-main-S/main/controlador-midi.js#L8861-L8890)

### Como o `editor.js` trata ícones hoje

O editor USB **não embute imagens**. Ele guarda apenas a string do ícone no mesmo campo do app:

- O input “Ícone” do FX salva em `customFx[].icon` (até 23 caracteres).
- Para autocomplete, o editor usa uma lista local (browser) em `localStorage.stompIconLibrary`.
- Opcional: dá para apontar um manifest externo (URL) que retorna um array de strings (chaves) e o editor adiciona ao autocomplete.

Referências no editor:
- Campo `icon` no FX + limite: [editor.js](file:///E:/controlador-editor_s/editor.js#L548-L651)
- Biblioteca local + manifest: [editor.js](file:///E:/controlador-editor_s/editor.js#L578-L623)

### Proposta para “mesma lista do app” sem estourar memória

Objetivo: usar **as mesmas chaves** do app no editor (para configurar Stomp/Live), mas **sem carregar PNG/base64** no editor nem no controlador.

1) **Padronizar em “iconKey” (string)**  
   - O controlador/firmaware continua salvando só a string (`customFx[].icon`).
   - O editor só precisa conhecer a lista de chaves válidas (autocomplete).

2) **Lista de chaves (leve) no editor**  
   - Exportar do app uma lista simples (uma por linha ou JSON array) com as keys do `LIVE_ICON_LIBRARY` e/ou keywords (delay/reverb/drive/mod/comp/filter/fx).
   - Colar essa lista no editor (biblioteca local) para autocomplete.

3) **Imagens (opcional, para futuro / “linha X com tela”)**  
   Para dispositivos com tela ou para um “preview gráfico” no editor, manter separado:
   - `iconKey` continua sendo o “ID” estável (compatível).
   - Um “icon pack” resolve `iconKey -> bitmap` (no firmware, SD, SPIFFS ou URL externa no editor).
   - Se não houver bitmap, usar fallback “texto/emoji” (igual o app faz com SVG).

Nota: essa separação evita “quebrar” o projeto por OOM, porque o tráfego USB/CDC e os JSON do banco continuam sem blobs de imagem.

## Segurança — Modo Update

O firmware do controlador usa o mesmo canal USB CDC para o modo de atualização OTA.  
Este editor **nunca envia** o comando `update_request` ou a string `GUERRILHA_UPDATE` automaticamente.  
A atualização de firmware deve ser feita exclusivamente pelo site oficial de update.
