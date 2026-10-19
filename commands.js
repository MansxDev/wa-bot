module.exports = function registerGeneralCommands({ register, reply, getJid, sendPoll, formatUptime, state, config }) {
  const prefix = config.prefixes[0];

  register("menu", {
    aliases: ["help", "bantuan", "h"],
    handler: async ({ sock, jid, msg }) => {
      const text =
        "📦 *MENU BOT*\n\n" +
        "*Umum*\n" +
        "• !menubtn — menu tombol interaktif\n" +
        "• !ping — cek respons\n" +
        "• !list — menu makanan/minuman\n" +
        "• !poll — polling\n" +
        "• !quiz tanya|opsi1,opsi2|jawaban — quiz\n" +
        "• !info — info bot\n\n" +
        "*Utility*\n" +
        "• !cekwa <nomor> — cek nomor aktif WA\n" +
        "• !bio @user/nomor — lihat bio\n" +
        "• !userinfo @user — info lengkap user\n" +
        "• !username @user — cek username WA\n" +
        "• !calllink audio/video — link panggilan\n\n" +
        "*Stiker*\n" +
        "• !sticker — kirim/reply gambar/video\n\n" +
        "*Media*\n" +
        "• !viewonce — jadikan sekali lihat\n" +
        "• !ptv — video note bulat\n" +
        "• !lokasi <lat> <lon>\n" +
        "• !kontak <nomor> <nama>\n" +
        "• !forward — teruskan pesan (reply)\n" +
        "• !bintang — star pesan (reply)\n" +
        "• !event nama|desk|tgl — buat event\n\n" +
        "*Grup*\n" +
        "• !tagall — mention semua anggota\n" +
        "• !react <emoji> — reaksi pesan\n" +
        "• !pin / !hapuspesan — reply pesan\n" +
        "• !promote/@user, !demote/@user\n" +
        "• !namagrup, !descgrup, !fotogrup\n" +
        "• !invitelink, !resetlink\n" +
        "• !setephem off/1/7/30 — chat hilang otomatis\n" +
        "• !lockchat / !unlockchat — mode announce\n" +
        "• !locktopik / !unlocktopik — kunci info grup\n" +
        "• !approvemode on/off, !joinreqs\n" +
        "• !approvejoin / !rejectjoin @user\n" +
        "• !setwelcome, !antilink on/off\n" +
        "• !warn / !unwarn / !warnstatus — sistem warn\n" +
        "• !kick, !add, !admins\n\n" +
        "*Store*\n" +
        "• !catalog / !catalogcar — teks / carousel\n" +
        "• !beli, !keranjang, !checkout\n\n" +
        "*Channel*\n" +
        "• !buatchannel Nama|Desc (owner)\n" +
        "• !postchannel nama <pesan> (owner)\n" +
        "• !mychannels, !infochannel\n" +
        "• !followchannel / !unfollowchannel (owner)\n\n" +
        "*Owner*\n" +
        "• !autoreply on/off, !read on/off\n" +
        "• !autoapprove on/off\n" +
        "• !broadcast, !status <teks>\n" +
        "• !privacy [fitur] [nilai]\n" +
        "• !ephemglobal off/1/7/30\n" +
        "• !updatebio, !updatename\n" +
        "• !label <nama>, !tandai <id>\n" +
        "• !buatgrup Nama|@anggota\n" +
        "• !jual nama|harga|desk\n\n" +
        `Ketik *!menu* kapan saja untuk melihat ini.`;
      await reply(sock, jid, text, msg);
    },
  });

  register("ping", {
    aliases: ["p"],
    cooldown: 1000,
    handler: async ({ sock, jid, msg }) => {
      const before = Date.now();
      await reply(sock, jid, "🏓 Pong!", msg);
      const latency = Date.now() - before;
      await reply(sock, jid, `⚡ Latency: ${latency}ms`, msg);
    },
  });

  register("list", {
    handler: async ({ sock, jid, msg }) => {
      const text =
        "🍽️ *MENU MAKANAN*\n\n" +
        "🍔 Burger — Rp 25.000\n" +
        "🍕 Pizza — Rp 45.000\n" +
        "🌮 Taco — Rp 20.000\n\n" +
        "🥤 *MENU MINUMAN*\n\n" +
        "🥤 Es Teh — Rp 5.000\n" +
        "☕ Kopi — Rp 10.000\n\n" +
        "Untuk beli, gunakan *!catalog* lalu ketuk produknya.";
      await reply(sock, jid, text, msg);
    },
  });

  register("poll", {
    handler: async ({ sock, jid, args, msg }) => {
      if (args.length < 2) {
        return reply(sock, jid, `Cara pakai: *${prefix}poll pertanyaan|opsi1,opsi2,opsi3*`, msg);
      }
      const [name, ...rest] = args.join(" ").split("|");
      const options = (rest[0] || "").split(",").map((o) => o.trim()).filter(Boolean);
      if (!options.length) {
        return reply(sock, jid, `Opsinya mana? *${prefix}poll tanya|a,b,c*`, msg);
      }
      await sendPoll(sock, jid, { name, options, selectableCount: 1 });
    },
  });

  register("info", {
    aliases: ["runtime", "uptime"],
    handler: async ({ sock, jid, msg }) => {
      const used = process.memoryUsage();
      const uptime = formatUptime(Date.now() - state.startTime);
      const text =
        "🤖 *Info Bot*\n" +
        `🕐 Uptime: ${uptime}\n` +
        `💾 Memory: ${(used.rss / 1024 / 1024).toFixed(1)} MB\n` +
        `🖥 Platform: ${process.platform} ${process.arch}\n` +
        `⚙️ AutoReply: ${state.runtime.autoReply ? "ON" : "OFF"}\n` +
        `📖 ReadMsgs: ${state.runtime.readMessages ? "ON" : "OFF"}\n` +
        `👤 Owner: ${config.owner.join(", ")}`;
      await reply(sock, jid, text, msg);
    },
  });

  register("autoreply", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      const val = args[0];
      if (val === "on") state.runtime.autoReply = true;
      else if (val === "off") state.runtime.autoReply = false;
      else return reply(sock, jid, `Gunakan *${prefix}autoreply on/off*`, msg);
      reply(sock, jid, `AutoReply: ${state.runtime.autoReply ? "ON ✅" : "OFF ❌"}`, msg);
    },
  });

  register("read", {
    ownerOnly: true,
    handler: async ({ sock, jid, args, msg }) => {
      const val = args[0];
      if (val === "on") state.runtime.readMessages = true;
      else if (val === "off") state.runtime.readMessages = false;
      else return reply(sock, jid, `Gunakan *${prefix}read on/off*`, msg);
      reply(sock, jid, `Read messages: ${state.runtime.readMessages ? "ON ✅" : "OFF ❌"}`, msg);
    },
  });

  register("broadcast", {
    ownerOnly: true,
    handler: async ({ sock, jid, text, msg }) => {
      const content = text.replace(/^!\s*broadcast\s*/i, "").replace(/^!/, "").trim();
      if (!content) return reply(sock, jid, `Pesan kosong. *${prefix}broadcast <pesan>*`, msg);
      const ownerJids = config.owner.map(getJid);
      const targets = [...state.chats].filter(
        (c) => c.endsWith("@s.whatsapp.net") && !ownerJids.includes(c)
      );
      let sent = 0;
      for (const target of targets) {
        try {
          await sock.sendMessage(target, { text: `📣 *Broadcast*\n\n${content}` });
          sent++;
          await new Promise((r) => setTimeout(r, config.broadcastDelayMs));
        } catch (e) {
          console.error("Broadcast fail:", target, e.message);
        }
      }
      reply(sock, jid, `📣 Broadcast selesai. Terkirim ke ${sent}/${targets.length} kontak.`, msg);
    },
  });

  register("say", {
    aliases: ["echo"],
    handler: async ({ sock, jid, text, msg }) => {
      const content = text.replace(/^!\s*(?:say|echo)\s*/i, "").trim();
      if (!content) return reply(sock, jid, `Pesan kosong. *${prefix}say <teks>*`, msg);
      await reply(sock, jid, content, msg);
    },
  });
};
