/**
 * Guerrilha Pedais — atualizador web (partition 0x8000, app 0x10000, USB a bordo)
 * Carrega esptool-js com vários CDNs; import estático de esm.sh falhava muitas vezes.
 */
const ESPTOOL_CDNS = [
  "https://cdn.jsdelivr.net/npm/esptool-js@0.6.0/+esm",
  "https://esm.run/esptool-js@0.6.0",
  "https://esm.sh/esptool-js@0.6.0?bundle&target=es2020",
  "https://esm.sh/esptool-js@0.5.7",
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

function updateUiConnected(isConnected) {
  const hasSerial = "serial" in navigator;
  const connectBtn = el("connect");
  const flashBtn = el("flash");
  const disconnectBtn = el("disconnect");
  if (connectBtn) {
    connectBtn.disabled = isConnected || !hasSerial;
  }
  if (disconnectBtn) disconnectBtn.disabled = !isConnected;
  if (flashBtn) flashBtn.disabled = !isConnected;
  if (isConnected) {
    setProgress(0, "Ligado. Escolhe os ficheiros e grava.");
  }
}

async function cleanupPort() {
  try {
    if (transport && typeof transport.disconnect === "function") {
      await transport.disconnect();
    }
  } catch (_) { /* nada */ }
  transport = null;
  esploader = null;
  port = null;
  const statusState = el("statusState");
  if (statusState) statusState.textContent = "—";
  setProgress(0, "");
  updateUiConnected(false);
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
    try {
      logLine("A pedir acesso USB (escolhe a porta do dispositivo)…");
      port = await navigator.serial.requestPort();
      const baud = parseInt(String(el("baudRate")?.value || 115200), 10) || 115200;
      await port.open({ baudRate: baud });

      transport = new Transport(port, true);
      const loaderOpts = {
        transport,
        baudrate: baud,
        romBaudrate: 115200,
        debugLogging: false,
        terminal: terminal(),
      };
      esploader = new ESPLoader(loaderOpts);
      setProgress(0.05, "A estabelecer ligação…");
      await esploader.main();
      if (el("statusState")) el("statusState").textContent = "Pronto";
      setProgress(0.1, "Ligado.");
      updateUiConnected(true);
    } catch (e) {
      logLine(
        "Erro: " +
          ((e && e.message) || e) +
          " — (tenta 115200 e desligar/religar o cabo.)"
      );
      await cleanupPort();
    }
  });

  el("disconnect")?.addEventListener("click", async () => {
    logLine("A desligar…");
    await cleanupPort();
  });

  el("flash")?.addEventListener("click", async () => {
    if (!esploader) {
      logLine("Primeiro: Ligar o dispositivo.");
      return;
    }
    const fileFw = el("fileFw");
    const filePart = el("filePart");
    const flashBtn = el("flash");
    const fw = fileFw?.files?.[0];
    if (!fw) {
      logLine("Escolhe o ficheiro de firmware .bin");
      return;
    }

    try {
      if (flashBtn) flashBtn.disabled = true;
      setProgress(0.15, "A ler ficheiros…");
      const fwData = new Uint8Array(await fw.arrayBuffer());
      const partFile = filePart?.files?.[0] || null;
      let partData = null;
      if (partFile) partData = new Uint8Array(await partFile.arrayBuffer());

      const fileArray = [];
      if (partData && partData.length) {
        fileArray.push({ data: partData, address: ADDR_PART });
        logLine("Partition table → 0x" + ADDR_PART.toString(16) + " (" + partData.length + " B)");
      }
      fileArray.push({ data: fwData, address: ADDR_APP });
      logLine("Firmware → 0x" + ADDR_APP.toString(16) + " (" + fwData.length + " B)");

      setProgress(0.2, "A gravar (não desligues o USB)…");

      await esploader.writeFlash({
        fileArray,
        flashMode: "dio",
        flashFreq: "40m",
        flashSize: FLASH_SIZE,
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          const p = 0.2 + (written / total) * 0.75;
          setProgress(
            p,
            "Gravação " + (fileIndex + 1) + "/" + fileArray.length + " — " + ((100 * written) / total).toFixed(0) + "%"
          );
        },
      });

      setProgress(0.98, "A concluir…");
      await esploader.after("hard_reset");
      setProgress(1, "Concluído.");
      logLine("Pronto.");
    } catch (e) {
      const msg = (e && e.message) || String(e);
      logLine("ERRO: " + msg);
      if (/flash ?size|size/i.test(msg) || /mode/i.test(msg)) {
        logLine("Dica: confirma o ficheiro de firmware (mapeamento e formato).");
      }
      setProgress(0, "Falha na gravação.");
    } finally {
      if (flashBtn) flashBtn.disabled = false;
    }
  });

  el("clearLog")?.addEventListener("click", () => {
    const logBox = el("log");
    if (logBox) logBox.textContent = "";
  });

  updateUiConnected(false);
  logLine("Biblioteca de flash: OK (" + (libVersion || "esptool-js") + "). Podes Ligar o dispositivo.");
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
    if (ok) {
      ok.textContent = "Ferramenta pronta. Clica em «Ligar dispositivo» (Chrome ou Edge, com dispositivo por USB).";
      ok.classList.add("is-ready");
      ok.style.display = "block";
      ok.removeAttribute("aria-hidden");
    }
  } catch (e) {
    showBootError(new Error("Interface: " + (e && e.message)));
  }
}

start();
