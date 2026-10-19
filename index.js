const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const readline = require("readline");
const { loadConfig } = require("./config");
const U = require("./utils");
const registerGeneralCommands = require("./commands");
const { initFeatures } = require("./features");
const { createApi } = require("./server");

const config = loadConfig(__dirname);
const logger = pino({ level: config.logLevel });

// HTTP API untuk app Android (com.botmansx.bot) — REST + SSE, port dari config.apiPort
const api = createApi({ getState: () => state, config, rootDir: __dirname });
api.start();

process.on("uncaughtException", (e) => console.error("🔥 Uncaught exception:", e?.message || e));
process.on("unhandledRejection", (e) => console.error("🔥 Unhandled rejection:", e?.message || e));

const state = {
  sock: null,
  startTime: null,
  connection: "idle",
  antiSpam: new Map(),
  chats: new Set(),
  runtime: {
    autoReply: config.autoReply,
    readMessages: config.readMessages,
    autoApprove: config.autoApprove,
    stickerQuality: config.stickerQuality,
    warnThreshold: config.warnThreshold,
  },
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const reply = U.createReply(config);
const checkOwner = (jid, key) => U.isOwner(jid, key, config.owner);

const COMMANDS = new Map();

function register(cmd, { aliases = [], ownerOnly = false, cooldown = 0, handler }) {
  for (const k of [cmd, ...aliases]) {
    COMMANDS.set(k, { cmd, aliases, ownerOnly, cooldown, handler });
  }
}

async function runCommand(sock, msg, jid, participant, command, args, text) {
  const def = COMMANDS.get(command);
  if (!def) return false;

  const now = Date.now();
  const last = state.antiSpam.get(participant) || 0;
  const cooldownMs = def.cooldown > 0 ? def.cooldown : config.cooldownMs;
  if (now - last < cooldownMs) return true;
  state.antiSpam.set(participant, now);

  if (def.ownerOnly && !checkOwner(jid, msg.key)) {
    reply(sock, jid, "⛔ Perintah ini khusus owner.", msg).catch(() => {});
    return true;
  }

  const stripped = text.replace(
    new RegExp(`^\\s*(?:${config.prefixes.map(escapeRegex).join("|")})\\s*${escapeRegex(command)}\\s*`, "i"),
    ""
  );

  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    await def.handler({ sock, jid, msg, args, isGroup: jid.endsWith("@g.us"), participant, text: stripped });
  } catch (e) {
    console.error("Handler error:", e);
    reply(sock, jid, "⚠️ Terjadi error saat memproses perintah.", msg).catch(() => {});
  }
  return true;
}

async function handleIncoming(sock, msg) {
  if (!msg.message) return;
  if (msg.key.fromMe && !U.isCommand(U.getText(msg), config.prefixes)) return;

  const jid = msg.key.remoteJid;
  if (jid === "status@broadcast") return;
  const isGroup = jid.endsWith("@g.us");
  const participant = msg.key.participant || jid;
  const text = U.getText(msg);

  if (text) console.log(`💬 ${jid}: "${text}"`);

  for (const hook of features.onMessage) {
    try {
      const consumed = await hook(sock, msg, {
        jid, isGroup, participant, text, isOwner: checkOwner(jid, msg.key),
      });
      if (consumed) return;
    } catch (e) {
      console.error("Feature hook error:", e.message);
    }
  }

  if (state.runtime.readMessages) sock.readMessages([msg.key]).catch(() => {});

  if (U.isCommand(text, config.prefixes)) {
    const parsed = U.parseCommand(text, config.prefixes);
    if (!parsed) return;
    const { command, args } = parsed;
    if (!COMMANDS.get(command)) {
      return reply(sock, jid, `❌ Perintah *${command}* tidak dikenal. Ketik *${config.prefixes[0]}menu*`, msg);
    }
    return runCommand(sock, msg, jid, participant, command, args, text);
  }

  const bareCmd = text.trim().toLowerCase();
  if (COMMANDS.has(bareCmd) && !bareCmd.includes(" ")) {
    return runCommand(sock, msg, jid, participant, bareCmd, [], text);
  }

  if (state.runtime.autoReply && text) {
    const lower = text.toLowerCase();
    const isGreeting =
      config.greetings.includes(lower) || lower.startsWith("halo") || lower.startsWith("hai");
    if (isGreeting) {
      return reply(sock, jid, `Halo! 👋 Ketik *${config.prefixes[0]}menu* untuk lihat perintah.`, msg);
    }
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

async function runHookLoop(hooks, sock, update, label) {
  for (const hook of hooks) {
    try {
      await hook(sock, update);
    } catch (e) {
      console.error(`${label} hook error:`, e.message);
    }
  }
}

async function startBot() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    browser: Browsers.ubuntu("Chrome"),
    auth: {
      creds: auth.creds,
      keys: makeCacheableSignalKeyStore(auth.keys, logger),
    },
    syncFullHistory: false,
    markOnlineOnConnect: config.markOnline,
  });
  state.sock = sock;
  state.startTime = Date.now();
  state.connection = "connecting";
  api.attachSock(sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      state.connection = "closed";
      api.emit("status", api.status());
      console.log(`Connection closed (${statusCode}). ${shouldReconnect ? "Reconnecting..." : "Logged out"}`);
      if (shouldReconnect) {
        const delay = statusCode === DisconnectReason.connectionReplaced ? 15000 : 3000;
        await new Promise((r) => setTimeout(r, delay));
        startBot();
      }
    } else if (connection === "open") {
      const id = sock.user?.id || auth.creds.me?.id || "unknown";
      state.connection = "open";
      console.log(`✅ Bot connected as ${id}`);
      api.emit("status", api.status());
    } else if (connection) {
      state.connection = connection;
      api.emit("status", api.status());
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) await handleIncoming(sock, msg);
  });

  sock.ev.on("chats.set", ({ chats }) => {
    for (const c of chats) if (c.id) state.chats.add(c.id);
  });
  sock.ev.on("chats.upsert", (chats) => {
    for (const c of chats) if (c.id) state.chats.add(c.id);
  });

  sock.ev.on("call", async ({ from, id, status }) => {
    if (status === "offer" && config.rejectCalls) {
      sock.rejectCall(id, from).catch(() => {});
      console.log(`📞 Incoming call from ${from} rejected.`);
    }
  });

  sock.ev.on("group-participants.update", (update) =>
    runHookLoop(features.onGroupParticipantsUpdate, sock, update, "Group")
  );

  sock.ev.on("group.join-request", (update) =>
    runHookLoop(features.onGroupJoinRequest, sock, update, "JoinRequest")
  );

  if (!auth.creds.registered) {
    const phone = process.env.PHONE_NUMBER || (await ask("Masukkan nomor WhatsApp (contoh 628123456789): "));
    try {
      const code = await sock.requestPairingCode(phone);
      console.log("\n🔑 Pairing Code: " + code);
      console.log("Buka WhatsApp > Perangkat Tertaut > Tautkan Perangkat\n");
    } catch (e) {
      console.error("Gagal minta pairing code:", e.message);
    }
  }

  return sock;
}

const features = initFeatures({
  register,
  reply,
  getJid: U.getJid,
  isOwner: checkOwner,
  OWNER_NUMBER: config.owner[0],
  config: state.runtime,
});

registerGeneralCommands({
  register,
  reply,
  getJid: U.getJid,
  sendPoll: U.sendPoll,
  formatUptime: U.formatUptime,
  state,
  config,
});

startBot().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
