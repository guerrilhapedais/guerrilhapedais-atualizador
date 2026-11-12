/**
 * Guerrilha Pedais — atualizador web ESP32-S3 (partition 0x8000, app 0x10000)
 * Carrega esptool-js com vários CDNs; import estático de esm.sh falhava muitas vezes.
 */
const ESPTOOL_CDNS = [
  "https://cdn.jsdelivr.net/npm/esptool-js@0.6.0/+esm",
  "https://esm.run/esptool-js@0.6.0",
  "https://esm.sh/esptool-js@0.6.0?bundle&target=es2020",
  "https://esm.sh/esptool-js@0.5.7",
];

/** MD5 para `calculateMD5Hash` do esptool-js (confirma bytes na flash após gravar). */
const SPARK_MD5_CDNS = [
  "https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/+esm",
  "https://esm.sh/spark-md5@3.0.2",
];

const ADDR_PART = 0x8000;
const ADDR_APP = 0x10000;
/** ESP32-S3: bootloader vive em 0x0 (no ESP32 clássico era 0x1000). */
const ADDR_BOOTLOADER = 0x0;
const FLASH_SIZE = document.documentElement.getAttribute("data-flash-size") || "4MB";

const el = (id) => document.getElementById(id);

let ESPLoader;
let Transport;
let transport = null;
let esploader = null;
let port = null;
let libVersion = null;
let serialConnectBusy = false;
let flashInProgress = false;

/**
 * Modos de gravação:
 *  - «bundled»  = update normal: tabela (opcional) + app a partir do manifesto. Sem erase total.
 *  - «manual»   = ficheiros locais escolhidos pelo utilizador.
 *  - «factory»  = reposição de fábrica: bootloader + tabela + app com erase total.
 *                 Apaga NVS, LittleFS e todo o estado do utilizador. Requer bootloader no manifesto.
 */
let firmwareMode = "bundled";
let bundledCache = {
  ok: false,
  version: "",
  label: "",
  fw: null,
  part: null,
  /** Imagem do bootloader (opcional, só usada no modo «factory»). */
  boot: null,
  err: null,
  /** Blob do ficheiro de notas (se existir em firmware/latest). */
  notesBlob: null,
  notesDownloadName: null,
};

const FIRMWARE_DIR = document.documentElement.getAttribute("data-firmware-dir") || "latest";

function getManifestUrl() {
  return new URL(`../firmware/${FIRMWARE_DIR}/manifest.json`, import.meta.url);
}

function getFirmwareBaseUrl() {
  return new URL(`../firmware/${FIRMWARE_DIR}/`, import.meta.url);
}

const SYNC_TIMEOUT_MS = 90000;
/** Baud da ROM na 1.ª ligação — tem de coincidir com `romBaudrate` do ESPLoader. */
const ROM_BAUDRATE = 115200;
/** Baud de gravação após sync (sem controlo na página). */
const FLASH_BAUDRATE = 460800;

/** PID típico da ROM USB Serial/JTAG no ESP32-S3 (esptool). */
const USB_PID_ESP32S3_ROM_JTAG = 0x1001;
/** PIDs TinyUSB só app (MIDI/CDC) — antes do esptool enviamos comando de preparação à app. */
const USB_PIDS_TINYUSB_APP_ONLY = new Set([0x4008, 0x4009]);

/** Linha enviada à CDC da app ao «Ligar» e de novo em «Gravar firmware» (TinyUSB) antes do esptool, se aplicável. */
const CDC_UPDATE_CMD_LINE = "GUERRILHA_UPDATE\r\n";

/** Após o comando na fase «Gravar» (firmware já não reinicia sozinho): breve pausa antes de fechar a CDC. */
const CDC_UPDATE_GRAVAR_PAUSE_MS = 500;

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fecha e volta a abrir a porta (evita «already open» se o close ainda não libertou no Chrome).
 */
async function serialReopenClean(p, baud) {
  if (!p) throw new Error("Sem porta serial");
  try {
    await p.close();
  } catch (_) {
    /* já fechada ou lock residual */
  }
  await sleepMs(150);
  await p.open({ baudRate: baud });
}

function withTimeout(promise, ms, errMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(errMsg)), ms);
    }),
  ]);
}

/**
 * Envia à CDC da app a linha de update (ao «Ligar» ou antes de fechar para o esptool).
 * Não usar na porta ROM/JTAG — só TinyUSB app.
 */
async function sendCdcUpdateKick(p) {
  if (!p?.writable) throw new Error("Porta sem escrita");
  const data = new TextEncoder().encode(CDC_UPDATE_CMD_LINE);
  const w = p.writable.getWriter();
  try {
    await w.write(data);
  } finally {
    w.releaseLock();
  }
}

/** Só PID da ROM USB JTAG — sem filtro «só Espressif» (isso incluía a CDC 0x4009 e o esptool falhava). */
const ESP32_ROM_JTAG_FILTERS = [{ usbVendorId: 0x303a, usbProductId: USB_PID_ESP32S3_ROM_JTAG }];

/**
 * Entre portas já autorizadas nesta origem, abre a primeira ROM (0x1001) que conseguir.
 * Útil após comando CDC: o chip pode reenumerar e o SerialPort do 2.º diálogo falhar no open().
 */
