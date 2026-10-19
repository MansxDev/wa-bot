"use strict";

/**
 * BotMansx HTTP API
 * -----------------
 * REST (POST/GET/PATCH) untuk kontrol + SSE stream untuk event real-time.
 * Tanpa dependency baru: cukup node:http. `qrcode-terminal` sudah ada di package.json.
 *
 * Dipakai oleh app Android (com.botmansx.bot) dan bisa dipakai curl / Termux.
 *
 * Auth: `Authorization: Bearer <token>` (token ada di config.json, dicetak saat start).
 * - Token hanya diterima lewat header. Query string DITOLAK karena bocor ke
 *   access log proxy, header Referer, dan history browser.
 * - Perbandingan constant-time + batas 10x gagal/menit per IP.
 * - CORS dimatikan: konsumennya app Android & curl, bukan browser.
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");
const U = require("./utils");

const MAX_LOGS = 2000;
const MAX_MSG_PER_CHAT = 40;
const GROUP_CACHE_MS = 60 * 1000;
const EPHEM = { off: 0, "1": 86400, "7": 604800, "30": 2592000 };

function stringify(x) {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack || x.message;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function ensureToken(config, rootDir) {
  if (config.token) return config.token;
  const token = crypto.randomBytes(16).toString("hex");
  config.token = token;
  try {
    const file = path.join(rootDir, "config.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.token = token;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  } catch {
    console.warn("⚠️ Gagal menyimpan token ke config.json, token hanya aktif selama process ini.");
  }
  return token;
}

/**
 * Bandingkan token dalam waktu tetap. `===` keluar lebih cepat begitu byte
 * pertama beda, jadi penyerang bisa menebak token byte per byte dari timing 401.
 */
function tokenMatch(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // timingSafeEqual mensyaratkan panjang sama. Sentuh b dengan dirinya sendiri
    // supaya jalur kode sama DURASI-nya, jadi panjang tidak bocor lewat timing.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Rate limit percobaan token gagal per IP. Dipisah jadi factory supaya
 * auth-check.js bisa menguji logikanya yang sama, bukan salinan.
 */
function createRateLimiter({ maxFails, windowMs, now = Date.now } = {}) {
  const hits = new Map();
  return {
    limited(key) {
      const entry = hits.get(key);
      if (!entry) return false;
      if (now() - entry.since > windowMs) {
        hits.delete(key);
        return false;
      }
      return entry.count >= maxFails;
    },
    fail(key) {
      const t = now();
      const entry = hits.get(key);
      if (!entry || t - entry.since > windowMs) hits.set(key, { count: 1, since: t });
      else entry.count += 1;
      if (hits.size > 512) {
        for (const [k, v] of hits) if (now() - v.since > windowMs) hits.delete(k);
      }
    },
    clear(key) {
      hits.delete(key);
    },
  };
}

const authLimiter = createRateLimiter({ maxFails: 10, windowMs: 60_000 });
const failKey = (req) => req.socket.remoteAddress || "unknown";

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      out.push({ iface: name, address: net.address });
    }
  }
  return out;
}

