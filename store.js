const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, "bot.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS products (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    price INTEGER NOT NULL,
    desc  TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS warns (
    jid    TEXT NOT NULL,
    target TEXT NOT NULL,
    count  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (jid, target)
  );
`);

function seedProducts() {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM products").get();
  if (c > 0) return;
  const seed = [
    ["burger", "🍔 Burger", 25000, "Daging sapi + keju"],
    ["pizza", "🍕 Pizza", 45000, "Ukuran medium"],
    ["taco", "🌮 Taco", 20000, "Khas Meksiko"],
    ["esteh", "🥤 Es Teh", 5000, "Teh manis dingin"],
    ["kopi", "☕ Kopi", 10000, "Kopi susu gula aren"],
  ];
  const ins = db.prepare("INSERT INTO products (id, name, price, desc) VALUES (?,?,?,?)");
  for (const [id, name, price, desc] of seed) ins.run(id, name, price, desc);
}
seedProducts();

// ---- generic KV (welcome, antilink, channels) ----
const kvGet = (key, fallback) => {
  const r = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return r ? JSON.parse(r.value) : fallback;
};
const kvSet = (key, value) =>
  db
    .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));

// ---- products ----
const productsAll = () => db.prepare("SELECT id, name, price, desc FROM products ORDER BY rowid").all();
const productAdd = ({ id, name, price, desc }) =>
  db
    .prepare("INSERT INTO products (id, name, price, desc) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, price = excluded.price, desc = excluded.desc")
    .run(id, name, price, desc || "").changes;
const productDel = (id) => db.prepare("DELETE FROM products WHERE id = ?").run(id).changes;

// ---- warns ----
const warnGet = (jid, target) =>
  db.prepare("SELECT count FROM warns WHERE jid = ? AND target = ?").get(jid, target)?.count || 0;
const warnInc = (jid, target) =>
  db
    .prepare("INSERT INTO warns (jid, target, count) VALUES (?,?,1) ON CONFLICT(jid, target) DO UPDATE SET count = count + 1")
    .run(jid, target).changes;
const warnSet = (jid, target, count) =>
  db
    .prepare("INSERT INTO warns (jid, target, count) VALUES (?,?,?) ON CONFLICT(jid, target) DO UPDATE SET count = excluded.count")
    .run(jid, target, count).changes;
const warnDel = (jid, target) => db.prepare("DELETE FROM warns WHERE jid = ? AND target = ?").run(jid, target).changes;
const warnsAll = (jid) => db.prepare("SELECT target, count FROM warns WHERE jid = ? ORDER BY count DESC").all(jid);

module.exports = {
  dbPath,
  kvGet,
  kvSet,
  productsAll,
  productAdd,
  productDel,
  warnGet,
  warnInc,
  warnSet,
  warnDel,
  warnsAll,
};