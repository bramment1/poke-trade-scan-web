import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database("data.db");
db.pragma("journal_mode = WAL");

// Create tables
db.prepare(`
CREATE TABLE IF NOT EXISTS cards_master (
  cardId TEXT PRIMARY KEY,
  setId TEXT NOT NULL,
  number TEXT NOT NULL,
  name TEXT,
  createdAt INTEGER NOT NULL
);
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS user_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  cardId TEXT NOT NULL,
  condition TEXT DEFAULT 'NM',
  status TEXT DEFAULT 'hidden',
  price REAL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY(cardId) REFERENCES cards_master(cardId)
);
`).run();

function now() {
  return Date.now();
}
function num(v) {
  return typeof v === "number" && !Number.isNaN(v) ? v : v == null ? null : Number(v);
}
function isNum(v) {
  return typeof v === "number" && !Number.isNaN(v);
}
function round2(x) {
  return Math.round(x * 100) / 100;
}
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((a,b) => a - b);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : round2((a[m-1] + a[m]) / 2);
}

const POKEMONTCG_API_KEY = process.env.POKEMONTCG_API_KEY || "";
const USD_EUR_RATE = Number(process.env.USD_EUR_RATE || "0.92");

// Price endpoint
app.post("/api/price", async (req, res) => {
  try {
    const { setId, number, variant = "normal" } = req.body || {};
    if (!setId || !number) {
      return res.status(400).json({ error: "Missing setId or number" });
    }
    const q = encodeURIComponent(`set.id:${setId} number:${number}`);
    const url = `https://api.pokemontcg.io/v2/cards?q=${q}`;
    const resp = await fetch(url, {
      headers: POKEMONTCG_API_KEY ? { "X-Api-Key": POKEMONTCG_API_KEY } : {},
    });
    if (!resp.ok) {
      return res.status(502).json({ error: `PokémonTCG error ${resp.status}` });
    }
    const data = await resp.json();
    const card = data?.data?.[0];
    if (!card) {
      return res.json({
        estimateEUR: null,
        rangeEUR: [null, null],
        n: 0,
        bySource: {},
        confidence: "low",
      });
    }
    const cm = card.cardmarket?.prices || {};
    const cmTrend = num(cm.trendPrice);
    const cmLow = num(cm.lowPrice);
    const cmUpdated = card.cardmarket?.updatedAt || null;

    const tpAll = card.tcgplayer?.prices || {};
    const tpVar = tpAll[variant] || tpAll["normal"] || tpAll["holofoil"] || tpAll["reverseHolofoil"] || {};
    const tpMarketUSD = num(tpVar.market);
    const tpLowUSD = num(tpVar.low);
    const tpMarketEUR = tpMarketUSD != null ? round2(tpMarketUSD * USD_EUR_RATE) : null;
    const tpLowEUR = tpLowUSD != null ? round2(tpLowUSD * USD_EUR_RATE) : null;

    const candidates = [cmTrend, tpMarketEUR].filter(isNum);
    const estimate = median(candidates);
    const lowVals = [cmLow, tpLowEUR].filter(isNum);
    const low = lowVals.length ? Math.min(...lowVals) : (candidates.length ? Math.min(...candidates) : null);
    const highCandidates = [cmTrend, tpMarketEUR].filter(isNum);
    const high = highCandidates.length ? Math.max(...highCandidates) : (isNum(low) ? round2(low * 1.2) : null);
    const n = candidates.length;
    const confidence = n >= 2 ? "high" : n === 1 ? "medium" : "low";

    res.json({
      estimateEUR: estimate ?? null,
      rangeEUR: [low ?? null, high ?? null],
      n,
      bySource: {
        ...(cmTrend != null || cmLow != null
          ? { cardmarket: { trend: cmTrend, low: cmLow, updatedAt: cmUpdated } }
          : {}),
        ...((tpMarketEUR != null || tpLowEUR != null)
          ? {
              tcgplayer: {
                marketEUR: tpMarketEUR,
                lowEUR: tpLowEUR,
                rawUSD: { market: tpMarketUSD, low: tpLowUSD },
              },
            }
          : {}),
      },
      confidence,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal error" });
  }
});

// Add to collection and upsert card
app.post("/api/cards", (req, res) => {
  const { username, setId, number, name = null, condition = "NM", status = "hidden", price = null } = req.body || {};
  if (!username || !setId || !number) {
    return res.status(400).json({ error: "Missing fields" });
  }
  const cardId = `${setId}:${String(number).trim()}`;
  const exists = db.prepare("SELECT 1 FROM cards_master WHERE cardId = ?").get(cardId);
  if (!exists) {
    db.prepare("INSERT INTO cards_master (cardId, setId, number, name, createdAt) VALUES (?, ?, ?, ?, ?)").run(cardId, setId, String(number), name, now());
  } else if (name) {
    db.prepare("UPDATE cards_master SET name = COALESCE(name, ?) WHERE cardId = ?").run(name, cardId);
  }
  db.prepare(`
    INSERT INTO user_cards (username, cardId, condition, status, price, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(username, cardId, condition, status, price, now());
  res.json({ ok: true, cardId });
});

// Search cards
app.get("/api/search", (req, res) => {
  const { q = "", setId = "", status = "" } = req.query;
  const like = `%${String(q).toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT c.cardId, c.setId, c.number, COALESCE(c.name, '') AS name,
           SUM(CASE WHEN uc.status != 'hidden' THEN 1 ELSE 0 END) AS listings
    FROM cards_master c
    LEFT JOIN user_cards uc ON uc.cardId = c.cardId
    WHERE (LOWER(c.number) LIKE ? OR LOWER(COALESCE(c.name,'')) LIKE ? OR LOWER(c.setId) LIKE ?)
      AND (? = '' OR c.setId = ?)
      AND (? = '' OR uc.status = ?)
    GROUP BY c.cardId
    ORDER BY listings DESC, c.setId, c.number
   LIMIT 100
  `).all(like, like like, setId, setId, status, status);
  res.json(rows);
});

// Card detail
app.get("/api/card/:cardId", (req, res) => {
  const { cardId } = req.params;
  const card = db.prepare("SELECT * FROM cards_master WHERE cardId = ?").get(cardId);
  if (!card) {
    return res.status(404).json({ error: "Not found" });
  }
  const offers = db.prepare(`
    SELECT id, username, condition, status, price, updatedAt
    FROM user_cards
    WHERE cardId = ? AND status != 'hidden'
   ORDER BY (CASE status WHEN 'sale' THEN 1 WHEN 'both' THEN 2 WHEN 'trade' THEN 3 ELSE 4 END), price
  `).all(cardId);  res.json({ card, offers });
});

// Serve index.html for other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
