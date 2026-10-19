"use strict";

/**
 * Self-check logika autentikasi API. Jalankan: node auth-check.js
 *
 * Menguji kode yang BENAR-BENAR di-ship (require dari server.js), bukan
 * salinannya — kalau server.js berubah, test ini ikut gagal.
 */

const assert = require("assert");
const http = require("http");
const { tokenMatch, createRateLimiter } = require("./server.js");

const TOKEN = "ab15f442eaf183b7f5090b41723c95a2";
let passed = 0;
let failed = 0;

function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

/* ---------------- parsing header ---------------- */

const strip = (raw) => raw.replace(/^Bearer\s+/i, "").trim();

console.log("\nparsing header");
ok("Bearer <token> jadi token", () => assert.equal(strip(`Bearer ${TOKEN}`), TOKEN));
ok("Bearer dengan spasi berlebih", () => assert.equal(strip(`Bearer   ${TOKEN}`), TOKEN));
ok("tanpa prefix tetap dipakai", () => assert.equal(strip(TOKEN), TOKEN));
ok("Authorization kosong -> string kosong", () => assert.equal(strip(""), ""));

/* ---------------- perbandingan token ---------------- */

console.log("\nperbandingan token");
ok("token cocok diterima", () => assert.equal(tokenMatch(TOKEN, TOKEN), true));
ok("token beda ditolak", () => assert.equal(tokenMatch("salah", TOKEN), false));
ok("sama-sama 32 char tapi beda", () =>
  assert.equal(tokenMatch("a".repeat(32), "b".repeat(32)), false));
ok("prefix benar bukan token", () => assert.equal(tokenMatch(TOKEN.slice(0, 31), TOKEN), false));
ok("suffix benar bukan token", () => assert.equal(tokenMatch(TOKEN + "x", TOKEN), false));
ok("string kosong ditolak", () => assert.equal(tokenMatch("", TOKEN), false));
ok("null / undefined tidak melempar", () => {
  assert.equal(tokenMatch(null, TOKEN), false);
  assert.equal(tokenMatch(undefined, TOKEN), false);
});
ok("header uppercase 'BEARER'", () => assert.equal(tokenMatch(strip(`BEARER ${TOKEN}`), TOKEN), true));

/* ---------------- rate limit ---------------- */

console.log("\nrate limit per IP");
const clock = (start) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};

ok("tidak limited sebelum ada kegagalan", () => {
  const c = clock(1000);
  const rl = createRateLimiter({ maxFails: 3, windowMs: 60_000, now: c.now });
  assert.equal(rl.limited("ip"), false);
});

ok("limited setelah max kegagalan", () => {
  const c = clock(1000);
  const rl = createRateLimiter({ maxFails: 3, windowMs: 60_000, now: c.now });
  for (let i = 0; i < 3; i++) rl.fail("ip");
  assert.equal(rl.limited("ip"), true);
});

ok("dibebas setelah jendela waktu lewat", () => {
  const c = clock(1000);
  const rl = createRateLimiter({ maxFails: 3, windowMs: 60_000, now: c.now });
  for (let i = 0; i < 3; i++) rl.fail("ip");
  assert.equal(rl.limited("ip"), true);
  c.advance(60_001);
  assert.equal(rl.limited("ip"), false);
});

ok("IP lain tidak ikut terkunci", () => {
  const c = clock(1000);
  const rl = createRateLimiter({ maxFails: 3, windowMs: 60_000, now: c.now });
  for (let i = 0; i < 5; i++) rl.fail("ip-helah");
  assert.equal(rl.limited("ip-helah"), true);
  assert.equal(rl.limited("ip-jujur"), false);
});

ok("clear() membebaskan IP (token sah tidak terkunci)", () => {
  const c = clock(1000);
  const rl = createRateLimiter({ maxFails: 2, windowMs: 60_000, now: c.now });
  rl.fail("ip");
  rl.fail("ip");
  assert.equal(rl.limited("ip"), true);
  rl.clear("ip");
  assert.equal(rl.limited("ip"), false);
});

/* ---------------- kontrak HTTP ---------------- */

console.log("\nkontrak HTTP (butuh bot jalan di :4000)");
const PORT = Number(process.env.AUTHCHECK_PORT || 4000);
const TOKEN_ENV = process.env.AUTHCHECK_TOKEN || TOKEN;

function request(path, { header, method = "GET" } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (header !== undefined) headers.authorization = header;
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers, timeout: 4000 }, (res) => {
      res.resume();
      res.on("end", () => resolve({ code: res.statusCode, headers: res.headers }));
    });
    req.on("error", () => resolve({ code: 0, headers: {} }));
    // Timeout = Gejala handler hang (tidak merespons sama sekali).
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: -1, headers: {} });
    });
    req.end();
  });
}

(async () => {
  const healthy = await request("/api/health", { header: `Bearer ${TOKEN_ENV}` });
  if (healthy.code === 0) {
    console.log("  skip  bot tidak jalan di :%d — bagian HTTP dilewati", PORT);
  } else {
    ok("header benar -> 200", () => assert.equal(healthy.code, 200));
    const cases = [
      ["tanpa header", "/api/health", undefined, 401],
      ["header salah", "/api/health", "Bearer salah", 401],
      ["query token DITOLAK", `/api/health?token=${TOKEN_ENV}`, undefined, 401],
      // Auth dicek SEBELUM routing: caller tak berauth tidak boleh bisa
      // menebak route mana yang ada. Expect 401, bukan 404.
      ["route tak ada tanpa auth tetap 401", "/api/tidak-ada", undefined, 401],
      ["route tak ada dengan token -> 404", "/api/tidak-ada", `Bearer ${TOKEN_ENV}`, 404],
    ];
    for (const [name, path, header, want] of cases) {
      const res = await request(path, { header });
      ok(`${name} -> ${want}`, () => assert.equal(res.code, want));
    }
    const pre = await request("/api/health", { method: "OPTIONS" });
    ok("preflight CORS ditolak -> 403", () => assert.equal(pre.code, 403));
    ok("tidak ada header Access-Control-Allow-Origin", () =>
      assert.equal(healthy.headers["access-control-allow-origin"], undefined));
  }

  console.log(`\n${passed} lulus, ${failed} gagal\n`);
  if (failed) process.exit(1);
})();
