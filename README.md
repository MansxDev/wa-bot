# WA Bot

WhatsApp bot berbasis [Baileys](https://github.com/WhiskeySockets/Baileys) — multi fitur: store, stiker, downloader, manajemen grup/channel, pesan interaktif (button, carousel, quiz poll), sampai self-bot mode.

## Fitur

| Kategori | Contoh Command |
|---|---|
| Umum | `!menu` `!menubtn` (tombol interaktif) `!ping` `!poll` `!quiz` |
| Utility | `!cekwa` `!bio` `!userinfo` `!username` `!calllink` |
| Stiker | `!sticker` (gambar & video, ffmpeg) |
| Media | `!viewonce` `!ptv` `!lokasi` `!kontak` `!forward` `!bintang` `!event` |
| Grup | `!tagall` `!promote` `!antilink` `!setwelcome` `!lockchat` `!approvemode` dll |
| Store | `!catalog` `!catalogcar` (carousel) `!beli` `!keranjang` `!checkout` |
| Channel | `!buatchannel` `!postchannel` `!followchannel` `!infochannel` |
| Downloader | `!yt` `!yta` `!dl` (via yt-dlp) |
| Owner | `!broadcast` `!status` `!privacy` `!updatebio` `!buatgrup` `!jual` dll |

Ketik `!menu` di chat untuk daftar lengkap.

## Persyaratan

- Node.js 18+
- [ffmpeg](https://ffmpeg.org) — untuk stiker video
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — untuk downloader

## Instalasi

```bash
git clone <repo-ini>
cd wa-bot
npm install
npm start
```

Saat pertama jalan, masukkan nomor WhatsApp → muncul pairing code → tautkan di **WhatsApp > Perangkat Tertaut > Tautkan Perangkat**.

Atau via env var:

```bash
PHONE_NUMBER=628123456789 npm start
```

## Konfigurasi

Edit `config.json`:

```jsonc
{
  "owner": ["6281546453913"],      // nomor owner (bisa lebih dari satu)
  "prefixes": ["!", ".", "#", "/"],// prefix command
  "cooldownMs": 1500,              // anti-spam
  "botName": "Bot WA",             // nama di fake-quoted reply
  "autoReply": true,
  "readMessages": true,
  "autoApprove": false,            // auto approve join request grup
  "rejectCalls": true,
  "maxDownloadMb": 50,
  "stickerQuality": 90
}
```

Data runtime (produk, welcome, channel) tersimpan di folder `data/`.

## Self-bot mode

Pesan dari nomor bot sendiri tetap diproses selama berupa perintah (diawali prefix). Pemilik sesi otomatis dianggap owner.

## Struktur

```
index.js     entry point + koneksi + dispatch
config.js    config loader
utils.js     helper bersama (media, interactive message, dll)
commands.js  command umum
features.js  command fitur (store, grup, channel, dll)
```

## Disclaimer

Menggunakan library tidak resmi. Akun WhatsApp bisa terkena banned bila disalahgunakan (spam broadcast, dsb). Gunakan secara wajar.