async function tryOpenGrantedRomJtagPort() {
  let list = [];
  try {
    list = await navigator.serial.getPorts();
  } catch (_) {
    return null;
  }
  for (const p of list) {
    let info;
    try {
      info = typeof p.getInfo === "function" ? p.getInfo() : {};
    } catch (_) {
      continue;
    }
    if (info.usbVendorId !== 0x303a || info.usbProductId !== USB_PID_ESP32S3_ROM_JTAG) {
      continue;
    }
    try {
      if (p.readable != null && p.writable != null) {
        continue;
      }
    } catch (_) {
      /* objecto stale */
    }
    try {
      await p.open({ baudRate: ROM_BAUDRATE });
      return p;
    } catch (_) {
      continue;
    }
  }
  return null;
}

/**
 * Depois de fechar a CDC da app: tenta abrir a linha ROM com retries e getPorts().
 * Não chamar close() no SerialPort ROM antes do primeiro open() — o fluxo antigo
 * fechava-o e o Chrome/OS falhavam com «Failed to open serial port» após reinício USB.
 */
async function openRomPortAfterCdcKick(preferredRomHandle, logFn) {
  const attempts = 16;
  const gapMs = 400;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await sleepMs(gapMs);
      if (i >= 2) {
        logFn(
          "Aguardando a porta USB JTAG/serial (0x1001) após o comando ao app… " + i + "/" + (attempts - 1)
        );
      }
    }
    if (preferredRomHandle) {
      try {
        await preferredRomHandle.open({ baudRate: ROM_BAUDRATE });
        return preferredRomHandle;
      } catch (_) {
        /* após reenumeração — tenta getPorts */
      }
    }
    const found = await tryOpenGrantedRomJtagPort();
    if (found) {
      return found;
    }
  }
  throw new Error(
    "Não foi possível abrir a porta ROM (0x1001) a tempo. Desconecte e reconecte o USB, confirme o modo de atualização (FS1) se precisar, clique de novo em «Conectar» e repita «Gravar firmware»."
  );
}

