const { USyncQuery, USyncUser, proto } = require("@whiskeysockets/baileys");
const { randomBytes } = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");
const {
  loadJSON,
  saveJSON,
  normJid,
  sameUser,
  formatRupiah,
  quotedMedia,
  makeImageSticker,
  makeVideoSticker,
  downloadWithYtDlp,
  buildOrderText,
  relayContent,
  sendNativeButtons,
  sendCarouselCards,
  downloadMedia,
} = require("./utils");

async function isGroupAdmin(sock, groupId, participant) {
  try {
    const meta = await sock.groupMetadata(groupId);
    if (!meta || !meta.participants) return false;
    const p = meta.participants.find((x) => sameUser(x.id, participant));
    return !!p && !!(p.admin === "admin" || p.admin === "superadmin");
  } catch {
    return false;
  }
}

function initFeatures({ register, reply, getJid, isOwner, OWNER_NUMBER, config }) {
  const products = loadJSON("products.json", [
    { id: "burger", name: "🍔 Burger", price: 25000, desc: "Daging sapi + keju" },
    { id: "pizza", name: "🍕 Pizza", price: 45000, desc: "Ukuran medium" },
    { id: "taco", name: "🌮 Taco", price: 20000, desc: "Khas Meksiko" },
    { id: "esteh", name: "🥤 Es Teh", price: 5000, desc: "Teh manis dingin" },
    { id: "kopi", name: "☕ Kopi", price: 10000, desc: "Kopi susu gula aren" },
  ]);
  const carts = new Map();
  const welcomes = loadJSON("welcome.json", {});
  const antilinks = loadJSON("antilink.json", {});
  const channels = loadJSON("channels.json", {});

  const onMessage = [];
  const onGroupParticipantsUpdate = [];
  const onGroupJoinRequest = [];

  async function requireAdmin(sock, jid, msg) {
    return isGroupAdmin(sock, jid, msg.key.participant || jid);
  }

  register("catalog", {
    aliases: ["produk", "shop", "store"],
    handler: async ({ sock, jid, msg }) => {
      if (!products.length) {
        return reply(sock, jid, "📭 Belum ada produk. Owner bisa tambah via *!jual nama|harga|desk*", msg);
      }
      const list = products
        .map((p, i) => `${i + 1}. ${p.name} — ${formatRupiah(p.price)}\n   ${p.desc || ""}`)
        .join("\n");
      await reply(
        sock,
        jid,
        "🛍️ *KATALOG PRODUK*\n\n" +
          list +
          "\n\nKetik *!beli <nama produk>* untuk menambahkan ke keranjang.",
        msg
      );
    },
  });

  register("beli", {
    aliases: ["buy", "addcart", "tambah"],
    handler: async ({ sock, jid, args, msg }) => {
      const q = args.join(" ").toLowerCase().trim();
      const product = products.find((p) => p.id === q || p.name.toLowerCase().includes(q));
      if (!product) return reply(sock, jid, "❌ Produk tidak ditemukan. Ketik *!catalog*", msg);
      const cart = carts.get(jid) || [];
      const existing = cart.find((it) => it.id === product.id);
      if (existing) existing.qty += 1;
      else cart.push({ id: product.id, name: product.name, price: product.price, qty: 1 });
      carts.set(jid, cart);
      reply(sock, jid, `✅ ${product.name} masuk keranjang (x${existing ? existing.qty : 1}).\nKetik *!keranjang* untuk cek.`, msg);
    },
  });

  register("keranjang", {
    aliases: ["cart", "cartq"],
    handler: async ({ sock, jid, msg }) => {
      const cart = carts.get(jid) || [];
      if (!cart.length) return reply(sock, jid, "🛒 Keranjang kosong. Ketik *!catalog*", msg);
      const total = cart.reduce((s, it) => s + it.price * it.qty, 0);
      reply(sock, jid, buildOrderText(cart, total) + "\n\nKetik *!checkout* untuk pesan.", msg);
    },
  });

  register("checkout", {
    aliases: ["order", "pesan"],
    handler: async ({ sock, jid, msg }) => {
      const cart = carts.get(jid) || [];
      if (!cart.length) return reply(sock, jid, "🛒 Keranjang kosong. Ketik *!catalog*", msg);
      const total = cart.reduce((s, it) => s + it.price * it.qty, 0);
      const nota = buildOrderText(cart, total) + `\n\n👤 Pembeli: ${jid}`;
      await sock.sendMessage(getJid(OWNER_NUMBER), { text: "🛍️ *PESANAN BARU*\n\n" + nota });
      carts.delete(jid);
      reply(sock, jid, `✅ *Checkout berhasil!*\n\n${buildOrderText(cart, total)}\n\nPesanan dikirim ke owner. Terima kasih! 🎉`, msg);
    },
  });

  register("jual", {
    aliases: ["addproduct", "tambahproduk"],
    ownerOnly: true,
    handler: async ({ sock, jid, text, msg }) => {
      const body = text.replace(/^!\s*jual\s*/i, "").trim();
      const parts = body.split("|").map((s) => s.trim());
      if (parts.length < 3) return reply(sock, jid, "Cara pakai: *!jual nama|harga|deskripsi*", msg);
      const price = Number(parts[1].replace(/[^0-9]/g, ""));
      if (!price) return reply(sock, jid, "Harga harus angka. *!jual nama|harga|desk*", msg);
      const id = parts[0].toLowerCase().replace(/\s+/g, "-");
      products.push({ id, name: parts[0], price, desc: parts[2] });
      saveJSON("products.json", products);
      reply(sock, jid, `✅ Produk *${parts[0]}* ditambahkan (${formatRupiah(price)}).`, msg);
    },
  });

  register("hapusproduk", {
    aliases: ["delproduct"],
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      const q = args.join(" ").toLowerCase().trim();
      const idx = products.findIndex((p) => p.id === q || p.name.toLowerCase().includes(q));
      if (idx < 0) return reply(sock, jid, "❌ Produk tidak ditemukan.", msg);
      const [removed] = products.splice(idx, 1);
      saveJSON("products.json", products);
      reply(sock, jid, `🗑️ Produk *${removed.name}* dihapus.`, msg);
    },
  });

  register("sticker", {
    aliases: ["stiker", "s"],
    handler: async ({ sock, jid, msg }) => {
      const m = msg.message;
      let target = null;
      if (m.imageMessage || m.videoMessage) target = msg;
      else target = quotedMedia(msg);
      if (!target) {
        return reply(sock, jid, "Kirim/reply gambar atau video dengan caption *!sticker*.", msg);
      }
      const content = target.message;
      const isVideo = !!(content.videoMessage || content.animatedMessage);
      const isImage = !!content.imageMessage;
      if (!isVideo && !isImage) {
        return reply(sock, jid, "Hanya bisa dari *gambar* atau *video*.", msg);
      }
      reply(sock, jid, "⏳ Membuat stiker...", msg).catch(() => {});
      try {
        const media = await downloadMedia(target);
        if (isImage) {
          const buf = await makeImageSticker(media, config?.stickerQuality);
          await sock.sendMessage(jid, { sticker: buf }, { quoted: msg });
        } else {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wabot-stk-"));
          const input = path.join(tmp, "in" + (content.videoMessage ? ".mp4" : ".mp4"));
          const output = path.join(tmp, "out.webp");
          fs.writeFileSync(input, media);
          const buf = await makeVideoSticker(input, output);
          await sock.sendMessage(jid, { sticker: buf }, { quoted: msg });
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      } catch (e) {
        console.error("Sticker error:", e.message);
        reply(sock, jid, `⚠️ Gagal membuat stiker: ${e.message}`, msg).catch(() => {});
      }
    },
  });

  register("yt", {
    aliases: ["ytmp4"],
    handler: async ({ sock, jid, args, msg }) => {
      const url = args[0];
      if (!url || !/^https?:\/\//.test(url)) return reply(sock, jid, "Cara pakai: *!yt <link YouTube>*", msg);
      reply(sock, jid, "⏳ Mengunduh video...", msg).catch(() => {});
      try {
        const { filePath, tmpDir } = await downloadWithYtDlp(url, [
          "-f", "best[height<=720]/best[ext=mp4]/best",
        ], config?.maxDownloadMb);
        await sock.sendMessage(jid, { video: { url: filePath }, caption: "🎬 *Video berhasil diunduh*" }, { quoted: msg });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal mengunduh: ${e.message}`, msg).catch(() => {});
      }
    },
  });

  register("yta", {
    aliases: ["ytmp3"],
    handler: async ({ sock, jid, args, msg }) => {
      const url = args[0];
      if (!url || !/^https?:\/\//.test(url)) return reply(sock, jid, "Cara pakai: *!yta <link YouTube>*", msg);
      reply(sock, jid, "⏳ Mengunduh audio...", msg).catch(() => {});
      try {
        const { filePath, tmpDir } = await downloadWithYtDlp(url, [
          "-x", "--audio-format", "mp3", "--audio-quality", "0",
        ], config?.maxDownloadMb);
        await sock.sendMessage(jid, { audio: { url: filePath }, mimetype: "audio/mpeg", fileName: path.basename(filePath) }, { quoted: msg });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal mengunduh: ${e.message}`, msg).catch(() => {});
      }
    },
  });

  register("dl", {
    aliases: ["download", "media"],
    handler: async ({ sock, jid, args, msg }) => {
      const url = args[0];
      if (!url || !/^https?:\/\//.test(url)) return reply(sock, jid, "Cara pakai: *!dl <link TikTok/IG/dll>*", msg);
      reply(sock, jid, "⏳ Mengunduh media...", msg).catch(() => {});
      try {
        const { filePath, tmpDir } = await downloadWithYtDlp(url, ["-f", "best[ext=mp4]/best"], config?.maxDownloadMb);
        const lower = filePath.toLowerCase();
        if (lower.endsWith(".mp3") || lower.endsWith(".m4a") || lower.endsWith(".ogg")) {
          await sock.sendMessage(jid, { audio: { url: filePath }, mimetype: "audio/mpeg" }, { quoted: msg });
        } else {
          await sock.sendMessage(jid, { video: { url: filePath }, caption: "🎬 *Media berhasil diunduh*" }, { quoted: msg });
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal mengunduh: ${e.message}`, msg).catch(() => {});
      }
    },
  });

  register("setwelcome", {
    aliases: ["set-welcome", "welcome-set"],
    handler: async ({ sock, jid, isGroup, text, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await isGroupAdmin(sock, jid, msg.key.participant || jid))) {
        return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      }
      const w = text.replace(/^!\s*setwelcome\s*/i, "").trim();
      if (!w) return reply(sock, jid, "Cara pakai: *!setwelcome <teks>*\nGunakan *@* untuk tag anggota baru.", msg);
      welcomes[jid] = w;
      saveJSON("welcome.json", welcomes);
      reply(sock, jid, "✅ Pesan sambutan diperbarui.", msg);
    },
  });

  register("welcome", {
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      reply(sock, jid, welcomes[jid] || "Belum ada pesan sambutan khusus.", msg);
    },
  });

  register("antilink", {
    handler: async ({ sock, jid, isGroup, args, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await isGroupAdmin(sock, jid, msg.key.participant || jid))) {
        return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      }
      const mode = (args[0] || "").toLowerCase();
      if (!["on", "off"].includes(mode)) return reply(sock, jid, "Cara pakai: *!antilink on/off*", msg);
      antilinks[jid] = mode === "on";
      saveJSON("antilink.json", antilinks);
      reply(sock, jid, `🔗 Anti-link: ${mode === "on" ? "AKTIF" : "nonaktif"}.`, msg);
    },
  });

  register("kick", {
    aliases: ["tendang", "remove"],
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await isGroupAdmin(sock, jid, msg.key.participant || jid))) {
        return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      }
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply(sock, jid, "Tag anggota yang mau dikeluarkan, contoh: *!kick @orang*", msg);
      await sock.groupParticipantsUpdate(jid, mentioned, "remove");
      reply(sock, jid, `👋 ${mentioned.length} anggota dikeluarkan.`, msg);
    },
  });

  register("add", {
    aliases: ["tambahmember"],
    handler: async ({ sock, jid, isGroup, args, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await isGroupAdmin(sock, jid, msg.key.participant || jid))) {
        return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      }
      const numbers = args.map((a) => getJid(a));
      if (!numbers.length) return reply(sock, jid, "Cara pakai: *!add 628xxxx 628yyyy*", msg);
      const res = await sock.groupParticipantsUpdate(jid, numbers, "add");
      const failed = res.filter((r) => r.status !== "200");
      reply(sock, jid, failed.length ? `⚠️ ${failed.length} gagal ditambahkan.` : `✅ ${numbers.length} anggota ditambahkan.`, msg);
    },
  });

  register("admins", {
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      const meta = await sock.groupMetadata(jid);
      const admins = (meta.participants || []).filter((p) => p.admin);
      const text = "👑 *Admin Grup:*\n\n" +
        (admins.length
          ? admins.map((a) => `• @${a.id.split("@")[0]}`).join("\n")
          : "Tidak ada admin") +
        `\n\n👥 Total anggota: ${(meta.participants || []).length}`;
      await sock.sendMessage(jid, { text, mentions: admins.map((a) => a.id) }, { quoted: msg });
    },
  });

  onMessage.push(async (sock, msg, ctx) => {
    if (!ctx.isGroup || !ctx.text || !antilinks[ctx.jid]) return false;
    if (ctx.isOwner || (await isGroupAdmin(sock, ctx.jid, ctx.participant))) return false;
    if (/https?:\/\/|(www\.)/i.test(ctx.text)) {
      await sock.sendMessage(ctx.jid, { delete: { remoteJid: ctx.jid, id: msg.key.id, participant: msg.key.participant } });
      await sock.sendMessage(ctx.jid, { text: `🔗 *Anti-link:* @${normJid(ctx.participant)} dilarang kirim link di grup ini.`, mentions: [ctx.participant] });
      return true;
    }
    return false;
  });

  onGroupParticipantsUpdate.push(async (sock, update) => {
    const groupId = update.id;
    if (update.action === "add") {
      const w = welcomes[groupId];
      if (!w) return;
      const mentions = update.participants || [];
      const text = w.replace(/@/g, "@" + mentions[0]?.split("@")[0] || "member");
      await sock.sendMessage(groupId, { text, mentions });
    } else if (update.action === "remove") {
      const names = update.participants || [];
      if (!names.length) return;
      await sock.sendMessage(groupId, { text: `👋 Selamat tinggal @${names[0].split("@")[0]}.`, mentions: names });
    }
  });

  register("tagall", {
    aliases: ["mentionall", "everyone"],
    handler: async ({ sock, jid, isGroup, text, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      const meta = await sock.groupMetadata(jid);
      const members = (meta.participants || []).map((p) => p.id);
      const body = text.replace(/^!\s*tagall\s*/i, "").trim() || "📢 Perhatian!";
      const mention = members.map((m) => `@${m.split("@")[0]}`).join(" ");
      await sock.sendMessage(jid, { text: `${body}\n\n${mention}`, mentions: members }, { quoted: msg });
    },
  });

  register("react", {
    aliases: ["reaksi"],
    handler: async ({ sock, jid, args, msg }) => {
      const emoji = args[0] || "👍";
      const key = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
        ? { ...msg.key, id: msg.message.extendedTextMessage.contextInfo.stanzaId }
        : msg.key;
      await sock.sendMessage(jid, { react: { text: emoji, key } });
    },
  });

  register("pin", {
    handler: async ({ sock, jid, args, msg }) => {
      const ci = msg.message?.extendedTextMessage?.contextInfo;
      if (!ci?.stanzaId) return reply(sock, jid, "Reply pesan yang mau di-pin, lalu ketik *!pin*.", msg);
      const days = parseInt(args[0]) || 7;
      const time = days === 1 ? 86400 : days === 30 ? 2592000 : 604800;
      const { proto: waProto } = require("@whiskeysockets/baileys");
      const pinKey = { remoteJid: jid, id: ci.stanzaId, participant: ci.participant };
      await sock.sendMessage(jid, {
        pin: pinKey,
        type: waProto.PinInChat.Type.PIN_FOR_ALL,
        time,
      });
      reply(sock, jid, `📌 Pesan di-pin selama ${days} hari.`, msg);
    },
  });

  register("hapuspesan", {
    aliases: ["delete", "del"],
    handler: async ({ sock, jid, msg }) => {
      const ci = msg.message?.extendedTextMessage?.contextInfo;
      if (!ci?.stanzaId) return reply(sock, jid, "Reply pesan yang mau dihapus, lalu ketik *!hapuspesan*.", msg);
      await sock.sendMessage(jid, {
        delete: { remoteJid: jid, id: ci.stanzaId, participant: ci.participant },
      });
    },
  });

  register("viewonce", {
    aliases: ["vo", "sekali"],
    handler: async ({ sock, jid, msg }) => {
      const m = msg.message;
      let target = null;
      if (m.imageMessage || m.videoMessage) target = msg;
      else target = quotedMedia(msg);
      if (!target) return reply(sock, jid, "Reply/kirim gambar atau video dengan *!viewonce*.", msg);
      const content = target.message;
      const isVideo = !!content.videoMessage;
      reply(sock, jid, "⏳ Memproses...", msg).catch(() => {});
      try {
        const media = await downloadMedia(target);
        if (isVideo) {
          await sock.sendMessage(jid, { video: media, viewOnce: true, caption: "" }, { quoted: msg });
        } else {
          await sock.sendMessage(jid, { image: media, viewOnce: true, caption: "" }, { quoted: msg });
        }
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg).catch(() => {});
      }
    },
  });

  register("ptv", {
    aliases: ["videonote", "bulat"],
    handler: async ({ sock, jid, msg }) => {
      const m = msg.message;
      let target = null;
      if (m.videoMessage) target = msg;
      else target = quotedMedia(msg);
      if (!target || !target.message.videoMessage) {
        return reply(sock, jid, "Reply/kirim video dengan *!ptv*.", msg);
      }
      reply(sock, jid, "⏳ Memproses...", msg).catch(() => {});
      try {
        const media = await downloadMedia(target);
        await sock.sendMessage(jid, { video: media, ptv: true }, { quoted: msg });
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg).catch(() => {});
      }
    },
  });

  register("lokasi", {
    aliases: ["location", "loc"],
    handler: async ({ sock, jid, args, msg }) => {
      const lat = parseFloat(args[0]);
      const lon = parseFloat(args[1]);
      if (isNaN(lat) || isNaN(lon)) {
        return reply(sock, jid, "Cara pakai: *!lokasi <latitude> <longitude>*\nContoh: *!lokasi -6.2088 106.8456*", msg);
      }
      await sock.sendMessage(jid, {
        location: { degreesLatitude: lat, degreesLongitude: lon },
      }, { quoted: msg });
    },
  });

  register("kontak", {
    aliases: ["contact", "vcard"],
    handler: async ({ sock, jid, args, msg }) => {
      const number = args[0];
      const name = args.slice(1).join(" ") || number;
      if (!number) return reply(sock, jid, "Cara pakai: *!kontak 628xxx NamaKontak*", msg);
      const num = number.replace(/[^0-9]/g, "");
      const vcard =
        "BEGIN:VCARD\n" +
        "VERSION:3.0\n" +
        `FN:${name}\n` +
        `TEL;type=CELL;type=VOICE;waid=${num}:+${num}\n` +
        "END:VCARD";
      await sock.sendMessage(jid, {
        contacts: { displayName: name, contacts: [{ vcard }] },
      }, { quoted: msg });
    },
  });

  register("event", {
    handler: async ({ sock, jid, text, msg }) => {
      const body = text.replace(/^!\s*event\s*/i, "").trim();
      const parts = body.split("|").map((s) => s.trim());
      if (parts.length < 3) {
        return reply(sock, jid, "Cara pakai: *!event nama|deskripsi|tanggal*\nContoh: *!event Rapat|Bahas proyek|2026-09-01*", msg);
      }
      const startDate = new Date(parts[2]);
      if (isNaN(startDate.getTime())) return reply(sock, jid, "Format tanggal salah. Gunakan: *YYYY-MM-DD*", msg);
      const endDate = new Date(startDate.getTime() + 3600000);
      await sock.sendMessage(jid, {
        event: {
          name: parts[0],
          description: parts[1],
          startDate,
          endDate,
          isCancelled: false,
          isScheduleCall: false,
          extraGuestsAllowed: true,
          messageSecret: randomBytes(32),
        },
      }, { quoted: msg });
    },
  });

  register("status", {
    aliases: ["story", "poststatus"],
    ownerOnly: true,
    handler: async ({ sock, jid, text, msg }) => {
      const body = text.replace(/^!\s*(?:status|story|poststatus)\s*/i, "").trim();
      if (!body) return reply(sock, jid, "Cara pakai: *!status <teks>*", msg);
      await sock.sendMessage("status@broadcast", { text: body }, {
        backgroundColor: "#075E54",
        font: 2,
        broadcast: true,
        statusJidList: [jid],
      });
      reply(sock, jid, "✅ Status berhasil diposting.", msg);
    },
  });

  register("forward", {
    aliases: ["terusin"],
    handler: async ({ sock, jid, msg }) => {
      const ci = msg.message?.extendedTextMessage?.contextInfo;
      if (!ci?.quotedMessage) return reply(sock, jid, "Reply pesan yang mau diteruskan, lalu ketik *!forward*.", msg);
      const fwdMsg = { message: ci.quotedMessage, key: { remoteJid: jid, id: ci.stanzaId, participant: ci.participant } };
      await sock.sendMessage(jid, { forward: fwdMsg, force: true }, { quoted: msg });
    },
  });

  register("album", {
    handler: async ({ sock, jid, args, msg }) => {
      return reply(sock, jid, "Fitur album: kirim beberapa gambar/video sekaligus.\nGunakan *!album* lalu kirim media secara berurutan (maks 10).\n\n_Fitur ini memerlukan pengiriman media manual._", msg);
    },
  });

  /* ===================== UTILITY ===================== */

  register("cekwa", {
    aliases: ["checkwa", "isonwa"],
    handler: async ({ sock, jid, args, msg }) => {
      const num = (args[0] || "").replace(/[^0-9]/g, "");
      if (!num) return reply(sock, jid, "Cara pakai: *!cekwa 628xxxx*", msg);
      try {
        const res = await sock.onWhatsApp(num);
        if (!res.length || !res[0].exists) return reply(sock, jid, `❌ ${num} tidak terdaftar di WhatsApp.`, msg);
        reply(sock, jid, `✅ ${num} terdaftar di WA.`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("bio", {
    aliases: ["statusbio"],
    handler: async ({ sock, jid, args, msg }) => {
      const ci = msg.message?.extendedTextMessage?.contextInfo;
      const target =
        ci?.mentionedJid?.[0] ||
        (args[0] ? getJid(args[0]) : null) ||
        (jid.endsWith("@s.whatsapp.net") ? jid : null);
      if (!target) return reply(sock, jid, "Cara pakai: *!bio @user* atau *!bio 628xxx*", msg);
      try {
        const raw = await sock.fetchStatus(target);
        const item = Array.isArray(raw) ? raw[0] : raw;
        const statusText =
          typeof item === "string"
            ? item
            : typeof item?.status === "string"
              ? item.status
              : item?.status?.status || "-";
        const setAt = item?.status?.setAt || item?.setAt;
        reply(
          sock,
          jid,
          `📝 *Bio ${target.split("@")[0]}*\n\n${statusText}` +
            (setAt ? `\n\n🕒 Diupdate: ${new Date(setAt).toLocaleString("id-ID")}` : ""),
          msg
        );
      } catch (e) {
        reply(sock, jid, `⚠️ Tidak bisa ambil bio: ${e.message}`, msg);
      }
    },
  });

  register("calllink", {
    handler: async ({ sock, jid, args, msg }) => {
      const type = (args[0] || "video").toLowerCase() === "audio" ? "audio" : "video";
      try {
        const link = await sock.createCallLink(type);
        reply(sock, jid, `📞 *Link ${type} call:*\n${link}\n\nBagikan ke siapa saja untuk bergabung.`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("userinfo", {
    aliases: ["infouser"],
    handler: async ({ sock, jid, args, msg }) => {
      const ci = msg.message?.extendedTextMessage?.contextInfo;
      const targetJid = ci?.mentionedJid?.[0] || (args[0] ? getJid(args[0]) : null);
      if (!targetJid) return reply(sock, jid, "Cara pakai: *!userinfo @user* atau *!userinfo 628xxx*", msg);
      const num = targetJid.split("@")[0];
      try {
        const user = new USyncUser().withId(targetJid);
        const query = new USyncQuery()
          .withContactProtocol()
          .withStatusProtocol()
          .withDeviceProtocol()
          .withDisappearingModeProtocol()
          .withUsernameProtocol()
          .withUser(user);
        const res = await sock.executeUSyncQuery(query);
        const entry = res?.list?.[0];
        if (!entry) return reply(sock, jid, "❌ Data tidak ditemukan.", msg);
        const lines = [`👤 *USER INFO* — ${num}`, ""];
        if (entry.contact !== undefined && entry.contact !== null) {
          lines.push(entry.contact ? "📱 Terdaftar di WA: ya" : "📱 Terdaftar di WA: tidak");
        }
        const st = typeof entry.status === "string" ? entry.status : entry.status?.status;
        if (st) lines.push(`📝 Bio: ${st}`);
        if (entry.username) lines.push(`🆔 Username: @${entry.username}`);
        if (entry.device?.deviceClass) lines.push(`💻 Device: ${entry.device.deviceClass}`);
        if (entry.disappearingMode?.duration) {
          lines.push(`⏳ Chat hilang otomatis: ${entry.disappearingMode.duration}s`);
        }
        reply(sock, jid, lines.join("\n"), msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("username", {
    handler: async ({ sock, jid, args, msg }) => {
      const ci = msg.message?.extendedTextMessage?.contextInfo;
      const targetJid = ci?.mentionedJid?.[0] || (args[0] ? getJid(args[0]) : null);
      if (!targetJid) return reply(sock, jid, "Cara pakai: *!username @user*", msg);
      try {
        const user = new USyncUser().withId(targetJid);
        const query = new USyncQuery().withUsernameProtocol().withUser(user);
        const res = await sock.executeUSyncQuery(query);
        const uname = res?.list?.[0]?.username;
        reply(sock, jid, uname ? `🆔 Username: *@${uname}*` : "❌ User belum punya username WA.", msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  /* ===================== GRUP MANAGEMENT ===================== */

  register("buatgrup", {
    ownerOnly: true,
    handler: async ({ sock, jid, text, msg }) => {
      const body = text.replace(/^!\s*buatgrup\s*/i, "").trim();
      const [subject] = body.split("|").map((s) => s.trim());
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!subject || !mentioned.length) {
        return reply(sock, jid, "Cara pakai: *!buatgrup NamaGrup* lalu tag anggota.\nContoh: *!buatgrup Tim Proyek @a @b*", msg);
      }
      try {
        const g = await sock.groupCreate(subject, mentioned);
        await sock.sendMessage(g.id, { text: `🎉 Grup *${subject}* berhasil dibuat oleh bot.` });
        reply(sock, jid, `✅ Grup dibuat: ${g.gid || g.id}`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal buat grup: ${e.message}`, msg);
      }
    },
  });

  register("namagrup", {
    aliases: ["setsubject"],
    handler: async ({ sock, jid, isGroup, text, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const name = text.replace(/^!\s*(?:namagrup|setsubject)\s*/i, "").trim();
      if (!name) return reply(sock, jid, "Cara pakai: *!namagrup <nama baru>*", msg);
      await sock.groupUpdateSubject(jid, name);
      reply(sock, jid, `✅ Nama grup diganti jadi *${name}*.`, msg);
    },
  });

  register("descgrup", {
    aliases: ["setdesc"],
    handler: async ({ sock, jid, isGroup, text, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const d = text.replace(/^!\s*(?:descgrup|setdesc)\s*/i, "").trim();
      await sock.groupUpdateDescription(jid, d || undefined);
      reply(sock, jid, d ? "✅ Deskripsi grup diupdate." : "🗑️ Deskripsi grup dihapus.", msg);
    },
  });

  register("fotogrup", {
    aliases: ["setfotogrup"],
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const m = msg.message;
      const target = m.imageMessage ? msg : quotedMedia(msg);
      if (!target || !(target.message.imageMessage || target.message.photoMessage)) {
        return reply(sock, jid, "Kirim/reply gambar dengan caption *!fotogrup*.", msg);
      }
      try {
        const buf = await downloadMedia(target);
        await sock.updateProfilePicture(jid, buf);
        reply(sock, jid, "✅ Foto grup diupdate.", msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("invitelink", {
    aliases: ["linkgc"],
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      try {
        const code = await sock.groupInviteCode(jid);
        reply(sock, jid, `🔗 *Link grup:*\nhttps://chat.whatsapp.com/${code}`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("resetlink", {
    aliases: ["revokelink"],
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const code = await sock.groupRevokeInvite(jid);
      reply(sock, jid, `♻️ Link direset.\n🔗 Link baru: https://chat.whatsapp.com/${code}`, msg);
    },
  });

  register("setephem", {
    handler: async ({ sock, jid, isGroup, args, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const map = { off: 0, "1": 86400, "7": 604800, "30": 2592000 };
      const val = (args[0] || "").toLowerCase();
      if (!(val in map)) return reply(sock, jid, "Cara pakai: *!setephem off/1/7/30* (hari)", msg);
      await sock.groupToggleEphemeral(jid, map[val]);
      reply(sock, jid, `⏳ Chat hilang otomatis: ${val === "off" ? "OFF" : val + " hari"}.`, msg);
    },
  });

  register("locktopik", {
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      await sock.groupSettingUpdate(jid, "locked");
      reply(sock, jid, "🔒 Info grup dikunci (hanya admin yang bisa ubah).", msg);
    },
  });

  register("unlocktopik", {
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      await sock.groupSettingUpdate(jid, "unlocked");
      reply(sock, jid, "🔓 Info grup dibuka.", msg);
    },
  });

  register("lockchat", {
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      await sock.groupSettingUpdate(jid, "announcement");
      reply(sock, jid, "📢 Mode pengumuman AKTIF (hanya admin yang bisa kirim pesan).", msg);
    },
  });

  register("unlockchat", {
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      await sock.groupSettingUpdate(jid, "not_announcement");
      reply(sock, jid, "💬 Semua anggota bisa kirim pesan lagi.", msg);
    },
  });

  register("approvemode", {
    handler: async ({ sock, jid, isGroup, args, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const mode = (args[0] || "").toLowerCase();
      if (!["on", "off"].includes(mode)) return reply(sock, jid, "Cara pakai: *!approvemode on/off*", msg);
      await sock.groupJoinApprovalMode(jid, mode);
      reply(sock, jid, mode === "on" ? "🛂 Approval join request: ON." : "🚪 Approval join request: OFF.", msg);
    },
  });

  register("joinreqs", {
    aliases: ["pendingjoin"],
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      try {
        const raw = await sock.groupRequestParticipantsList(jid);
        const list = Array.isArray(raw) ? raw : raw?.participants || [];
        if (!list.length) return reply(sock, jid, "📭 Tidak ada permintaan join pending.", msg);
        const rows = list.map((x, i) => {
          const pj = typeof x === "string" ? x : x.id || x.jid;
          return `${i + 1}. @${normJid(pj)}`;
        });
        reply(sock, jid, `📋 *Pending join request:*\n\n${rows.join("\n")}\n\nApprove: *!approvejoin @nomor / all*`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("approvejoin", {
    handler: async ({ sock, jid, isGroup, args, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const raw = await sock.groupRequestParticipantsList(jid);
      const list = Array.isArray(raw) ? raw : raw?.participants || [];
      const all = list.map((x) => (typeof x === "string" ? x : x.id || x.jid));
      if (!all.length) return reply(sock, jid, "📭 Tidak ada pending request.", msg);
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const targets = mentioned.length ? all.filter((p) => mentioned.some((m) => normJid(m) === normJid(p))) : all;
      if (!targets.length) return reply(sock, jid, "❌ Nomor tidak ada di daftar pending.", msg);
      await sock.groupRequestParticipantsUpdate(jid, targets, "approve");
      reply(sock, jid, `✅ ${targets.length} request di-approve.`, msg);
    },
  });

  register("rejectjoin", {
    handler: async ({ sock, jid, isGroup, args, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const raw = await sock.groupRequestParticipantsList(jid);
      const list = Array.isArray(raw) ? raw : raw?.participants || [];
      const all = list.map((x) => (typeof x === "string" ? x : x.id || x.jid));
      if (!all.length) return reply(sock, jid, "📭 Tidak ada pending request.", msg);
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const targets = mentioned.length ? all.filter((p) => mentioned.some((m) => normJid(m) === normJid(p))) : all;
      if (!targets.length) return reply(sock, jid, "❌ Nomor tidak ada di daftar pending.", msg);
      await sock.groupRequestParticipantsUpdate(jid, targets, "reject");
      reply(sock, jid, `🚫 ${targets.length} request ditolak.`, msg);
    },
  });

  register("promote", {
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply(sock, jid, "Tag anggotanya: *!promote @user*", msg);
      await sock.groupParticipantsUpdate(jid, mentioned, "promote");
      reply(sock, jid, `👑 ${mentioned.length} anggota jadi admin.`, msg);
    },
  });

  register("demote", {
    handler: async ({ sock, jid, isGroup, msg }) => {
      if (!isGroup) return reply(sock, jid, "Perintah hanya untuk grup.", msg);
      if (!(await requireAdmin(sock, jid, msg))) return reply(sock, jid, "⛔ Khusus admin grup.", msg);
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply(sock, jid, "Tag adminnya: *!demote @user*", msg);
      await sock.groupParticipantsUpdate(jid, mentioned, "demote");
      reply(sock, jid, `📉 ${mentioned.length} admin diturunkan.`, msg);
    },
  });

  /* ===================== CHANNEL / NEWSLETTER ===================== */

  register("buatchannel", {
    ownerOnly: true,
    handler: async ({ sock, jid, text, msg }) => {
      const body = text.replace(/^!\s*buatchannel\s*/i, "").trim();
      const [name, desc] = body.split("|").map((s) => s.trim());
      if (!name) return reply(sock, jid, "Cara pakai: *!buatchannel NamaChannel|Deskripsi*", msg);
      try {
        const meta = await sock.newsletterCreate(name, desc || "");
        channels[name.toLowerCase()] = { jid: meta.id, invite: meta.invite || "" };
        saveJSON("channels.json", channels);
        reply(
          sock,
          jid,
          `✅ Channel dibuat!\n\n📛 ${name}\n🆔 \`${meta.id}\`${meta.invite ? `\n🔗 https://whatsapp.com/channel/${meta.invite}` : ""}`,
          msg
        );
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("mychannels", {
    ownerOnly: true,
    handler: async ({ sock, jid, msg }) => {
      const keys = Object.keys(channels);
      if (!keys.length) return reply(sock, jid, "📭 Belum ada channel tersimpan. Buat: *!buatchannel Nama|Desc*", msg);
      const rows = keys.map((k) => `• *${k}* — \`${channels[k].jid}\`${channels[k].invite ? `\n  🔗 https://whatsapp.com/channel/${channels[k].invite}` : ""}`);
      reply(sock, jid, "📡 *Daftar Channel:*\n\n" + rows.join("\n"), msg);
    },
  });

  register("postchannel", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, text, msg }) => {
      const key = (args.shift() || "").toLowerCase();
      const content = args.join(" ").trim();
      if (!key || !content) return reply(sock, jid, "Cara pakai: *!postchannel <nama/jid> <pesan>*", msg);
      const ch = channels[key];
      const target = ch ? ch.jid : key.includes("@newsletter") ? key : null;
      if (!target) return reply(sock, jid, "❌ Channel tidak dikenal. Cek: *!mychannels*", msg);
      try {
        await sock.sendMessage(target, { text: content });
        reply(sock, jid, "✅ Pesan diposting ke channel.", msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  function parseChannelCode(input) {
    const m = String(input || "").match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
    return m ? m[1] : /^[A-Za-z0-9]{16,}$/.test(String(input || "")) ? input : null;
  }

  register("followchannel", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      const code = parseChannelCode(args[0]);
      if (!code) return reply(sock, jid, "Cara pakai: *!followchannel <link channel>*", msg);
      try {
        const meta = await sock.newsletterMetadata("invite", code);
        await sock.newsletterFollow(meta.id);
        reply(sock, jid, `✅ Followed channel: *${meta.name}*`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("unfollowchannel", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      const code = parseChannelCode(args[0]);
      if (!code) return reply(sock, jid, "Cara pakai: *!unfollowchannel <link channel>*", msg);
      try {
        const meta = await sock.newsletterMetadata("invite", code);
        await sock.newsletterUnfollow(meta.id);
        reply(sock, jid, `👋 Unfollowed: *${meta.name}*`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("infochannel", {
    handler: async ({ sock, jid, args, msg }) => {
      const arg = args[0] || "";
      const code = parseChannelCode(arg);
      try {
        const meta = code
          ? await sock.newsletterMetadata("invite", code)
          : channels[arg.toLowerCase()]
            ? await sock.newsletterMetadata("jid", channels[arg.toLowerCase()].jid)
            : null;
        if (!meta) return reply(sock, jid, "Cara pakai: *!infochannel <link/nama>*", msg);
        reply(
          sock,
          jid,
          `📡 *INFO CHANNEL*\n\n📛 ${meta.name || "-"}\n🆔 \`${meta.id}\`\n👥 Subscribers: ${meta.subscribers ?? "?"}${meta.description ? `\n📄 ${meta.description}` : ""}`,
          msg
        );
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  /* ===================== LABEL / CRM ===================== */

  register("label", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      const name = args.join(" ").trim();
      if (!name) return reply(sock, jid, "Cara pakai: *!label <nama label>*", msg);
      try {
        const id = "lbl_" + Date.now();
        await sock.addLabel(jid, { id, name, predefinedId: false, color: Math.floor(Math.random() * 20), deleted: false });
        reply(sock, jid, `🏷️ Label *${name}* dibuat.\nID: \`${id}\`\nPakai: *!tandai ${id}*`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Fitur label biasanya khusus akun WA Business. Error: ${e.message}`, msg);
      }
    },
  });

  register("tandai", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      const labelId = args[0];
      if (!labelId) return reply(sock, jid, "Cara pakai: *!tandai <labelId>*", msg);
      try {
        await sock.addChatLabel(jid, labelId);
        reply(sock, jid, `✅ Chat ini ditandai label \`${labelId}\`.`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("bintang", {
    handler: async ({ sock, jid, msg }) => {
      const ci = msg.message?.extendedTextMessage?.contextInfo;
      if (!ci?.stanzaId) return reply(sock, jid, "Reply pesan yang mau dibintangi, lalu ketik *!bintang*.", msg);
      try {
        await sock.star(jid, [{ id: ci.stanzaId, fromMe: !!ci.isFromMe }], true);
        reply(sock, jid, "⭐ Pesan dibintangi.", msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  /* ===================== PRIVACY & SETTINGS ===================== */

  register("privacy", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      const setters = {
        lastseen: (v) => sock.updateLastSeenPrivacy(v),
        online: (v) => sock.updateOnlinePrivacy(v),
        foto: (v) => sock.updateProfilePicturePrivacy(v),
        status: (v) => sock.updateStatusPrivacy(v),
        readreceipts: (v) => sock.updateReadReceiptsPrivacy(v),
        groupsadd: (v) => sock.updateGroupsAddPrivacy(v),
        call: (v) => sock.updateCallPrivacy(v),
      };
      if (!args[0]) {
        try {
          const cur = await sock.fetchPrivacySettings(true);
          const p = cur.privacy || cur;
          reply(
            sock,
            jid,
            `🔒 *PRIVASI SAAT INI*\n\n• Last seen: ${p.last || "?"}\n• Online: ${p.online || "?"}\n• Foto profil: ${p.profile || "?"}\n• Status: ${p.status || "?"}\n• Read receipts: ${p.readreceipts || "?"}\n• Add grup: ${p.groupadd || "?"}\n• Call: ${p.call || "?"}`,
            msg
          );
        } catch (e) {
          reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
        }
        return;
      }
      const setter = setters[args[0]];
      if (!setter) return reply(sock, jid, `Fitur valid: *${Object.keys(setters).join(",")}*\nNilai: all/contacts/none (sesuai fitur)\nContoh: *!privacy lastseen contacts*`, msg);
      const value = args[1];
      if (!value) return reply(sock, jid, `Nilainya mana? Contoh: *!privacy ${args[0]} all/contacts/none*`, msg);
      try {
        await setter(value);
        reply(sock, jid, `✅ Privasi *${args[0]}* diset ke *${value}*.`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("ephemglobal", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      const map = { off: 0, "1": 86400, "7": 604800, "30": 2592000 };
      const val = (args[0] || "").toLowerCase();
      if (!(val in map)) return reply(sock, jid, "Cara pakai: *!ephemglobal off/1/7/30*", msg);
      try {
        await sock.updateDefaultDisappearingMode(map[val]);
        reply(sock, jid, `⏳ Default disappearing chat baru: ${val === "off" ? "OFF" : val + " hari"}.`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("updatebio", {
    ownerOnly: true,
    handler: async ({ sock, jid, text, msg }) => {
      const bio = text.replace(/^!\s*updatebio\s*/i, "").trim();
      if (!bio) return reply(sock, jid, "Cara pakai: *!updatebio <teks>*", msg);
      try {
        await sock.updateProfileStatus(bio);
        reply(sock, jid, `✅ Bio diupdate: "${bio}"`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  register("updatename", {
    ownerOnly: true,
    handler: async ({ sock, jid, text, msg }) => {
      const name = text.replace(/^!\s*updatename\s*/i, "").trim();
      if (!name) return reply(sock, jid, "Cara pakai: *!updatename <nama>*", msg);
      try {
        await sock.updateProfileName(name);
        reply(sock, jid, `✅ Nama profil diupdate: "${name}"`, msg);
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal: ${e.message}`, msg);
      }
    },
  });

  /* ===================== AUTO APPROVE JOIN REQUEST ===================== */

  if (config) config.autoApprove = config.autoApprove !== false;

  register("autoapprove", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      if (!config) return;
      const val = (args[0] || "").toLowerCase();
      if (val === "on") config.autoApprove = true;
      else if (val === "off") config.autoApprove = false;
      else return reply(sock, jid, `Gunakan *!autoapprove on/off*. Saat ini: ${config.autoApprove ? "ON" : "OFF"}`, msg);
      reply(sock, jid, `Auto approve join request: ${config.autoApprove ? "ON ✅" : "OFF ❌"}`, msg);
    },
  });

  onGroupJoinRequest.push(async (sock, update) => {
    if (!config?.autoApprove) return;
    if (update.action !== "created") return;
    try {
      await sock.groupRequestParticipantsUpdate(update.id, [update.participant], "approve");
      await sock.sendMessage(update.id, {
        text: `✅ @${normJid(update.participant)} otomatis disetujui masuk grup.`,
        mentions: [update.participant],
      });
    } catch (e) {
      console.error("Auto approve fail:", e.message);
    }
  });

  /* ===================== QUIZ POLL ===================== */

  register("quiz", {
    handler: async ({ sock, jid, text, msg }) => {
      const body = text.replace(/^!\s*quiz\s*/i, "").trim();
      const parts = body.split("|").map((s) => s.trim());
      if (parts.length < 3) return reply(sock, jid, "Cara pakai: *!quiz pertanyaan|opsi1,opsi2,opsi3|jawaban*\nJawaban boleh teks opsi atau huruf (a/b/c)", msg);
      const options = parts[1].split(",").map((o) => o.trim()).filter(Boolean);
      if (options.length < 2) return reply(sock, jid, "Minimal 2 opsi.", msg);
      let correct = parts[2];
      const idx = "abcde".indexOf(correct.toLowerCase());
      if (idx >= 0 && options[idx]) correct = options[idx];
      if (!options.includes(correct)) return reply(sock, jid, "❌ Jawaban harus salah satu dari opsi.", msg);
      try {
        await relayContent(sock, jid, {
          pollCreationMessage: proto.Message.PollCreationMessage.fromObject({
            name: parts[0],
            options: options.map((o) => ({ optionName: o })),
            selectableOptionsCount: 1,
            pollType: 1,
            correctAnswer: { optionName: correct },
          }),
        });
      } catch (e) {
        reply(sock, jid, `⚠️ Gagal buat quiz: ${e.message}`, msg);
      }
    },
  });

  /* ===================== INTERACTIVE UI ===================== */

  register("menubtn", {
    aliases: ["btmenu"],
    handler: async ({ sock, jid }) => {
      await sendNativeButtons(sock, jid, {
        title: "📦 MENU BOT",
        body: "Pilih menu di bawah 👇",
        footer: "Bot WA • !menu untuk teks lengkap",
        buttons: [
          { params: { display_text: "🏓 Ping", id: "!ping" } },
          { params: { display_text: "🛍️ Katalog", id: "!catalog" } },
          { params: { display_text: "🃏 Katalog Carousel", id: "!catalogcar" } },
          { params: { display_text: "ℹ️ Info Bot", id: "!info" } },
          { params: { display_text: "📊 Poll Demo", id: "!poll Minuman favorit?|kopi,teh,susu" } },
        ],
      });
    },
  });

  register("catalogcar", {
    aliases: ["carcatalog", "katalogcar"],
    handler: async ({ sock, jid, msg }) => {
      if (!products.length) return reply(sock, jid, "📭 Belum ada produk.", msg);
      const cards = products.slice(0, 10).map((p) => ({
        title: p.name,
        subtitle: formatRupiah(p.price),
        body: `${p.desc || ""}\n💰 *${formatRupiah(p.price)}*`,
        footer: "Tap tombol untuk beli",
        buttons: [{ params: { display_text: "🛒 Beli", id: `!beli ${p.id}` } }],
      }));
      try {
        await sendCarouselCards(sock, jid, { cards });
      } catch (e) {
        reply(sock, jid, `⚠️ Carousel gagal dirender: ${e.message}`, msg);
      }
    },
  });

  return { onMessage, onGroupParticipantsUpdate, onGroupJoinRequest, products, carts };
}

module.exports = { initFeatures };