function createApi({ getState, config, rootDir }) {
  const token = ensureToken(config, rootDir);
  const port = Number(process.env.PORT || config.apiPort || 4000);
  const host = process.env.API_HOST || config.apiHost || "0.0.0.0";

  const clients = new Set();
  const logs = [];
  const chatCache = new Map();
  const msgHistory = new Map();
  const groupCache = new Map();

  let logSeq = 0;
  let attachedSock = null;
  let consolePatched = false;
  let server = null;

  /* ------------------------------------------------------------------ *
   * Event bus (SSE)
   * ------------------------------------------------------------------ */

  function emit(type, data) {
    if (!clients.size) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  }

  function pushLog(level, args) {
    const entry = {
      id: ++logSeq,
      ts: Date.now(),
      level,
      text: args.map(stringify).join(" "),
    };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    emit("log", entry);
  }

  function patchConsole() {
    if (consolePatched) return;
    consolePatched = true;
    for (const level of ["log", "warn", "error"]) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        pushLog(level === "log" ? "info" : level, args);
        original(...args);
      };
    }
  }

  /* ------------------------------------------------------------------ *
   * Status
   * ------------------------------------------------------------------ */

  function baileysVersion() {
    try {
      return require("@whiskeysockets/baileys/package.json").version;
    } catch {
      return "unknown";
    }
  }

  function status() {
    const st = getState();
    const mem = process.memoryUsage();
    const chats = [...st.chats];
    const groups = chats.filter((c) => c.endsWith("@g.us")).length;
    return {
      connected: st.connection === "open",
      connection: st.connection || "idle",
      botName: config.botName,
      jid: st.sock?.user?.id || null,
      pushName: st.sock?.user?.name || config.botName,
      uptimeMs: st.startTime ? Date.now() - st.startTime : 0,
      uptimeText: st.startTime ? U.formatUptime(Date.now() - st.startTime) : "-",
      memoryMB: +(mem.rss / 1048576).toFixed(1),
      heapMB: +(mem.heapUsed / 1048576).toFixed(1),
      baileys: baileysVersion(),
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      counts: { chats: chats.length, groups, dms: chats.length - groups },
      owners: config.owner || [],
      runtime: {
        autoReply: !!st.runtime?.autoReply,
        readMessages: !!st.runtime?.readMessages,
        autoApprove: !!st.runtime?.autoApprove,
        stickerQuality: st.runtime?.stickerQuality ?? config.stickerQuality,
        warnThreshold: st.runtime?.warnThreshold ?? config.warnThreshold,
        rejectCalls: !!config.rejectCalls,
        markOnline: !!config.markOnline,
      },
      apiPort: port,
      serverTime: Date.now(),
    };
  }

  /* ------------------------------------------------------------------ *
   * Message observer
   * ------------------------------------------------------------------ */

  function mediaKind(msg) {
    const m = msg.message;
    if (!m) return null;
    if (m.imageMessage) return "image";
    if (m.videoMessage) return "video";
    if (m.stickerMessage) return "sticker";
    if (m.audioMessage) return "audio";
    if (m.documentMessage) return "document";
    if (m.locationMessage) return "location";
    if (m.contactMessage) return "contact";
    if (m.interactiveResponseMessage || m.buttonsResponseMessage || m.listResponseMessage) return "button";
    return null;
  }

  function onMessage(sock, msg) {
    const jid = msg.key?.remoteJid;
    if (!jid || jid === "status@broadcast") return;

    const text = U.getText(msg);
    const kind = mediaKind(msg);
    const fromMe = !!msg.key.fromMe;
    const isGroup = jid.endsWith("@g.us");
    const pushName = msg.pushName || msg.verifiedBizName || null;
    const secTs = Number(msg.messageTimestamp || msg.message?.messageTimestamp || 0);
    const parsed = text ? U.parseCommand(text, config.prefixes) : null;

    const entry = {
      id: msg.key.id || crypto.randomBytes(6).toString("hex"),
      jid,
      fromMe,
      isGroup,
      participant: msg.key.participant || null,
      pushName,
      text: text || "",
      kind,
      ts: secTs > 1e12 ? secTs : secTs > 0 ? secTs * 1000 : Date.now(),
      isCommand: !!parsed,
      command: parsed ? parsed.command : null,
    };

    if (pushName && !jid.endsWith("@g.us")) {
      const chat = ensureChat(jid, false);
      chat.name = pushName;
    }

    const chat = ensureChat(jid, isGroup);
    chat.last = entry;
    chat.ts = entry.ts;
    if (!fromMe) chat.unread = (chat.unread || 0) + 1;
    groupCache.delete(jid);

    const history = msgHistory.get(jid) || [];
    history.push(entry);
    if (history.length > MAX_MSG_PER_CHAT) history.splice(0, history.length - MAX_MSG_PER_CHAT);
    msgHistory.set(jid, history);

    emit("message", entry);
    emit("chat", chatRow(chat));
  }

  function ensureChat(jid, isGroup) {
    let chat = chatCache.get(jid);
    if (!chat) {
      chat = {
        jid,
        name: jid.replace(/@.*$/, "").replace(/[^0-9a-zA-Z]/g, "").slice(0, 18) || jid,
        isGroup: isGroup ?? jid.endsWith("@g.us"),
        unread: 0,
        ts: 0,
        last: null,
      };
      chatCache.set(jid, chat);
    }
    return chat;
  }

  function chatRow(chat) {
    return {
      jid: chat.jid,
      name: chat.name,
      isGroup: chat.isGroup,
      unread: chat.unread || 0,
      ts: chat.ts || 0,
      last: chat.last
        ? {
            id: chat.last.id,
            text: chat.last.text,
            kind: chat.last.kind,
            fromMe: chat.last.fromMe,
            isCommand: chat.last.isCommand,
            command: chat.last.command,
            ts: chat.last.ts,
          }
        : null,
    };
  }

  function listChats() {
    const st = getState();
    for (const jid of st.chats) ensureChat(jid);
    return [...chatCache.values()]
      .map(chatRow)
      .sort((a, b) => b.ts - a.ts);
  }

  /* ------------------------------------------------------------------ *
   * Groups
   * ------------------------------------------------------------------ */

  async function groupRow(sock, jid, { withMembers = false } = {}) {
    const meta = await sock.groupMetadata(jid).catch(() => null);
    const welcomes = store.kvGet("welcomes", {});
    const antilinks = store.kvGet("antilinks", {});
    if (!meta) {
      return {
        jid,
        name: jid,
        subject: jid,
        participantCount: 0,
        admins: [],
        isAnnounce: false,
        isRestrict: false,
        ephemeral: 0,
        approvalMode: false,
        welcome: welcomes[jid] || "",
        antilink: !!antilinks[jid],
        desc: "",
        createdAt: 0,
        error: "metadata gagal diambil",
      };
    }
    const participants = meta.participants || [];
    const row = {
      jid,
      name: meta.subject || jid,
      subject: meta.subject || "",
      desc: meta.desc || meta.descId ? meta.desc || "" : meta.desc || "",
      participantCount: participants.length,
      admins: participants
        .filter((p) => p.admin === "admin" || p.admin === "superadmin")
        .map((p) => ({ jid: p.id, admin: p.admin })),
      isAnnounce: !!meta.isAnnounce,
      isRestrict: !!meta.restrict,
      ephemeral: meta.ephemeral || 0,
      approvalMode: !!meta.approvalMode,
      welcome: welcomes[jid] || "",
      antilink: !!antilinks[jid],
      owner: meta.owner || null,
      createdAt: meta.creation ? Number(meta.creation) * 1000 : 0,
    };
    if (withMembers) {
      row.members = participants.map((p) => {
        const num = p.id.replace(/@.*$/, "");
        return {
          jid: p.id,
          number: num,
          name: chatCache.get(p.id)?.name || num,
          admin: p.admin || null,
          isBot: !!p.isBot,
          isMe: false,
        };
      });
    }
    return row;
  }

  async function listGroups(sock, { withMembers = false } = {}) {
    const st = getState();
    const jids = [...st.chats].filter((c) => c.endsWith("@g.us"));
    const out = [];
    for (const jid of jids) {
      const cached = groupCache.get(jid);
      if (cached && Date.now() - cached.ts < GROUP_CACHE_MS) {
        out.push(withMembers ? await groupRow(sock, jid, { withMembers }) : cached.data);
        continue;
      }
      const data = await groupRow(sock, jid);
      groupCache.set(jid, { ts: Date.now(), data });
      out.push(withMembers ? { ...data, members: (await groupRow(sock, jid, { withMembers })).members } : data);
    }
    return out.sort((a, b) => b.participantCount - a.participantCount);
  }

  /* ------------------------------------------------------------------ *
   * Store / broadcast / channel
   * ------------------------------------------------------------------ */

  async function runBroadcast(sock, text, targets) {
    const st = getState();
    const ownerJids = (config.owner || []).map((n) => `${n}@s.whatsapp.net`);
    let list = [...st.chats].filter((c) => c.endsWith("@s.whatsapp.net") && !ownerJids.includes(c));
    if (targets.target === "groups") list = [...st.chats].filter((c) => c.endsWith("@g.us"));
    if (Array.isArray(targets.jids) && targets.jids.length) list = targets.jids;
    if (targets.target === "all") list = [...st.chats].filter((c) => !ownerJids.includes(c));

    const job = {
      id: crypto.randomBytes(6).toString("hex"),
      startedAt: Date.now(),
      total: list.length,
      sent: 0,
      failed: 0,
      running: true,
      text,
      target: targets.target || "contacts",
    };
    emit("broadcast", job);

    for (const jid of list) {
      if (!job.running) break;
      try {
        await sock.sendMessage(jid, { text });
        job.sent += 1;
      } catch (e) {
        job.failed += 1;
        pushLog("error", [`[broadcast] ${jid}: ${e.message}`]);
      }
      emit("broadcast", job);
      await new Promise((r) => setTimeout(r, config.broadcastDelayMs || 300));
    }
    job.running = false;
    job.finishedAt = Date.now();
    emit("broadcast", job);

    const history = store.kvGet("broadcastHistory", []);
    history.unshift({
      id: job.id,
      text,
      target: job.target,
      total: job.total,
      sent: job.sent,
      failed: job.failed,
      at: job.startedAt,
    });
    store.kvSet("broadcastHistory", history.slice(0, 20));
    return job;
  }

  async function channelRows(sock) {
    const channels = store.kvGet("channels", {});
    const names = Object.keys(channels);
    const rows = [];
    for (const name of names) {
      const ch = channels[name];
      const row = { name, jid: ch.jid, invite: ch.invite || "", subscribers: null, subs: null };
      try {
        const meta = await sock.newsletterMetadata("jid", ch.jid);
        row.name = meta.name || name;
        row.subscribers = meta.subscribers ?? null;
        row.description = meta.description || "";
        row.invite = meta.invite || row.invite;
      } catch {
        row.description = "";
      }
      rows.push(row);
    }
    let subscribed = [];
    if (typeof sock.newsletterFetchSubscribed === "function") {
      try {
        const raw = await sock.newsletterFetchSubscribed();
        const list = Array.isArray(raw) ? raw : raw?.subscribed || [];
        subscribed = list.slice(0, 30).map((x) => ({ jid: x.jid || x.id, name: x.name || x.jid || x.id }));
      } catch {
        subscribed = [];
      }
    }
    return { channels: rows, subscribed };
  }

  /* ------------------------------------------------------------------ *
   * Router
   * ------------------------------------------------------------------ */

  const routes = [];
  const route = (method, pattern, handler) =>
    routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          reject(new Error("body terlalu besar"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("body bukan JSON valid"));
        }
      });
      req.on("error", reject);
    });
  }

  const ok = (res, data) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...data }));
  };
  const fail = (res, code, message) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: message }));
  };

  const sock = () => {
    const s = attachedSock || getState().sock;
    if (!s) throw new Error("Socket bot belum siap. Jalankan bot dulu lalu coba lagi.");
    return s;
  };

  /* ---- health / connect / events ---- */

  route("GET", "/api/health", ({ res }) => ok(res, { status: status() }));

  route("GET", "/api/connect", ({ res }) => {
    const lan = lanAddresses();
    const host = lan[0]?.address || "127.0.0.1";
    ok(res, {
      token,
      port,
      host,
      hosts: ["127.0.0.1", ...lan.map((l) => l.address)],
      url: `http://${host}:${port}`,
      deepLink: `botmansx://connect?h=${encodeURIComponent(host)}&p=${port}&t=${token}`,
      note: "Buka di HP dengan jaringan yang sama, atau pakai adb reverse untuk localhost.",
    });
  });

  route("GET", "/api/events", ({ req, res }) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    res.write(`event: backlog\ndata: ${JSON.stringify({ logs: logs.slice(-200) })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  /* ---- command & toggle ---- */

  route("POST", "/api/command", async ({ res, body }) => {
    const { jid, text } = body;
    if (!jid || !text) return fail(res, 400, "jid dan text wajib diisi");
    await sock().sendMessage(jid, { text: String(text) });
    ok(res, { sent: true });
  });

  route("POST", "/api/toggle", async ({ res, body }) => {
    const { key, value } = body;
    const st = getState();
    const runtimeKeys = ["autoReply", "readMessages", "autoApprove"];
    const numericKeys = { stickerQuality: [10, 100], warnThreshold: [1, 99] };
    if (runtimeKeys.includes(key)) {
      st.runtime[key] = !!value;
    } else if (numericKeys[key]) {
      const n = Number(value);
      const [min, max] = numericKeys[key];
      if (!Number.isFinite(n) || n < min || n > max) return fail(res, 400, `${key} harus antara ${min}-${max}`);
      st.runtime[key] = n;
    } else if (key === "rejectCalls" || key === "markOnline") {
      config[key] = !!value;
      persistConfig(rootDir, config);
    } else {
      return fail(res, 400, `key tidak dikenal: ${key}`);
    }
    emit("status", status());
    ok(res, { status: status() });
  });

  /* ---- chats ---- */

  route("GET", "/api/chats", ({ res, query }) => {
    const filter = query.get("filter") || "all";
    const q = (query.get("q") || "").toLowerCase();
    let rows = listChats();
    if (filter === "group") rows = rows.filter((r) => r.isGroup);
    if (filter === "dm") rows = rows.filter((r) => !r.isGroup);
    if (filter === "in") rows = rows.filter((r) => r.last && !r.last.fromMe);
    if (filter === "out") rows = rows.filter((r) => r.last && r.last.fromMe);
    if (filter === "command") rows = rows.filter((r) => r.last && r.last.isCommand);
    if (filter === "unread") rows = rows.filter((r) => r.unread > 0);
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.jid.includes(q));
    ok(res, { chats: rows.slice(0, 200), total: rows.length });
  });

  route("GET", "/api/chats/:jid/messages", ({ res, params, query }) => {
    const limit = Math.min(Number(query.get("limit") || 30), MAX_MSG_PER_CHAT);
    const chat = chatCache.get(params.jid);
    if (chat) chat.unread = 0;
    ok(res, { jid: params.jid, messages: (msgHistory.get(params.jid) || []).slice(-limit) });
  });

  route("POST", "/api/chats/:jid/send", async ({ res, params, body }) => {
    if (!body.text) return fail(res, 400, "text wajib diisi");
    await sock().sendMessage(params.jid, { text: String(body.text) });
    ok(res, { sent: true });
  });

  route("POST", "/api/chats/:jid/read", ({ res, params }) => {
    const chat = chatCache.get(params.jid);
    if (chat) chat.unread = 0;
    ok(res, { unread: 0 });
  });

  route("DELETE", "/api/chats/:jid", ({ res, params }) => {
    chatCache.delete(params.jid);
    msgHistory.delete(params.jid);
    getState().chats.delete(params.jid);
    groupCache.delete(params.jid);
    emit("chat", { jid: params.jid, removed: true });
    ok(res, { removed: true });
  });

  /* ---- groups ---- */

  route("GET", "/api/groups", async ({ res, query }) => {
    ok(res, { groups: await listGroups(sock(), { withMembers: query.get("members") === "1" }) });
  });

  route("GET", "/api/groups/:jid", async ({ res, params }) => {
    const data = await groupRow(sock(), params.jid, { withMembers: true });
    if (data.error) return fail(res, 404, data.error);
    ok(res, { group: data });
  });

  route("GET", "/api/groups/:jid/joinrequests", async ({ res, params }) => {
    const raw = await sock().groupRequestParticipantsList(params.jid);
    const list = Array.isArray(raw) ? raw : raw?.participants || [];
    ok(res, {
      requests: list.map((x) => {
        const jid = typeof x === "string" ? x : x.id || x.jid;
        const num = jid.replace(/@.*$/, "");
        return { jid, number: num, name: chatCache.get(jid)?.name || num, requestedAt: 0 };
      }),
    });
  });

  route("POST", "/api/groups/:jid/joinrequests", async ({ res, params, body }) => {
    const targets = (body.targets || []).map((n) => `${String(n).replace(/@.*$/, "")}@s.whatsapp.net`);
    if (!targets.length) return fail(res, 400, "targets wajib diisi");
    const s = sock();
    if (body.action === "approve") await s.groupApproveRequest(params.jid, targets);
    else if (body.action === "reject") await s.groupRejectRequest(params.jid, targets);
    else return fail(res, 400, "action harus approve atau reject");
    groupCache.delete(params.jid);
    emit("group", { jid: params.jid, dirty: true });
    ok(res, { done: targets.length });
  });

  route("POST", "/api/groups/:jid/action", async ({ res, params, body }) => {
    const s = sock();
    const jid = params.jid;
    const targets = (body.targets || []).map((n) => `${String(n).replace(/@.*$/, "")}@s.whatsapp.net`);
    const action = body.action;
    let result = null;

    switch (action) {
      case "tagall": {
        const meta = await s.groupMetadata(jid);
        const mentions = (meta.participants || []).map((p) => p.id);
        await s.sendMessage(jid, { text: body.text || "@all", mentions });
        result = { tagged: mentions.length };
        break;
      }
      case "kick":
        await s.groupParticipantsUpdate(jid, targets, "remove");
        result = { kicked: targets.length };
        break;
      case "add":
        await s.groupParticipantsUpdate(jid, targets, "add");
        result = { added: targets.length };
        break;
      case "promote":
        await s.groupParticipantsUpdate(jid, targets, "promote");
        result = { promoted: targets.length };
        break;
      case "demote":
        await s.groupParticipantsUpdate(jid, targets, "demote");
        result = { demoted: targets.length };
        break;
      case "leave":
        await s.groupLeave(jid);
        result = { left: true };
        break;
      case "invitelink":
        result = { code: await s.groupInviteCode(jid) };
        break;
      case "resetlink":
        result = { code: await s.groupRevokeInvite(jid) };
        break;
      case "lockchat":
        await s.groupSettingUpdate(jid, "announcement");
        result = { isAnnounce: true };
        break;
      case "unlockchat":
        await s.groupSettingUpdate(jid, "not_announcement");
        result = { isAnnounce: false };
        break;
      case "locktopik":
        await s.groupSettingUpdate(jid, "locked");
        result = { isRestrict: true };
        break;
      case "unlocktopik":
        await s.groupSettingUpdate(jid, "unlocked");
        result = { isRestrict: false };
        break;
      case "approvemode":
        await s.groupJoinApprovalMode(jid, body.value ? "on" : "off");
        result = { approvalMode: !!body.value };
        break;
      case "ephem": {
        const key = String(body.value ?? "off").toLowerCase();
        if (!(key in EPHEM)) return fail(res, 400, "value harus off/1/7/30");
        await s.groupToggleEphemeral(jid, EPHEM[key]);
        result = { ephemeral: EPHEM[key] };
        break;
      }
      case "namagrup":
        await s.groupUpdateSubject(jid, String(body.value || ""));
        result = { subject: body.value };
        break;
      case "descgrup":
        await s.groupUpdateDescription(jid, String(body.value || ""));
        result = { desc: body.value };
        break;
      case "setwelcome": {
        const welcomes = store.kvGet("welcomes", {});
        welcomes[jid] = String(body.value || "");
        store.kvSet("welcomes", welcomes);
        result = { welcome: welcomes[jid] };
        break;
      }
      case "antilink": {
        const antilinks = store.kvGet("antilinks", {});
        antilinks[jid] = !!body.value;
        store.kvSet("antilinks", antilinks);
        result = { antilink: !!body.value };
        break;
      }
      default:
        return fail(res, 400, `action tidak dikenal: ${action}`);
    }

    groupCache.delete(jid);
    const data = await groupRow(s, jid).catch(() => null);
    emit("group", { jid, dirty: true, group: data });
    ok(res, { result, group: data });
  });

  /* ---- settings ---- */

  route("GET", "/api/settings", async ({ res }) => {
    let privacy = null;
    try {
      const cur = await sock().fetchPrivacySettings(true);
      privacy = cur.privacy || cur;
    } catch {
      privacy = null;
    }
    ok(res, {
      settings: {
        botName: config.botName,
        botFooter: config.botFooter,
        owner: config.owner,
        prefixes: config.prefixes,
        cooldownMs: config.cooldownMs,
        warnThreshold: getState().runtime.warnThreshold,
        stickerQuality: getState().runtime.stickerQuality,
        greetings: config.greetings,
        broadcastDelayMs: config.broadcastDelayMs,
        markOnline: config.markOnline,
        rejectCalls: config.rejectCalls,
        privacy,
      },
      runtime: status().runtime,
      welcomeGroups: Object.keys(store.kvGet("welcomes", {})).length,
      antilinkGroups: Object.values(store.kvGet("antilinks", {})).filter(Boolean).length,
    });
  });

  route("POST", "/api/settings", async ({ res, body }) => {
    const st = getState();
    const persisted = ["botName", "botFooter", "owner", "prefixes", "cooldownMs", "greetings", "broadcastDelayMs", "markOnline", "rejectCalls"];
    const runtimeKeys = ["autoReply", "readMessages", "autoApprove", "warnThreshold", "stickerQuality"];
    const applied = [];

    for (const key of persisted) {
      if (body[key] === undefined) continue;
      config[key] = body[key];
      applied.push(key);
    }
    for (const key of runtimeKeys) {
      if (body[key] === undefined) continue;
      st.runtime[key] = body[key];
      applied.push(key);
    }
    if (applied.includes("prefixes") && (!Array.isArray(config.prefixes) || !config.prefixes.length)) {
      config.prefixes = ["!"];
    }
    persistConfig(rootDir, config);

    if (body.privacy) {
      const s = sock();
      const setters = {
        last: (v) => s.updateLastSeenPrivacy(v),
        online: (v) => s.updateOnlinePrivacy(v),
        profile: (v) => s.updateProfilePicturePrivacy(v),
        status: (v) => s.updateStatusPrivacy(v),
        readreceipts: (v) => s.updateReadReceiptsPrivacy(v),
        groupadd: (v) => s.updateGroupsAddPrivacy(v),
        call: (v) => s.updateCallPrivacy(v),
      };
      for (const [key, value] of Object.entries(body.privacy)) {
        if (setters[key]) {
          await setters[key](value).catch((e) => pushLog("error", [`[privacy ${key}] ${e.message}`]));
          applied.push(`privacy.${key}`);
        }
      }
    }
    if (body.profile) {
      const s = sock();
      if (body.profile.name) {
        await s.updateProfileName(String(body.profile.name)).catch((e) => pushLog("error", [e.message]));
        applied.push("profile.name");
      }
      if (body.profile.bio) {
        await s.updateProfileStatus(String(body.profile.bio)).catch((e) => pushLog("error", [e.message]));
        applied.push("profile.bio");
      }
    }
    if (body.ephemeralDefault !== undefined) {
      const key = String(body.ephemeralDefault).toLowerCase();
      if (key in EPHEM) {
        await sock().updateDefaultDisappearingMode(EPHEM[key]).catch(() => {});
        applied.push("ephemeralDefault");
      }
    }

    emit("status", status());
    ok(res, { applied });
  });

  /* ---- store ---- */

  route("GET", "/api/store/products", ({ res }) => ok(res, { products: store.productsAll() }));

  route("POST", "/api/store/products", ({ res, body }) => {
    const id = String(body.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!id) return fail(res, 400, "id produk wajib diisi (huruf kecil, angka, - dan _)");
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) return fail(res, 400, "price harus angka >= 0");
    store.productAdd({ id, name: String(body.name || id), price: Math.round(price), desc: String(body.desc || "") });
    const products = store.productsAll();
    emit("store", { products });
    ok(res, { products });
  });

  route("DELETE", "/api/store/products", ({ res, query, body }) => {
    const id = query.get("id") || body.id;
    if (!id) return fail(res, 400, "id wajib diisi");
    const changed = store.productDel(String(id));
    const products = store.productsAll();
    emit("store", { products });
    ok(res, { deleted: changed });
  });

  /* ponytail: keranjang/pesanan belum dipisah di store.js (carts di memory features.js).
     Kalau butuh riwayat transaksi, tambah tabel `orders` di store.js dulu. */

  /* ---- broadcast ---- */

  route("GET", "/api/broadcast/history", ({ res }) =>
    ok(res, { history: store.kvGet("broadcastHistory", []) })
  );

  route("POST", "/api/broadcast", async ({ res, body }) => {
    const text = String(body.text || "").trim();
    if (!text) return fail(res, 400, "isi broadcast wajib diisi");
    const target = body.target || "contacts";
    const jids = (body.jids || []).map((j) => (String(j).includes("@") ? String(j) : `${j}@s.whatsapp.net`));
    const job = await runBroadcast(sock(), text, { target, jids });
    ok(res, { job });
  });

  /* ---- channels ---- */

  route("GET", "/api/channels", async ({ res }) => ok(res, await channelRows(sock())));

  route("POST", "/api/channels", async ({ res, body }) => {
    const s = sock();
    const action = body.action;
    if (action === "create") {
      const name = String(body.name || "").trim();
      if (!name) return fail(res, 400, "nama channel wajib diisi");
      const meta = await s.newsletterCreate(name, String(body.description || ""));
      const channels = store.kvGet("channels", {});
      channels[name.toLowerCase()] = { jid: meta.id, invite: meta.invite || "" };
      store.kvSet("channels", channels);
      emit("channel", { name: name.toLowerCase() });
      return ok(res, { jid: meta.id, invite: meta.invite || "" });
    }
    if (action === "post") {
      const key = String(body.name || body.jid || "").toLowerCase();
      const channels = store.kvGet("channels", {});
      const target = channels[key]?.jid || (String(key).includes("@newsletter") ? key : null);
      if (!target) return fail(res, 400, "channel tidak dikenal, buat dulu di app");
      await s.sendMessage(target, { text: String(body.text || "") });
      return ok(res, { posted: true });
    }
    if (action === "follow" || action === "unfollow") {
      const code = String(body.invite || body.jid || "");
      if (!code) return fail(res, 400, "invite link atau jid wajib diisi");
      const meta = await s.newsletterMetadata(code.includes("@") ? "jid" : "invite", code);
      if (action === "follow") await s.newsletterFollow(meta.id);
      else await s.newsletterUnfollow(meta.id);
      emit("channel", { action, jid: meta.id });
      return ok(res, { jid: meta.id, name: meta.name || "" });
    }
    if (action === "info") {
      const key = String(body.jid || body.name || "");
      const channels = store.kvGet("channels", {});
      const jid = key.includes("@") ? key : channels[key.toLowerCase()]?.jid;
      if (!jid) return fail(res, 400, "channel tidak dikenal");
      const meta = await s.newsletterMetadata("jid", jid);
      return ok(res, { channel: meta });
    }
    return fail(res, 400, `action tidak dikenal: ${action}`);
  });

  /* ---- logs ---- */

  route("GET", "/api/logs", ({ res, query }) => {
    const since = Number(query.get("since") || 0);
    const level = query.get("level");
    let rows = since ? logs.filter((l) => l.id > since) : logs;
    if (level && level !== "all") rows = rows.filter((l) => l.level === level);
    ok(res, { logs: rows.slice(-500), lastId: logSeq });
  });

  /* ---- session ---- */

  route("POST", "/api/session/pair", async ({ res, body }) => {
    const phone = String(body.phone || (config.owner || [])[0] || "").replace(/\D/g, "");
    if (!phone) return fail(res, 400, "nomor WhatsApp owner wajib diisi");
    try {
      const code = await sock().requestPairingCode(phone);
      ok(res, { code });
    } catch (e) {
      fail(res, 400, e.message);
    }
  });

  route("POST", "/api/session/logout", async ({ res, body }) => {
    if (!body.confirm) return fail(res, 400, "butuh confirm: true");
    try {
      await sock().logout();
      emit("status", status());
      ok(res, { loggedOut: true });
    } catch (e) {
      fail(res, 400, e.message);
    }
  });

  route("POST", "/api/session/reset", async ({ res, body }) => {
    if (!body.confirm) return fail(res, 400, "butuh confirm: true");
    const dir = path.resolve(rootDir, config.sessionDir || "./session");
    try {
      if (fs.existsSync(dir)) fs.renameSync(dir, `${dir}.bak-${Date.now()}`);
      ok(res, { reset: true, dir });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  route("POST", "/api/restart", ({ res, body }) => {
    if (!body.confirm) return fail(res, 400, "butuh confirm: true");
    ok(res, { restarting: true });
    setTimeout(() => process.exit(0), 150);
  });

  /* ------------------------------------------------------------------ *
   * HTTP server
   * ------------------------------------------------------------------ */

  // SELURUH body dibungkus try: request listener Node tidak menangkap throw
  // sinkron, jadi satu bug di auth/router membuat socket menggantung tanpa
  // respons (client nunggu sampai timeout) alih-alih dapat 500.
  const HTTP = (req, res) => {
   try {
    const url = new URL(req.url, "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    // CORS sengaja tidak diaktifkan: konsumennya app Android & curl, bukan browser.
    // Wildcard + allow-headers Authorization membuat website mana pun bisa
    // menembak API ini cross-origin begitu tahu token-nya.
    if (req.method === "OPTIONS") {
      res.writeHead(403);
      return res.end();
    }

    // Token HANYA lewat header. Query string ikut masuk access log proxy,
    // Referer, dan history browser — jangan pernah jadi jalur auth.
    const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!tokenMatch(provided, token)) {
      if (authLimiter.limited(failKey(req))) {
        return fail(res, 429, "terlalu banyak percobaan token. Tunggu 1 menit lalu coba lagi.");
      }
      authLimiter.fail(failKey(req));
      return fail(res, 401, "token tidak cocok. Cek di config.json atau output terminal bot.");
    }
    authLimiter.clear(failKey(req));

    let matched = null;
    let params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      if (r.parts.length !== segments.length) continue;
      const local = {};
      let okRoute = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(":")) local[p.slice(1)] = decodeURIComponent(segments[i]);
        else if (p !== segments[i]) {
          okRoute = false;
          break;
        }
      }
      if (okRoute) {
        matched = r;
        params = local;
        break;
      }
    }
    if (!matched) return fail(res, 404, `route tidak ditemukan: ${req.method} ${url.pathname}`);

    Promise.resolve()
      .then(() => readBody(req))
      .then((body) => matched.handler({ req, res, params, body, query: url.searchParams }))
      .catch((e) => {
        if (!res.headersSent) fail(res, 500, e.message || String(e));
        else res.end();
      });
   } catch (e) {
    console.error("HTTP handler crash:", e);
    if (!res.headersSent) fail(res, 500, e.message || String(e));
    else res.end();
   }
  };

  function printBanner() {
    const lan = lanAddresses();
    const host = lan[0]?.address || "127.0.0.1";
    const line = "─".repeat(58);
    console.log("");
    console.log(`┌${line}┐`);
    console.log(`│  BotMansx API siap${" ".repeat(38)}│`);
    console.log(`│  Port : ${port}${" ".repeat(50 - String(port).length)}│`);
    for (const l of lan) {
      console.log(`│  URL  : http://${l.address}:${port} (${l.iface})${" ".repeat(Math.max(0, 24 - l.address.length))}│`);
    }
    console.log(`│  Lokal: http://127.0.0.1:${port}${" ".repeat(Math.max(0, 27 - String(port).length))}│`);
    console.log(`│  Token: ${token}${" ".repeat(Math.max(0, 45 - token.length))}│`);
    console.log(`└${line}┘`);
    console.log("  Bot WhatsApp > Perangkat Tertaut > Tautkan Perangkat > Tautkan dengan nomor");
    console.log(`  Tempel di app : BOTMANSX http://${host}:${port}?t=${token}`);
    try {
      require("qrcode-terminal").generate(`botmansx://connect?h=${encodeURIComponent(host)}&p=${port}&t=${token}`, { small: true });
    } catch {
      /* qrcode opsional */
    }
    console.log("");
  }

  function start() {
    if (server) return server;
    patchConsole();
    server = http.createServer(HTTP);
    server.listen(port, host, printBanner);
    const heartbeat = setInterval(() => {
      for (const res of clients) {
        try {
          res.write(": ping\n\n");
        } catch {
          clients.delete(res);
        }
      }
    }, 20000);
    heartbeat.unref();
    return server;
  }

  function attachSock(s) {
    if (attachedSock === s) return;
    attachedSock = s;
    s.ev.on("messages.upsert", ({ messages, type }) => {
      if (type && type !== "notify") return;
      for (const m of messages) onMessage(s, m);
    });
    s.ev.on("group-participants.update", (u) => {
      groupCache.delete(u.id);
      emit("group", { jid: u.id, dirty: true, reason: "participants" });
    });
    s.ev.on("group.join-request", (u) => {
      groupCache.delete(u.id);
      emit("group", { jid: u.id, dirty: true, reason: "join-request" });
    });
    s.ev.on("creds.update", () => emit("status", status()));
  }

  return { start, attachSock, emit, status, token, port };
}

function persistConfig(rootDir, config) {
  try {
    const file = path.join(rootDir, "config.json");
    const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    for (const key of [
      "botName",
      "botFooter",
      "owner",
      "prefixes",
      "cooldownMs",
      "greetings",
      "broadcastDelayMs",
      "markOnline",
      "rejectCalls",
      "token",
      "apiPort",
      "apiHost",
    ]) {
      if (config[key] !== undefined) raw[key] = config[key];
    }
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  } catch (e) {
    console.warn("⚠️ Gagal menyimpan config:", e.message);
  }
}

module.exports = { createApi, tokenMatch, createRateLimiter };