async function loadSparkMd5() {
  let lastErr;
  for (const url of SPARK_MD5_CDNS) {
    try {
      const m = await import(url);
      const SparkMD5 = m.default || m.SparkMD5 || m;
      if (SparkMD5 && typeof SparkMD5.ArrayBuffer.hash === "function") {
        return SparkMD5;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("spark-md5 indisponível");
}

/** Callback síncrono esperado pelo esptool-js (imagem já com pad + parâmetros de flash). */
function makeFlashMd5Calculator(SparkMD5) {
  return function calculateMD5Hash(image) {
    const buf = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength);
    return SparkMD5.ArrayBuffer.hash(buf);
  };
}

/**
 * O esptool-js chama `transport.connect()` → `port.open()`. Se já abrimos com `port.open()`,
 * evita «already open». Após `disconnect()` (ex. mudança de baud), volta a abrir normalmente.
 */
function wrapTransportSkipOpenIfAlreadyOpen(t) {
  const orig = t.connect.bind(t);
  t.connect = async function (baud, serialOptions) {
    if (this.device.readable != null && this.device.writable != null) {
      this.baudrate = baud;
      return;
    }
    return orig(baud, serialOptions);
  };
}

function tinyusbAppOnlyPid(pid) {
  return typeof pid === "number" && USB_PIDS_TINYUSB_APP_ONLY.has(pid);
}

/** Dica quando a porta é a app TinyUSB: comando ao «Ligar»; em «Gravar» pode reenviar-se antes do esptool. */
function logRomFlashPortHintIfNeeded(p) {
  if (!p || typeof p.getInfo !== "function") return;
  const pid = p.getInfo().usbProductId;
  if (!tinyusbAppOnlyPid(pid)) return;
  logLine(
    "Porta da **aplicação** (CDC, PID 0x" +
      pid.toString(16) +
      "). O comando ao controlador é enviado ao **Conectar**; reconecte o USB se precisar da linha ROM (0x1001) para gravar."
  );
}

/** O Web Serial não dá o nome «COMx»; o .exe usa `serial.tools.list_ports`. */
function logSerialPortSummary(p) {
  if (!p || typeof p.getInfo !== "function") return;
  const i = p.getInfo();
  const vid = i.usbVendorId != null ? "0x" + i.usbVendorId.toString(16) : "—";
  const pid = i.usbProductId != null ? "0x" + i.usbProductId.toString(16) : "—";
  logLine("Porta (Web Serial): o mesmo dispositivo que você escolheu no Chrome — USB VID " + vid + " PID " + pid + ".");
  logLine("(No .exe aparece «COM…»; no navegador só existe este identificador USB.)");
  logRomFlashPortHintIfNeeded(p);
}

function logLine(msg) {
  const logBox = el("log");
  if (!logBox) return;
  const t = new Date().toLocaleTimeString("pt-PT", { hour12: false });
  logBox.textContent += `[${t}] ${msg}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function setProgress(frac, text) {
  const progress = el("progress");
  const progressLabel = el("progressLabel");
  if (progress && frac != null) progress.value = Math.round(frac * 100);
  if (progressLabel && text) progressLabel.textContent = text;
}

/** Modal amigável após gravação bem-sucedida (reinício pelo USB do controlador). */
function showFlashSuccessDialog() {
  const dialog = el("flashDoneDialog");
  const okBtn = el("flashDoneOk");
  if (!dialog) return;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    okBtn?.focus();
  }
}

function setupFlashDoneDialog() {
  const dialog = el("flashDoneDialog");
  const okBtn = el("flashDoneOk");
  if (!dialog || !okBtn) return;
  okBtn.addEventListener("click", () => {
    if (typeof dialog.close === "function") dialog.close();
    window.location.reload();
  });
  dialog.addEventListener("close", () => {
    el("flash")?.focus();
  });
}

function terminal() {
  return {
    clean() {},
    writeLine: (d) => console.debug("[esptool]", d),
    write: (d) => console.debug("[esptool]", d),
  };
}

function showBootError(err) {
  const loadOk = el("loadOk");
  if (loadOk) {
    loadOk.style.display = "none";
  }
  const box = el("bootError");
  const msg = el("bootErrorMsg");
  if (box) {
    if (msg) {
      const s = (err && err.message) || String(err);
      msg.textContent = s;
    }
    box.style.display = "block";
    box.setAttribute("aria-hidden", "false");
  } else {
    // fallback
    const d = document.createElement("div");
    d.className = "warn";
    d.setAttribute("role", "alert");
    d.textContent = "Falha ao carregar: " + ((err && err.message) || err);
    document.querySelector(".layout")?.insertBefore(d, document.querySelector("header")?.nextSibling);
  }
}

/** Carregar esm com vários fornecedores (extensão / rede bloqueiam um deles) */
async function loadEsptool() {
  let lastErr;
  for (const url of ESPTOOL_CDNS) {
    try {
      const m = await import(url);
      if (m && m.ESPLoader && m.Transport) {
        libVersion = url;
        return m;
      }
    } catch (e) {
      lastErr = e;
      console.warn("[Guerrilha Pedais] Falhou CDN", url, e);
    }
  }
  throw lastErr || new Error("Nenhum CDN devolveu esptool-js");
}

function hasFirmwareReady() {
  if (firmwareMode === "bundled") {
    return bundledCache.ok === true;
  }
  if (firmwareMode === "factory") {
    return bundledCache.ok === true && bundledCache.boot != null;
  }
  return !!(el("fileFw")?.files?.[0]);
}

function getConnectedHint() {
  if (firmwareMode === "bundled") {
    if (bundledCache.ok) {
      return "Conectado. Clique em «Gravar firmware» para sincronizar e gravar.";
    }
    return "Conectado. A versão do site não carregou — recarregue ou escolha «Arquivos no computador».";
  }
  if (firmwareMode === "factory") {
    if (bundledCache.ok && bundledCache.boot) {
      return "Conectado. Clique em «Gravar firmware» para restaurar o padrão de fábrica (apaga presets e calibrações).";
    }
    return "Conectado. Restauração de fábrica indisponível — falta «bootloader.bin» no manifesto.";
  }
  const hasFw = !!(el("fileFw")?.files?.[0]);
  return hasFw
    ? "Conectado. Clique em «Gravar firmware» para sincronizar e gravar."
    : "Conectado. Escolha o arquivo .bin e clique em «Gravar firmware».";
}

function updateFlashButtonState() {
  const flashBtn = el("flash");
  if (!flashBtn) return;
  const canTry = port != null && !flashInProgress && !serialConnectBusy && hasFirmwareReady();
  flashBtn.disabled = !canTry;
  flashBtn.classList.toggle("btn-danger", firmwareMode === "factory");
  flashBtn.classList.toggle("btn-success", firmwareMode !== "factory");
  flashBtn.textContent = firmwareMode === "factory" ? "Gravar firmware (restauração)" : "Gravar firmware";
  updateNotesButtonState();
}

function updateNotesButtonState() {
  const notesBtn = el("downloadNotes");
  if (!notesBtn) return;
  if (firmwareMode === "manual") {
    notesBtn.hidden = true;
    return;
  }
  notesBtn.hidden = false;
  const can =
    bundledCache.ok &&
    !flashInProgress &&
    bundledCache.notesBlob != null &&
    bundledCache.notesDownloadName;
  notesBtn.disabled = !can;
}

function downloadBundledReleaseNotes() {
  if (!bundledCache.notesBlob || !bundledCache.notesDownloadName) {
    logLine("Notas da versão indisponíveis para esta build.");
    return;
  }
  const url = URL.createObjectURL(bundledCache.notesBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = bundledCache.notesDownloadName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  logLine("Notas da versão: você baixou «" + bundledCache.notesDownloadName + "».");
}

function setFirmwareMode(mode) {
  if (mode === "manual") firmwareMode = "manual";
  else if (mode === "factory") firmwareMode = "factory";
  else firmwareMode = "bundled";
  const bundledPanel = el("bundledPanel");
  const manualPanel = el("manualPanel");
  const factoryPanel = el("factoryPanel");
  if (bundledPanel) bundledPanel.hidden = firmwareMode !== "bundled";
  if (manualPanel) manualPanel.hidden = firmwareMode !== "manual";
  if (factoryPanel) factoryPanel.hidden = firmwareMode !== "factory";
  updateFactoryPanel();
  updateFlashButtonState();
  if (port) {
    setProgress(0, getConnectedHint());
  }
}

function updateFactoryPanel() {
  const radio = el("fwSourceFactory");
  const statusEl = el("factoryStatus");
  const hasBoot = bundledCache.ok && bundledCache.boot != null;
  if (radio) {
    radio.disabled = !hasBoot;
  }
  if (statusEl) {
    if (!bundledCache.ok) {
      statusEl.textContent = "Manifesto não disponível — não é possível restaurar o padrão de fábrica pelo site.";
      statusEl.classList.add("firmware-bundled-status--err");
      statusEl.classList.remove("firmware-bundled-status--ok");
    } else if (!hasBoot) {
      statusEl.textContent =
        "Falta «bootloader.bin» no manifesto — adicione o campo «bootloader» para ativar esta opção.";
      statusEl.classList.add("firmware-bundled-status--err");
      statusEl.classList.remove("firmware-bundled-status--ok");
    } else {
      const sizeKB = (bundledCache.boot.length / 1024).toFixed(0);
      statusEl.textContent = "Bootloader pronto (" + sizeKB + " KB) — a flash inteira será apagada.";
      statusEl.classList.add("firmware-bundled-status--ok");
      statusEl.classList.remove("firmware-bundled-status--err");
    }
  }
}

async function getFlashBinaries() {
  if (firmwareMode === "bundled" || firmwareMode === "factory") {
    if (!bundledCache.ok || !bundledCache.fw) {
      throw new Error("Versão do site indisponível — recarregue a página ou use arquivos do computador.");
    }
    if (firmwareMode === "factory" && !bundledCache.boot) {
      throw new Error("Restauração de fábrica indisponível — falta «bootloader.bin» no manifesto.");
    }
    return {
      fwData: bundledCache.fw,
      partData: bundledCache.part,
      bootData: firmwareMode === "factory" ? bundledCache.boot : null,
    };
  }
  const fileFw = el("fileFw");
  const filePart = el("filePart");
  const fw = fileFw?.files?.[0];
  if (!fw) {
    throw new Error("Escolha o arquivo de firmware .bin");
  }
  const fwData = new Uint8Array(await fw.arrayBuffer());
  const partFile = filePart?.files?.[0] || null;
  let partData = null;
  if (partFile) {
    partData = new Uint8Array(await partFile.arrayBuffer());
  }
  return { fwData, partData, bootData: null };
}

function setBundledSourceSubline(text, variant) {
  const sub = el("bundledSourceSub");
  if (!sub) return;
  sub.textContent = text;
  sub.classList.remove("firmware-source__sub--ok", "firmware-source__sub--err");
  if (variant === "ok") sub.classList.add("firmware-source__sub--ok");
  if (variant === "err") sub.classList.add("firmware-source__sub--err");
}

async function loadBundledFirmware() {
  const statusEl = el("bundledStatus");
  if (statusEl) {
    statusEl.textContent = "Carregando arquivos…";
    statusEl.classList.remove("firmware-bundled-status--err", "firmware-bundled-status--ok");
  }
  setBundledSourceSubline("Carregando a versão…", null);
  try {
    const r = await fetch(getManifestUrl(), { cache: "no-store" });
    if (!r.ok) {
      throw new Error("manifest.json não encontrado (HTTP " + r.status + ").");
    }
    const m = await r.json();
    const base = getFirmwareBaseUrl();
    const fwName = m.firmware;
    if (!fwName || typeof fwName !== "string") {
      throw new Error("No manifest, o campo «firmware» (nome do .bin) é obrigatório.");
    }
    const fwRes = await fetch(new URL(fwName, base), { cache: "no-store" });
    if (!fwRes.ok) {
      throw new Error("Arquivo «" + fwName + "» não encontrado (HTTP " + fwRes.status + ").");
    }
    const buf = await fwRes.arrayBuffer();
    if (!buf || buf.byteLength === 0) {
      throw new Error("O arquivo de firmware está vazio.");
    }
    const fw = new Uint8Array(buf);
    let part = null;
    if (m.partition) {
      if (typeof m.partition !== "string" || !m.partition.length) {
        throw new Error("O campo «partition» tem de ser string ou ser omitido.");
      }
      const pRes = await fetch(new URL(m.partition, base), { cache: "no-store" });
      if (!pRes.ok) {
        throw new Error("Partition «" + m.partition + "» (HTTP " + pRes.status + ").");
      }
      const pBuf = await pRes.arrayBuffer();
      part = new Uint8Array(pBuf);
    }
    /**
     * Bootloader é OPCIONAL — só usado pelo modo «Reposição de fábrica».
     * Se faltar ou falhar a descarregar, o update normal continua a funcionar
     * (apenas a opção «factory» fica desactivada).
     */
    let boot = null;
    if (m.bootloader && typeof m.bootloader === "string" && m.bootloader.length) {
      try {
        const bRes = await fetch(new URL(m.bootloader, base), { cache: "no-store" });
        if (bRes.ok) {
          const bBuf = await bRes.arrayBuffer();
          if (bBuf && bBuf.byteLength > 0) {
            boot = new Uint8Array(bBuf);
          }
        }
      } catch (_) {
        /* bootloader é opcional — silenciar erros de rede/CORS aqui */
      }
    }
    const version = String(m.version != null ? m.version : "—");
    const label = String(m.label != null ? m.label : "");
    let notesBlob = null;
    let notesDownloadName = null;
    const notesFile =
      m.notas != null && typeof m.notas === "string" && m.notas.trim()
        ? m.notas.trim()
        : "notas-da-versao.txt";
    try {
      const notesRes = await fetch(new URL(notesFile, base), { cache: "no-store" });
      if (notesRes.ok) {
        notesBlob = await notesRes.blob();
        const baseName = notesFile.includes("/") ? notesFile.slice(notesFile.lastIndexOf("/") + 1) : notesFile;
        notesDownloadName = baseName || "notas-da-versao.txt";
      }
    } catch (_) {
      /* ficheiro opcional — ignora rede/CORS legítimos em dev */
    }
    bundledCache = { ok: true, version, label, fw, part, boot, err: null, notesBlob, notesDownloadName };
    const vDisp =
      version && version !== "—"
        ? "Versão " + version
        : "Define o campo «version» no manifesto";
    setBundledSourceSubline(vDisp, "ok");
    if (statusEl) {
      const extra = m.partition ? " — com tabela de partições" : " — só app";
      const head = label ? label + " — " : "";
      statusEl.textContent =
        head + (fw.length / 1024).toFixed(0) + " KB" + extra + " — pronto para gravar";
      statusEl.classList.add("firmware-bundled-status--ok");
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    bundledCache = {
      ok: false,
      version: "",
      label: "",
      fw: null,
      part: null,
      boot: null,
      err: msg,
      notesBlob: null,
      notesDownloadName: null,
    };
    setBundledSourceSubline("Não disponível — escolha arquivos no computador", "err");
    if (statusEl) {
      statusEl.textContent = "Não carregou: " + msg;
      statusEl.classList.add("firmware-bundled-status--err");
    }
  }
  updateFactoryPanel();
  updateFlashButtonState();
  if (port) {
    setProgress(0, getConnectedHint());
  }
}

function updateUiConnected(isConnected) {
  const hasSerial = "serial" in navigator;
  const connectBtn = el("connect");
  const disconnectBtn = el("disconnect");
  if (connectBtn) {
    connectBtn.disabled = isConnected || !hasSerial;
  }
  if (disconnectBtn) disconnectBtn.disabled = !isConnected;
  updateFlashButtonState();
  if (isConnected) {
    setProgress(0, getConnectedHint());
  }
}

function isUserCancelledPortPick(err) {
  const m = (err && err.message) || String(err);
  /* Chrome: diálogo fechado sem escolher — costuma ser NotFoundError ou mensagem «no port selected». */
  if (err && err.name === "NotFoundError") return true;
  return /no port selected/i.test(m);
}

/**
 * Filtros OR para o diálogo Web Serial (ESP32-S3 / Espressif).
 * Inclui PID explícitos usados em firmware composto (ex. 0x4008) e ROM USB Serial/JTAG (0x1001).
 * Nota: se o Windows só expõe MIDI sem CDC, o Chrome não lista porta série — o filtro não cria COM.
 */
const ESP32_S3_SERIAL_FILTERS = [
  { usbVendorId: 0x303a, usbProductId: 0x4008 },
  /* CDC+MIDI composto (firmware Guerrilha com tud_cdc + MIDI): PID = 0x4000|CDC|MIDI */
  { usbVendorId: 0x303a, usbProductId: 0x4009 },
  { usbVendorId: 0x303a, usbProductId: 0x1001 },
  { usbVendorId: 0x303a },
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x1a86 },
];

/** Fluxo padrão Web Serial: o browser mostra o diálogo e devolve o `SerialPort` (sem atalho `getPorts`). */
async function pickSerialPort() {
  logLine("Pedindo acesso USB (escolha a porta do dispositivo na janela)…");
  return await navigator.serial.requestPort({ filters: ESP32_S3_SERIAL_FILTERS });
}

function setConnectionStatus(connected) {
  const statusState = el("statusState");
  if (!statusState) return;
  statusState.textContent = connected ? "Conectado" : "Desconectado";
  statusState.classList.toggle("status-pill--on", connected);
}

async function cleanupPort(options = {}) {
  const skipUi = options.skipUi === true;
  flashInProgress = false;
  try {
    if (transport && typeof transport.disconnect === "function") {
      await transport.disconnect();
    }
  } catch (_) { /* nada */ }
  transport = null;
  esploader = null;
  try {
    if (port) {
      await port.close();
    }
  } catch (_) { /* nada: já fechada ou nunca aberta */ }
  port = null;
  setConnectionStatus(false);
  setProgress(0, "");
  if (!skipUi) {
    updateUiConnected(false);
  }
}

function setupEventHandlers() {
  const noSerial = el("noSerial");
  const mainBlock = el("main");
  const connectBtn = el("connect");

  if (!("serial" in navigator)) {
    if (noSerial) {
      noSerial.classList.add("warn");
      noSerial.style.display = "block";
    }
    if (mainBlock) mainBlock.setAttribute("aria-hidden", "true");
  } else {
    if (noSerial) noSerial.style.display = "none";
    if (mainBlock) mainBlock.removeAttribute("aria-hidden");
    if (connectBtn) connectBtn.disabled = false;
  }

  el("connect")?.addEventListener("click", async () => {
    if (!("serial" in navigator)) {
      logLine("Use Chrome ou Edge (com Web Serial).");
      return;
    }
    if (serialConnectBusy) {
      logLine("Conexão já em andamento — aguarde.");
      return;
    }
    serialConnectBusy = true;
    try {
      await cleanupPort({ skipUi: true });
      port = await pickSerialPort();
      logLine("Abrindo a porta USB (Web Serial, " + ROM_BAUDRATE + " baud)…");
      await serialReopenClean(port, ROM_BAUDRATE);
      logLine("Porta USB aberta.");
      logSerialPortSummary(port);
      let pidConn = null;
      try {
        if (typeof port.getInfo === "function") pidConn = port.getInfo().usbProductId;
      } catch (_) {
        /* */
      }
      if (tinyusbAppOnlyPid(pidConn)) {
        try {
          await sendCdcUpdateKick(port);
          logLine("Comando GUERRILHA_UPDATE enviado (pedido em NVS). Sem reinício automático no chip — reconecte o USB se precisar da ROM para gravar.");
        } catch (e) {
          logLine("Aviso: não foi possível enviar o comando pela CDC (" + ((e && e.message) || e) + ").");
        }
        logLine("«Gravar firmware» sincroniza e grava; no modo app TinyUSB o comando é reenviado antes do esptool.");
      } else {
        logLine("«Gravar firmware» sincroniza e grava (porta já é ROM ou outra linha — sem comando CDC ao ligar).");
      }
      setConnectionStatus(true);
      updateUiConnected(true);
    } catch (e) {
      if (isUserCancelledPortPick(e)) {
        logLine("Você cancelou a escolha da porta — clique de novo em «Conectar dispositivo».");
      } else {
        const em = (e && e.message) || String(e);
        logLine("Erro: " + em + " — (clique em Desconectar nesta página, espere 1–2 s, feche outra aba com o site ou outro programa usando a COM e tente de novo.)");
        if (/already open/i.test(em)) {
          logLine("Dica «already open»: o Chrome ainda não liberou a porta; clique em «Desconectar» e espere, ou recarregue a página.");
        }
      }
      await cleanupPort();
    } finally {
      serialConnectBusy = false;
      /* updateUiConnected já chamou updateFlashButtonState com busy=true; corrigir após libertar o lock. */
      updateFlashButtonState();
    }
  });

  el("disconnect")?.addEventListener("click", async () => {
    logLine("Desconectando…");
    await cleanupPort();
  });

  el("flash")?.addEventListener("click", async () => {
    if (!port) {
      logLine("Primeiro clique em «Conectar dispositivo» e escolha a porta USB.");
      return;
    }
    if (firmwareMode === "bundled") {
      if (!bundledCache.ok) {
        logLine("A versão do site não está pronta — recarregue ou escolha «Arquivos no computador».");
        return;
      }
    } else if (firmwareMode === "factory") {
      if (!bundledCache.ok || !bundledCache.boot) {
        logLine("Restauração de fábrica não está pronta — falta «bootloader.bin» no manifesto.");
        return;
      }
    } else if (!el("fileFw")?.files?.[0]) {
      logLine("Escolha o arquivo de firmware .bin");
      return;
    }

    let pidPrep = null;
    try {
      if (port && typeof port.getInfo === "function") {
        pidPrep = port.getInfo().usbProductId;
      }
    } catch (_) {
      /* getInfo opcional */
    }

    /**
     * O Chrome exige `requestPort()` no mesmo «user gesture» do clique. `window.confirm`,
     * `logLine` (reflow) ou microtarefas podem invalidar o gesto →
     * «Must be handling a user gesture to show a permission request».
     * Por isso chamamos `requestPort` aqui, antes de confirm e antes das mensagens ao registo.
     */
    let romPortRequestPromise = null;
    if (tinyusbAppOnlyPid(pidPrep)) {
      try {
        /* Filtro só 0x1001: no Chrome muitas vezes essa linha AINDA NÃO existe enquanto a app está na USB — o diálogo fica vazio e o utilizador cancela. Listar todos os PID Espressif (como em «Ligar»). */
        romPortRequestPromise = navigator.serial.requestPort({ filters: ESP32_S3_SERIAL_FILTERS });
      } catch (e) {
        logLine("ERRO: " + ((e && e.message) || e));
        return;
      }
    }

    if (tinyusbAppOnlyPid(pidPrep)) {
      logLine(
        "Segunda janela: aparecem todas as interfaces Espressif (VID 0x303a) — escolha **USB JTAG/serial** (ROM, PID **0x1001**), não a linha do aplicativo (0x4008/0x4009)."
      );
      logLine(
        "Se **0x1001** não estiver na lista, cancele: ligue o pedal segurando FS1 (modo de atualização) ou desconecte e reconecte o USB e clique de novo em «Gravar firmware» quando o Chrome listar a ROM."
      );
    }

    const baud = FLASH_BAUDRATE;
    flashInProgress = true;
    updateFlashButtonState();

    let fwData;
    let partData;
    let bootData;
    try {
      /* Reposição de fábrica sem 2.º diálogo ROM: confirm aqui (não invalida o gesture do requestPort). */
      if (!tinyusbAppOnlyPid(pidPrep) && firmwareMode === "factory") {
        const confirmed = window.confirm(
          "Restauração de fábrica\n\n" +
            "Vai apagar TODA a flash do dispositivo:\n" +
            "  • Presets e configurações salvos\n" +
            "  • Calibrações\n" +
            "  • LittleFS / NVS\n\n" +
            "Depois grava o bootloader, a tabela de partições e o firmware do site.\n\n" +
            "Continuar?"
        );
        if (!confirmed) {
          logLine("Restauração de fábrica cancelada.");
          return;
        }
      }

      setProgress(0.02, "Preparando a porta USB…");
      if (tinyusbAppOnlyPid(pidPrep)) {
        let romHandle;
        try {
          romHandle = await romPortRequestPromise;
        } catch (e) {
          if (isUserCancelledPortPick(e)) {
            logLine("Você cancelou a porta ROM — operação interrompida.");
          } else {
            logLine("ERRO: " + ((e && e.message) || e));
          }
          setProgress(0, "Falha na gravação.");
          return;
        }
        let romPidCheck = null;
        try {
          if (typeof romHandle.getInfo === "function") {
            romPidCheck = romHandle.getInfo().usbProductId;
          }
        } catch (_) {
          /* */
        }
        if (tinyusbAppOnlyPid(romPidCheck)) {
          logLine(
            "ERRO: na 2.ª janela foi escolhida a porta do **aplicativo** (PID 0x" +
              romPidCheck.toString(16) +
              "), não a **USB JTAG/serial** (0x" +
              USB_PID_ESP32S3_ROM_JTAG.toString(16) +
              "). Repita «Gravar firmware» e escolha só a linha **USB JTAG/serial**."
          );
          setProgress(0, "Falha na gravação.");
          return;
        }
        if (romPidCheck != null && romPidCheck !== USB_PID_ESP32S3_ROM_JTAG) {
          logLine(
            "Aviso: PID 0x" +
              romPidCheck.toString(16) +
              " (esperado 0x" +
              USB_PID_ESP32S3_ROM_JTAG.toString(16) +
              " para ROM). Se a sincronização falhar, confira o cabo e o modo bootloader."
          );
        }
        if (firmwareMode === "factory") {
          const okFactory = window.confirm(
            "Restauração de fábrica\n\n" +
              "Vai apagar TODA a flash do dispositivo:\n" +
              "  • Presets e configurações salvos\n" +
              "  • Calibrações\n" +
              "  • LittleFS / NVS\n\n" +
              "Depois grava o bootloader, a tabela de partições e o firmware do site.\n\n" +
              "Continuar?"
          );
          if (!okFactory) {
            logLine("Restauração de fábrica cancelada.");
            try {
              await romHandle.close();
            } catch (_) {
              /* */
            }
            setProgress(0, "");
            return;
          }
        }
        logLine("CDC (TinyUSB): reenviando o comando de preparação…");
        try {
          await sendCdcUpdateKick(port);
          logLine("Comando enviado. **Reconecte o USB** (ou reinicie o chip) para a ROM (0x1001) aparecer, se ainda estiver no app.");
          await sleepMs(CDC_UPDATE_GRAVAR_PAUSE_MS);
        } catch (e) {
          logLine("Aviso: falha ao enviar pela CDC (" + ((e && e.message) || e) + "). Continuação…");
        }
        logLine("Fechando a CDC do app; em seguida conecta a linha ROM (0x1001) para o esptool…");
        try {
          await port.close();
        } catch (_) {
          /* */
        }
        port = null;
        /**
         * Não fechar `romHandle` aqui antes do primeiro open — estava a provocar falhas ao
         * `open()` após reinício USB. Retries + navigator.serial.getPorts().
         */
        await sleepMs(550);
        port = await openRomPortAfterCdcKick(romHandle, logLine);
        logSerialPortSummary(port);
        logLine("Porta USB pronta para sincronizar (interface ROM).");
      } else {
        logLine("Fechando e reabrindo a porta (evita «already open» e limpa o estado antes do esptool)…");
        await serialReopenClean(port, ROM_BAUDRATE);
        logLine("Porta USB pronta para sincronizar.");
      }

      transport = new Transport(port, true);
      wrapTransportSkipOpenIfAlreadyOpen(transport);

      const loaderOpts = {
        transport,
        baudrate: baud,
        romBaudrate: ROM_BAUDRATE,
        debugLogging: false,
        terminal: terminal(),
      };
      esploader = new ESPLoader(loaderOpts);

      setProgress(0.06, "Sincronizando com o chip (esptool)…");
      logLine("Sincronizando com o chip (esptool)…");
      await withTimeout(
        esploader.main("default_reset"),
        SYNC_TIMEOUT_MS,
        "Sincronização demorou mais de " +
          Math.round(SYNC_TIMEOUT_MS / 1000) +
          " s. Feche outros programas que usam a porta ou tente o modo bootloader."
      );

      setProgress(0.12, "Lendo arquivos…");
      try {
        const bins = await getFlashBinaries();
        fwData = bins.fwData;
        partData = bins.partData;
        bootData = bins.bootData;
      } catch (err) {
        logLine((err && err.message) || String(err));
        setProgress(0, "Falha ao ler os arquivos.");
        return;
      }
      if (firmwareMode === "bundled" || firmwareMode === "factory") {
        const tag = firmwareMode === "factory" ? "Restauração de fábrica" : "Versão do site";
        logLine(
          tag + ": " +
            (bundledCache.label || "build") +
            " (v" +
            bundledCache.version +
            ")"
        );
      }

      const fileArray = [];
      if (bootData && bootData.length) {
        fileArray.push({ data: bootData, address: ADDR_BOOTLOADER });
        logLine("Bootloader → 0x" + ADDR_BOOTLOADER.toString(16) + " (" + bootData.length + " B)");
      }
      if (partData && partData.length) {
        fileArray.push({ data: partData, address: ADDR_PART });
        logLine("Partition table → 0x" + ADDR_PART.toString(16) + " (" + partData.length + " B)");
      }
      fileArray.push({ data: fwData, address: ADDR_APP });
      logLine("Firmware → 0x" + ADDR_APP.toString(16) + " (" + fwData.length + " B)");

      const doEraseAll = firmwareMode === "factory";
      if (doEraseAll) {
        logLine("Restauração de fábrica: a flash inteira será apagada antes de gravar (presets e calibrações serão perdidos).");
      }

      setProgress(0.18, "Gravando (não desconecte o USB)…");

      let calculateMD5Hash = undefined;
      try {
        calculateMD5Hash = makeFlashMd5Calculator(await loadSparkMd5());
        logLine("Verificação MD5 ativa (confere cada região após gravar).");
      } catch (e) {
        logLine(
          "Aviso: verificação MD5 desativada (" +
            ((e && e.message) || e) +
            "). Se «Pronto» aparecer sem mudança no chip, recarregue a página e tente outra rede."
        );
      }

      await esploader.writeFlash({
        fileArray,
        flashMode: "dio",
        flashFreq: "40m",
        flashSize: FLASH_SIZE,
        eraseAll: doEraseAll,
        compress: true,
        ...(calculateMD5Hash ? { calculateMD5Hash } : {}),
        reportProgress: (fileIndex, written, total) => {
          const p = 0.18 + (written / total) * 0.78;
          setProgress(
            p,
            "Gravação " + (fileIndex + 1) + "/" + fileArray.length + " — " + ((100 * written) / total).toFixed(0) + "%"
          );
        },
      });

      if (calculateMD5Hash) {
        logLine("MD5 na flash confere com os arquivos — gravação verificada.");
      }

      setProgress(0.98, "Concluindo e reiniciando o chip…");
      /* ESP32-S3 USB nativo: segundo argumento pede sequência de reset compatível com OTG. */
      await esploader.after("hard_reset", true);
      setProgress(1, "Concluído.");
      showFlashSuccessDialog();
      logLine(
        "Pronto — gravação concluída. Se o controlador não reiniciar sozinho, desconecte e reconecte o USB; com **USB JTAG/serial** (0x1001) o reinício automático **nem sempre** é visível."
      );
      setConnectionStatus(true);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      logLine("ERRO: " + msg);
      if (/md5/i.test(msg)) {
        logLine("Dica: os dados na flash não conferem com o arquivo — verifique o cabo, a alimentação ou outro programa usando a porta.");
      }
      if (/flash ?size|size/i.test(msg) || /mode/i.test(msg)) {
        logLine("Dica: confira o arquivo de firmware (mapeamento e formato).");
      }
      if (/failed to connect/i.test(msg)) {
        logLine(
          "Dica: confira se o firmware reiniciou após o comando CDC. Verifique o cabo e se você escolheu a linha **USB JTAG/serial** (0x1001), não a CDC (0x4009)."
        );
      }
      setProgress(0, "Falha na gravação.");
    } finally {
      try {
        if (transport && typeof transport.disconnect === "function") {
          await transport.disconnect();
        }
      } catch (_) { /* nada */ }
      transport = null;
      esploader = null;
      flashInProgress = false;
      if (port) {
        try {
          await serialReopenClean(port, ROM_BAUDRATE);
          logLine("Porta reaberta após gravação.");
        } catch (e) {
          logLine("Aviso: não foi possível reabrir a porta serial após gravar — clique em «Desconectar» e depois em «Conectar». " + ((e && e.message) || e));
        }
      }
      updateFlashButtonState();
    }
  });

  function onFwFilePicked() {
    if (firmwareMode !== "manual") return;
    updateFlashButtonState();
    if (port) {
      setProgress(0, getConnectedHint());
    }
  }
  el("fileFw")?.addEventListener("change", onFwFilePicked);
  el("fileFw")?.addEventListener("input", onFwFilePicked);
  el("filePart")?.addEventListener("change", onFwFilePicked);
  el("filePart")?.addEventListener("input", onFwFilePicked);

  document.querySelectorAll('input[name="fwSource"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        setFirmwareMode(radio.value);
        const label =
          radio.value === "factory"
            ? "restauração de fábrica (apaga tudo)"
            : radio.value === "manual"
              ? "arquivos no computador"
              : "versão do site";
        logLine("Origem: " + label);
      }
    });
  });
  el("reloadBundled")?.addEventListener("click", () => {
    logLine("Recarregando os arquivos da versão do site…");
    loadBundledFirmware();
  });

  el("downloadNotes")?.addEventListener("click", () => {
    downloadBundledReleaseNotes();
  });

  el("clearLog")?.addEventListener("click", () => {
    const logBox = el("log");
    if (logBox) logBox.textContent = "";
  });

  setupFlashDoneDialog();
  const rb = document.querySelector('input[name="fwSource"]:checked');
  if (rb) {
    setFirmwareMode(rb.value);
  } else {
    setFirmwareMode("bundled");
  }
  updateUiConnected(false);
  logLine("Ferramenta pronta. Você já pode conectar o dispositivo.");
}

/** Arranque: sem import estático (evita página em branco se um CDN cair) */
async function start() {
  const ok = el("loadOk");
  try {
    const m = await loadEsptool();
    ESPLoader = m.ESPLoader;
    Transport = m.Transport;
  } catch (e) {
    showBootError(e);
    if (el("main")) el("main").setAttribute("aria-hidden", "true");
    return;
  }
  try {
    setupEventHandlers();
    await loadBundledFirmware();
    if (ok) {
      ok.textContent = "Ferramenta pronta. Use Chrome ou Edge, conecte o cabo USB e clique em «Conectar dispositivo».";
      ok.classList.add("is-ready");
      ok.style.display = "block";
      ok.removeAttribute("aria-hidden");
    }
  } catch (e) {
    showBootError(new Error("Interface: " + (e && e.message)));
  }
}

start();
