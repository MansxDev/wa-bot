const {
  proto,
  generateWAMessageFromContent,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { execFile } = require("child_process");
const sharp = require("sharp");
const os = require("os");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const logger = pino({ level: "silent" });

function loadJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(name, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj, null, 2));
}

function getJid(number) {
  if (String(number).includes("@")) return number;
  let n = String(number).replace(/[^0-9]/g, "");
  if (n.startsWith("0")) n = "62" + n.slice(1);
  return n + "@s.whatsapp.net";
}

function normalizeNumber(v) {
  return String(v || "").split("@")[0].replace(/[^0-9]/g, "").replace(/^0/, "62");
}

function isOwner(jid, key, owners) {
  if (key?.fromMe) return true;
  const n = normalizeNumber(jid);
  return owners.some((o) => normalizeNumber(o) === n);
}

function normJid(jid) {
  return normalizeNumber(jid);
}

function sameUser(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return normJid(a) === normJid(b);
}

function formatRupiah(n) {
  return "Rp " + Number(n || 0).toLocaleString("id-ID");
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m}m ${s % 60}s`;
}

function quotedMedia(msg) {
  const ci = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  return ci ? { message: ci } : null;
}

function getText(msg) {
  const m = msg.message;
  if (!m) return "";
  if (m.interactiveResponseMessage) {
    const irm = m.interactiveResponseMessage;
    try {
      const p = JSON.parse(irm.nativeFlowResponseMessage?.paramsJson || "{}");
      if (p.id) return String(p.id);
    } catch {}
    return irm.body?.text || "";
  }
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

function isCommand(text, prefixes) {
  return typeof text === "string" && prefixes.some((p) => text.startsWith(p));
}

function parseCommand(text, prefixes) {
  const lower = text.toLowerCase();
  const prefix = prefixes.find((p) => lower.startsWith(p));
  if (!prefix) return null;
  const [command, ...args] = lower.slice(prefix.length).trim().split(/\s+/);
  return { command: command || "", args };
}

function run(cmd, args, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || "").trim().split("\n")[0]));
      else resolve({ stdout: (stdout || "").trim(), stderr: (stderr || "").trim() });
    });
  });
}

async function makeImageSticker(buffer, quality) {
  return sharp(buffer)
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: quality || 90 })
    .toBuffer();
}

async function makeVideoSticker(inputFile, outputFile) {
  const args = [
    "-y",
    "-i", inputFile,
    "-vf", "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0.0,format=rgba",
    "-loop", "0",
    "-t", "10",
    "-c:v", "libwebp",
    "-quality", "80",
    "-an",
    outputFile,
  ];
  await run("ffmpeg", args, 60000);
  return fs.readFileSync(outputFile);
}

function buildOrderText(cart, total) {
  const rows = cart
    .map((it, i) => `${i + 1}. ${it.name} x${it.qty} — ${formatRupiah(it.price * it.qty)}`)
    .join("\n");
  return `🛒 *NOTA PESANAN*\n\n${rows}\n\n💰 *Total: ${formatRupiah(total)}*`;
}

function createReply(config) {
  const quoted = {
    key: { fromMe: false, id: "BOTQUOTE", remoteJid: "0@s.whatsapp.net" },
    message: { extendedTextMessage: { text: `🤖 ${config.botName} | ${config.botFooter}` } },
  };
  return (sock, jid, text) => sock.sendMessage(jid, { text }, { quoted });
}

function relayContent(sock, jid, content) {
  const gen = generateWAMessageFromContent(jid, content, { userJid: sock.user?.id });
  return sock.relayMessage(jid, gen.message, { messageId: gen.key.id });
}

function sendPoll(sock, jid, { name, options, selectableCount }) {
  const content = proto.Message.fromObject({
    pollCreationMessage: {
      name,
      options: options.map((o) => ({ optionName: o })),
      selectableOptionsCount: selectableCount || 1,
    },
  });
  return relayContent(sock, jid, content);
}

function sendNativeButtons(sock, jid, { title, body, footer, buttons }) {
  const interactive = proto.Message.InteractiveMessage.fromObject({
    header: proto.Message.InteractiveMessage.Header.fromObject({
      title: title || "", subtitle: "", hasMediaAttachment: false,
    }),
    body: { text: body || "" },
    footer: { text: footer || "" },
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
      buttons: buttons.map((b) => ({
        name: b.name || "quick_reply",
        buttonParamsJson: typeof b.params === "string" ? b.params : JSON.stringify(b.params),
      })),
      messageVersion: 1,
    }),
  });
  return relayContent(sock, jid, { viewOnceMessage: { message: { interactiveMessage: interactive } } });
}

function sendCarouselCards(sock, jid, { cards }) {
  const interactive = proto.Message.InteractiveMessage.fromObject({
    carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({
      cards: cards.map((c) =>
        proto.Message.InteractiveMessage.fromObject({
          header: proto.Message.InteractiveMessage.Header.fromObject({
            title: c.title || "", subtitle: c.subtitle || "", hasMediaAttachment: false,
          }),
          body: { text: c.body || "" },
          footer: { text: c.footer || "" },
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
            buttons: (c.buttons || []).map((b) => ({
              name: b.name || "quick_reply",
              buttonParamsJson: typeof b.params === "string" ? b.params : JSON.stringify(b.params),
            })),
            messageVersion: 1,
          }),
        })
      ),
      messageVersion: 1,
      carouselCardType: 1,
    }),
  });
  return relayContent(sock, jid, { viewOnceMessage: { message: { interactiveMessage: interactive } } });
}

function downloadMedia(target) {
  return downloadMediaMessage(target, "buffer", {}, { logger });
}

module.exports = {
  DATA_DIR,
  logger,
  loadJSON,
  saveJSON,
  getJid,
  normalizeNumber,
  isOwner,
  normJid,
  sameUser,
  formatRupiah,
  formatUptime,
  quotedMedia,
  getText,
  isCommand,
  parseCommand,
  makeImageSticker,
  makeVideoSticker,
  buildOrderText,
  createReply,
  relayContent,
  sendPoll,
  sendNativeButtons,
  sendCarouselCards,
  downloadMedia,
};
