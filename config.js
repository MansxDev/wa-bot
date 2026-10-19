const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  owner: [process.env.OWNER_NUMBER || "6281546543913"],
  prefixes: ["!", ".", "#", "/"],
  cooldownMs: 1500,
  sessionDir: "./session",
  botName: "Bot WA",
  botFooter: "Ketik !menu untuk daftar perintah",
  autoReply: true,
  readMessages: true,
  autoApprove: false,
  rejectCalls: true,
  markOnline: true,
  greetings: ["halo", "hi", "hai", "hello", "assalamu", "p", "tes", "test", "bot"],
  broadcastDelayMs: 300,
  stickerQuality: 90,
  warnThreshold: 3,
  logLevel: process.env.LOG_LEVEL || "silent",
};

function loadConfig(rootDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir, "config.json"), "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    console.warn("⚠️ config.json tidak valid/tidak ada, pakai default:", e.message);
    return { ...DEFAULT_CONFIG };
  }
}

module.exports = { loadConfig };
