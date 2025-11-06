import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { setTimeout as wait } from "timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(morgan("tiny"));

const PORT = process.env.PORT || 3000;

// serve the static site
app.use(express.static(path.join(__dirname, "public")));

const cache = {};
const SIGNS = [
  "aries","taurus","gemini","cancer","leo","virgo",
  "libra","scorpio","sagittarius","capricorn","aquarius","pisces"
];
const DAY_VALUES = ["today","tomorrow","yesterday"];

const TR_SIGN = {
  aries: "Koç", taurus: "Boğa", gemini: "İkizler", cancer: "Yengeç",
  leo: "Aslan", virgo: "Başak", libra: "Terazi", scorpio: "Akrep",
  sagittarius: "Yay", capricorn: "Oğlak", aquarius: "Kova", pisces: "Balık"
};

function buildAnalysis(trSign, payload) {
  const parts = [];
  if (payload?.description) parts.push(payload.description.trim());
  if (payload?.compatibility) parts.push(`Uyum: ${payload.compatibility}`);
  if (payload?.mood) parts.push(`Ruh hali: ${payload.mood}`);
  if (payload?.color) parts.push(`Günün rengi: ${payload.color}`);
  if (payload?.lucky_number) parts.push(`Şanslı sayı: ${payload.lucky_number}`);
  if (payload?.lucky_time) parts.push(`Şanslı zaman: ${payload.lucky_time}`);
  return `${trSign} için kısa analiz: ${parts.join(" • ")}`;
}

// retry with headers so the free endpoint behaves
async function getAztro(sign, day) {
  const url = `https://aztro.sameerkumar.website/?sign=${sign}&day=${day}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": "AstroReader/1.0 (+https://example.com)",
          "Accept": "application/json"
        }
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Aztro ${res.status}: ${text.slice(0, 160)}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      await wait(300 * attempt);
    }
  }
  throw lastErr || new Error("Unknown Aztro error");
}

app.get("/api/daily", async (req, res) => {
  try {
    const sign = String(req.query.sign || "").toLowerCase();
    const day = String(req.query.day || "today").toLowerCase();

    if (!SIGNS.includes(sign)) {
      return res.status(400).json({ error: "Geçersiz burç." });
    }
    if (!DAY_VALUES.includes(day)) {
      return res.status(400).json({ error: "Geçersiz gün." });
    }

    const cacheKey = `${sign}:${day}`;
    const now = Date.now();
    const hit = cache[cacheKey];
    if (hit && hit.expiresAt > now) {
      return res.json(hit.data);
    }

    let data;
    try {
      data = await getAztro(sign, day);
    } catch (e) {
      console.error("Aztro call failed:", e.message);
      // soft fallback so UI still shows something
      data = {
        current_date: new Date().toLocaleDateString("tr-TR"),
        description: "Bugün enerjini yüksek tut. Basit hedeflerle ilerlemek en iyisi.",
        compatibility: "Yengeç",
        mood: "Dengeli",
        color: "Gri",
        lucky_number: "4",
        lucky_time: "14:00"
      };
    }

    const payload = {
      burc: TR_SIGN[sign],
      gun: day,
      tarih: data?.current_date || null,
      aciklama: data?.description || "",
      uyum: data?.compatibility || "",
      ruh_hali: data?.mood || "",
      renk: data?.color || "",
      sansli_sayi: data?.lucky_number || "",
      sansli_saat: data?.lucky_time || "",
      analiz: buildAnalysis(TR_SIGN[sign], data),
      raw: data
    };

    cache[cacheKey] = { data: payload, expiresAt: now + 30 * 60 * 1000 };
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// root serves the UI file
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
