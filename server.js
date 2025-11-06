// server.js
import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(morgan("tiny"));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const SIGNS = [
  "aries","taurus","gemini","cancer","leo","virgo",
  "libra","scorpio","sagittarius","capricorn","aquarius","pisces"
];
const DAY_VALUES = ["today","tomorrow","yesterday"];
const LANGS = ["en","tr","es","dk"];

const cache = {}; // simple memory cache

// ---------------- utils ----------------
function addDays(date, n) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + n); return d; }
function dayOffset(day) { return day === "yesterday" ? -1 : day === "tomorrow" ? 1 : 0; }
function trDateFor(day) {
  const base = new Date();
  const target = addDays(base, dayOffset(day));
  return new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul" }).format(target);
}

function systemPrompt(lang) {
  const tones = {
    en: "You are a professional astrologer for AstroVogue. Write ONLY in natural English. Do not mix languages. Concise, elegant, trustworthy. No health claims.",
    tr: "AstroVogue için kıdemli bir astrologsun. YALNIZCA Türkçe yaz. Diller karışmasın. Kısa, zarif, güvenilir. Sağlık iddiası yok.",
    es: "Eres astrólogo profesional de AstroVogue. Escribe SOLO en español. No mezcles idiomas. Breve, elegante y confiable. Sin afirmaciones médicas.",
    dk: "Du er professionel astrolog for AstroVogue. Skriv KUN på dansk. Bland ikke sprog. Kort, elegant og troværdig. Ingen helbredsudsagn."
  };
  return tones[lang] || tones.en;
}

