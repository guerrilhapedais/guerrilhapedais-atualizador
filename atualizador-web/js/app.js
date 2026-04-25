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
const FLASH_SIZE = "4MB";

const el = (id) => document.getElementById(id);

let ESPLoader;
let Transport;
let transport = null;
let esploader = null;
let port = null;
let libVersion = null;
let serialConnectBusy = false;
let flashInProgress = false;

/** «bundled» = manifest + .bin em firmware/latest/; «manual» = ficheiros locais. A gravação USB é a mesma. */
let firmwareMode = "bundled";
let bundledCache = {
  ok: false,
  version: "",
  label: "",
  fw: null,
  part: null,
  err: null,
};

const MANIFEST_URL = new URL("../firmware/latest/manifest.json", import.meta.url);

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
  if (!p) throw new Error("Sem porta série");
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
      "). O comando ao controlador envia-se ao **Ligar**; reinicia o USB se precisares da linha ROM (0x1001) para gravar."
  );
}

/** O Web Serial não dá o nome «COMx»; o .exe usa `serial.tools.list_ports`. */
function logSerialPortSummary(p) {
  if (!p || typeof p.getInfo !== "function") return;
  const i = p.getInfo();
  const vid = i.usbVendorId != null ? "0x" + i.usbVendorId.toString(16) : "—";
  const pid = i.usbProductId != null ? "0x" + i.usbProductId.toString(16) : "—";
  logLine("Porta (Web Serial): mesmo dispositivo que escolheste no Chrome — USB VID " + vid + " PID " + pid + ".");
  logLine("(No .exe aparece «COM…»; no browser só há este identificador USB.)");
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
  return !!(el("fileFw")?.files?.[0]);
}

function getConnectedHint() {
  if (firmwareMode === "bundled") {
    if (bundledCache.ok) {
      return "Ligado. Clica «Gravar firmware» para sincronizar e gravar.";
    }
    return "Ligado. A atualização pré-selecionada não carregou — recarrega ou escolhe «Ficheiros no computador».";
  }
  const hasFw = !!(el("fileFw")?.files?.[0]);
  return hasFw
    ? "Ligado. Clica «Gravar firmware» para sincronizar e gravar."
    : "Ligado. Escolhe o ficheiro .bin e clica «Gravar firmware».";
}

function updateFlashButtonState() {
  const flashBtn = el("flash");
  if (!flashBtn) return;
  const canTry = port != null && !flashInProgress && !serialConnectBusy && hasFirmwareReady();
  flashBtn.disabled = !canTry;
}

function setFirmwareMode(mode) {
  firmwareMode = mode === "manual" ? "manual" : "bundled";
  const bundledPanel = el("bundledPanel");
  const manualPanel = el("manualPanel");
  if (bundledPanel) bundledPanel.hidden = firmwareMode !== "bundled";
  if (manualPanel) manualPanel.hidden = firmwareMode !== "manual";
  updateFlashButtonState();
  if (port) {
    setProgress(0, getConnectedHint());
  }
}