async function openaiJSON(system, user) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI ${r.status}: ${t.slice(0,200)}`);
  }
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

// no fallback text; if not found, return empty string
function fashionTip(color, mood, lang) {
  const map = {
    en: {
      byColor: {
        Gray: "Choose minimalist, structured tones.",
        Grey: "Choose minimalist, structured tones.",
        Blue: "Light blue or denim balances the day.",
        Red: "A small red accessory lifts your energy.",
        Green: "Natural textures echo inner calm.",
        Pink: "Soft pink details add warmth.",
        Black: "Keep a clean, strong silhouette."
      },
      byMood: {
        Balanced: "Stay refined and pared back.",
        Energetic: "Blend sporty and chic.",
        Romantic: "Airy fabrics and pastels work well.",
        Calm: "Neutral tones and relaxed cuts."
      }
    },
    tr: {
      byColor: {
        Gri: "Sade tonlar ve net kesimler seç.",
        Mavi: "Açık mavi veya denim denge sağlar.",
        Kırmızı: "Küçük bir kırmızı aksesuar enerji katar.",
        Yeşil: "Doğal dokular iç huzuru yansıtır.",
        Pembe: "Yumuşak pembe detaylar sıcaklık katar.",
        Siyah: "Temiz siluetle minimal ve güçlü görün."
      },
      byMood: {
        Dengeli: "Zarif ve yalın kal.",
        Enerjik: "Spor-şık parçaları karıştır.",
        Romantik: "Pastel ve ince kumaşlara yönel.",
        Sakin: "Nötr tonlar, rahat kesimler."
      }
    },
    es: {
      byColor: {
        Gris: "Tonos sobrios y cortes limpios.",
        Azul: "Azul claro o denim equilibra el día.",
        Rojo: "Un detalle rojo eleva la energía.",
        Verde: "Texturas naturales reflejan calma.",
        Rosa: "Detalles en rosa suave aportan calidez.",
        Negro: "Silueta limpia y poderosa."
      },
      byMood: {
        Equilibrado: "Mantén un estilo depurado.",
        Energético: "Mezcla sport y chic.",
        Romántico: "Tejidos ligeros y pasteles.",
        Sereno: "Tonos neutros y cortes cómodos."
      }
    },
    dk: {
      byColor: {
        Grå: "Vælg minimalistiske, rene snit.",
        Blå: "Lyseblå eller denim giver balance.",
        Rød: "Et lille rødt element giver energi.",
        Grøn: "Naturlige teksturer giver ro.",
        Lyserød: "Bløde lyserøde detaljer giver varme.",
        Sort: "Klar, stærk silhuet."
      },
      byMood: {
        Balanceret: "Hold det raffineret og enkelt.",
        Energisk: "Mix sporty og elegant.",
        Romantisk: "Lette stoffer og pasteller.",
        Rolig: "Neutrale farver og afslappede snit."
      }
    }
  };

  const pack = map[lang];
  if (!pack) return "";
  if (color && pack.byColor[color]) return pack.byColor[color];
  if (mood && pack.byMood[mood]) return pack.byMood[mood];
  return ""; // no fallback sentence to avoid repetition
}

// ---------------- routes ----------------

// Daily reading
app.get("/api/daily", async (req, res) => {
  try {
    const sign = String(req.query.sign || "").toLowerCase();
    const day = String(req.query.day || "today").toLowerCase();
    const lang = String(req.query.lang || "en").toLowerCase();

    if (!SIGNS.includes(sign)) return res.status(400).json({ error: "Invalid sign" });
    if (!DAY_VALUES.includes(day)) return res.status(400).json({ error: "Invalid day" });
    if (!LANGS.includes(lang)) return res.status(400).json({ error: "Invalid lang" });

    const cacheKey = `daily:${sign}:${day}:${lang}`;
    if (cache[cacheKey]?.expiresAt > Date.now()) return res.json(cache[cacheKey].data);

    const system = systemPrompt(lang);
    const user =
      JSON.stringify({ sign, day, lang }) +
      "\nReturn strict JSON with keys: { description, mood, color, compatibility, lucky_number, lucky_time, paragraph }." +
      "\nDo not include extra keys.";

    const j = await openaiJSON(system, user);

    const payload = {
      brand: "AstroVogue",
      sign,
      lang,
      date: trDateFor(day),
      description: j.description || "",
      mood: j.mood || "",
      color: j.color || "",
      compatibility: j.compatibility || "",
      lucky_number: j.lucky_number || "",
      lucky_time: j.lucky_time || "",
      paragraph: j.paragraph || "",
      fashion_tip: fashionTip(j.color, j.mood, lang) // may be empty by design
    };

    cache[cacheKey] = { data: payload, expiresAt: Date.now() + 30 * 60 * 1000 };
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Personalized reading
app.post("/api/personalized", async (req, res) => {
  try {
    const sun = String(req.body.sun || "").toLowerCase();
    const rising = String(req.body.rising || "").toLowerCase();
    const day = String(req.body.day || "today").toLowerCase();
    const lang = String(req.body.lang || "en").toLowerCase();

    if (!SIGNS.includes(sun)) return res.status(400).json({ error: "Invalid sun" });
    if (rising && !SIGNS.includes(rising)) return res.status(400).json({ error: "Invalid rising" });
    if (!DAY_VALUES.includes(day)) return res.status(400).json({ error: "Invalid day" });
    if (!LANGS.includes(lang)) return res.status(400).json({ error: "Invalid lang" });

    const system = systemPrompt(lang);
    const user =
      JSON.stringify({ sun, rising, day, lang }) +
      "\nReturn strict JSON with keys: { summary, guidance, color, mood, compatibility, paragraph }." +
      "\nDo not include extra keys.";

    const j = await openaiJSON(system, user);

    const payload = {
      brand: "AstroVogue",
      lang,
      date: trDateFor(day),
      sun,
      rising,
      summary: j.summary || "",
      guidance: j.guidance || "",
      color: j.color || "",
      mood: j.mood || "",
      compatibility: j.compatibility || "",
      paragraph: j.paragraph || "",
      fashion_tip: fashionTip(j.color, j.mood, lang) // may be empty by design
    };

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// root
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