async function getFlashBinaries() {
  if (firmwareMode === "bundled") {
    if (!bundledCache.ok || !bundledCache.fw) {
      throw new Error("Atualização pré-selecionada indisponível — recarrega a página ou usa ficheiros no computador.");
    }
    return { fwData: bundledCache.fw, partData: bundledCache.part };
  }
  const fileFw = el("fileFw");
  const filePart = el("filePart");
  const fw = fileFw?.files?.[0];
  if (!fw) {
    throw new Error("Escolhe o ficheiro de firmware .bin");
  }
  const fwData = new Uint8Array(await fw.arrayBuffer());
  const partFile = filePart?.files?.[0] || null;
  let partData = null;
  if (partFile) {
    partData = new Uint8Array(await partFile.arrayBuffer());
  }
  return { fwData, partData };
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
    statusEl.textContent = "A carregar ficheiros…";
    statusEl.classList.remove("firmware-bundled-status--err", "firmware-bundled-status--ok");
  }
  setBundledSourceSubline("A carregar a versão…", null);
  try {
    const r = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!r.ok) {
      throw new Error("manifest.json em falta (HTTP " + r.status + ").");
    }
    const m = await r.json();
    const base = new URL("./", MANIFEST_URL);
    const fwName = m.firmware;
    if (!fwName || typeof fwName !== "string") {
      throw new Error("No manifest, o campo «firmware» (nome do .bin) é obrigatório.");
    }
    const fwRes = await fetch(new URL(fwName, base), { cache: "no-store" });
    if (!fwRes.ok) {
      throw new Error("Ficheiro «" + fwName + "» não encontrado (HTTP " + fwRes.status + ").");
    }
    const buf = await fwRes.arrayBuffer();
    if (!buf || buf.byteLength === 0) {
      throw new Error("O ficheiro de firmware está vazio.");
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
    const version = String(m.version != null ? m.version : "—");
    const label = String(m.label != null ? m.label : "");
    bundledCache = { ok: true, version, label, fw, part, err: null };
    const vDisp =
      version && version !== "—"
        ? "Versão " + version
        : "Define o campo «version» no manifesto";
    setBundledSourceSubline(vDisp, "ok");
    if (statusEl) {
      const extra = m.partition ? " — com tabela de partições" : " — só app";
      const head = label ? label + " — " : "";
      statusEl.textContent =
        head + (fw.length / 1024).toFixed(0) + " KB" + extra + " — pronto a gravar";
      statusEl.classList.add("firmware-bundled-status--ok");
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    bundledCache = { ok: false, version: "", label: "", fw: null, part: null, err: msg };
    setBundledSourceSubline("Não disponível — escolhe ficheiros no computador", "err");
    if (statusEl) {
      statusEl.textContent = "Não carregou: " + msg;
      statusEl.classList.add("firmware-bundled-status--err");
    }
  }
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
  logLine("A pedir acesso USB (escolhe a porta do dispositivo no diálogo)…");
  return await navigator.serial.requestPort({ filters: ESP32_S3_SERIAL_FILTERS });
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
  const statusState = el("statusState");
  if (statusState) statusState.textContent = "—";
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
      logLine("Usa Chrome ou Edge com Web Serial.");
      return;
    }
    if (serialConnectBusy) {
      logLine("Ligação já em curso — aguarda.");
      return;
    }
    serialConnectBusy = true;
    try {
      await cleanupPort({ skipUi: true });
      port = await pickSerialPort();
      logLine("A abrir a porta USB (Web Serial, " + ROM_BAUDRATE + " baud)…");
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
          logLine("Comando GUERRILHA_UPDATE enviado (pedido em NVS). Sem reinício automático no chip — reinicia o USB se precisares da ROM para gravar.");
        } catch (e) {
          logLine("Aviso: não foi possível enviar o comando à CDC (" + ((e && e.message) || e) + ").");
        }
        logLine("«Gravar firmware» sincroniza e grava; em modo app TinyUSB volta a enviar o comando antes do esptool.");
      } else {
        logLine("«Gravar firmware» sincroniza e grava (porta já é ROM ou outra linha — sem comando CDC ao ligar).");
      }
      if (el("statusState")) el("statusState").textContent = "Ligado";
      updateUiConnected(true);
    } catch (e) {
      if (isUserCancelledPortPick(e)) {
        logLine("Cancelaste a escolha da porta — volta a clicar «Ligar dispositivo».");
      } else {
        const em = (e && e.message) || String(e);
        logLine("Erro: " + em + " — (Desligar nesta página, espera 1–2 s, fecha outra aba com o site ou outra app na COM; tenta de novo.)");
        if (/already open/i.test(em)) {
          logLine("Dica «already open»: o Chrome ainda não libertou a porta; «Desligar» + espera ou recarrega a página.");
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
    logLine("A desligar…");
    await cleanupPort();
  });

  el("flash")?.addEventListener("click", async () => {
    if (!port) {
      logLine("Primeiro: «Ligar dispositivo» e escolhe a porta USB.");
      return;
    }
    if (firmwareMode === "bundled") {
      if (!bundledCache.ok) {
        logLine("A atualização pré-selecionada não está pronta — recarrega ou escolhe «Ficheiros no computador».");
        return;
      }
    } else if (!el("fileFw")?.files?.[0]) {
      logLine("Escolhe o ficheiro de firmware .bin");
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
     * O Chrome exige que `requestPort()` seja invocado no mesmo turno do clique (antes de qualquer await).
     * Depois do CDC + esperas, o gesto expira — por isso o diálogo da ROM vem primeiro.
     */
    let romPortRequestPromise = null;
    if (tinyusbAppOnlyPid(pidPrep)) {
      logLine(
        "No diálogo escolhe **USB JTAG/serial** (ROM, PID 0x" +
          USB_PID_ESP32S3_ROM_JTAG.toString(16) +
          "); a seguir envia-se o comando à CDC."
      );
      logLine(
        "Se o Chrome **não** listar o dispositivo ou falhar a reconexão, **reinicia o USB** (desliga/liga) com o chip em modo update, volta a «Ligar» se precisares e escolhe **0x1001** em «Gravar»."
      );
      romPortRequestPromise = navigator.serial.requestPort({ filters: ESP32_ROM_JTAG_FILTERS });
    }

    const baud = FLASH_BAUDRATE;
    flashInProgress = true;
    updateFlashButtonState();

    let fwData;
    let partData;
    try {
      setProgress(0.02, "A preparar a porta USB…");
      if (tinyusbAppOnlyPid(pidPrep)) {
        let romHandle;
        try {
          romHandle = await romPortRequestPromise;
        } catch (e) {
          if (isUserCancelledPortPick(e)) {
            logLine("Cancelaste a porta ROM — operação interrompida.");
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
            "ERRO: No 2.º diálogo foi escolhida a porta da **applicação** (PID 0x" +
              romPidCheck.toString(16) +
              "), não a **USB JTAG/serial** (0x" +
              USB_PID_ESP32S3_ROM_JTAG.toString(16) +
              "). Repete «Gravar firmware» e escolhe só a linha **USB JTAG/serial**."
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
              " para ROM). Se falhar a sincronização, confirma o cabo e o modo bootloader."
          );
        }
        logLine("CDC (TinyUSB): a reenviar comando de preparação…");
        try {
          await sendCdcUpdateKick(port);
          logLine("Comando enviado. **Reinicia o USB** (ou o chip) para a ROM (0x1001) aparecer, se ainda estiveres na app.");
          await sleepMs(CDC_UPDATE_GRAVAR_PAUSE_MS);
        } catch (e) {
          logLine("Aviso: falha ao enviar à CDC (" + ((e && e.message) || e) + "). Continuação…");
        }
        logLine("A fechar a CDC e a abrir a linha ROM para o esptool…");
        try {
          await port.close();
        } catch (_) {
          /* */
        }
        port = null;
        await sleepMs(450);
        try {
          await romHandle.close();
        } catch (_) {
          /* */
        }
        await sleepMs(120);
        try {
          await romHandle.open({ baudRate: ROM_BAUDRATE });
        } catch (e) {
          const name = e && e.name;
          const em = (e && e.message) || String(e);
          if (name !== "InvalidStateError" && !/already open/i.test(em)) {
            throw e;
          }
        }
        port = romHandle;
        logSerialPortSummary(port);
        logLine("Porta USB pronta para sincronizar (interface ROM).");
      } else {
        logLine("A fechar/reabrir a porta (evita «already open» e limpa o estado antes do esptool)…");
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

      setProgress(0.06, "A sincronizar com o chip (esptool)…");
      logLine("A sincronizar com o chip (esptool)…");
      await withTimeout(
        esploader.main("default_reset"),
        SYNC_TIMEOUT_MS,
        "Sincronização demorou mais de " +
          Math.round(SYNC_TIMEOUT_MS / 1000) +
          " s. Fecha outras apps na porta ou tenta modo bootloader."
      );

      setProgress(0.12, "A ler ficheiros…");
      try {
        const bins = await getFlashBinaries();
        fwData = bins.fwData;
        partData = bins.partData;
      } catch (err) {
        logLine((err && err.message) || String(err));
        setProgress(0, "Falha ao ler ficheiros.");
        return;
      }
      if (firmwareMode === "bundled") {
        logLine(
          "A usar atualização pré-selecionada: " +
            (bundledCache.label || "build") +
            " (v" +
            bundledCache.version +
            ")"
        );
      }

      const fileArray = [];
      if (partData && partData.length) {
        fileArray.push({ data: partData, address: ADDR_PART });
        logLine("Partition table → 0x" + ADDR_PART.toString(16) + " (" + partData.length + " B)");
      }
      fileArray.push({ data: fwData, address: ADDR_APP });
      logLine("Firmware → 0x" + ADDR_APP.toString(16) + " (" + fwData.length + " B)");

      setProgress(0.18, "A gravar (não desligues o USB)…");

      let calculateMD5Hash = undefined;
      try {
        calculateMD5Hash = makeFlashMd5Calculator(await loadSparkMd5());
        logLine("Verificação MD5 na flash activa (confere cada região após gravar).");
      } catch (e) {
        logLine(
          "Aviso: verificação MD5 desactivada (" +
            ((e && e.message) || e) +
            "). Se «Pronto» aparecer sem alteração no chip, recarrega a página e tenta outra rede."
        );
      }

      await esploader.writeFlash({
        fileArray,
        flashMode: "dio",
        flashFreq: "40m",
        flashSize: FLASH_SIZE,
        eraseAll: false,
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
        logLine("MD5 na flash confere com os ficheiros — gravação verificada.");
      }

      setProgress(0.98, "A concluir e reiniciar o chip…");
      /* ESP32-S3 USB nativo: segundo argumento pede sequência de reset compatível com OTG. */
      await esploader.after("hard_reset", true);
      setProgress(1, "Concluído.");
      showFlashSuccessDialog();
      logLine(
        "Pronto — gravação concluída. Reinicia o MT-Series desligando e voltando a ligar o USB do controlador se não arrancar sozinho; com **USB JTAG/serial** (0x1001) o reset automático **nem sempre** é visível."
      );
      if (el("statusState")) el("statusState").textContent = "Ligado";
    } catch (e) {
      const msg = (e && e.message) || String(e);
      logLine("ERRO: " + msg);
      if (/md5/i.test(msg)) {
        logLine("Dica: dados na flash não batem certo com o ficheiro — cabo, alimentação ou outra app a usar a porta.");
      }
      if (/flash ?size|size/i.test(msg) || /mode/i.test(msg)) {
        logLine("Dica: confirma o ficheiro de firmware (mapeamento e formato).");
      }
      if (/failed to connect/i.test(msg)) {
        logLine(
          "Dica: confirma o reinício no firmware após o comando CDC. Verifica o cabo e se escolheste a linha **USB JTAG/serial** (0x1001), não a CDC (0x4009)."
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
          logLine("Aviso: não foi possível reabrir a série após gravação — «Desligar» e volta a «Ligar». " + ((e && e.message) || e));
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
        logLine(
          "Origem: " + (radio.value === "bundled" ? "atualização pré-selecionada" : "ficheiros no computador")
        );
      }
    });
  });
  el("reloadBundled")?.addEventListener("click", () => {
    logLine("A recarregar ficheiros da atualização pré-selecionada…");
    loadBundledFirmware();
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
  logLine("Ferramenta pronta. Podes ligar o dispositivo.");
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
      ok.textContent = "Ferramenta pronta. Usa Chrome ou Edge, liga o cabo USB e clica «Ligar dispositivo».";
      ok.classList.add("is-ready");
      ok.style.display = "block";
      ok.removeAttribute("aria-hidden");
    }
  } catch (e) {
    showBootError(new Error("Interface: " + (e && e.message)));
  }
}

start();
