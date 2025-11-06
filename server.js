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
const TR_SIGN = {
  aries: "Koç", taurus: "Boğa", gemini: "İkizler", cancer: "Yengeç",
  leo: "Aslan", virgo: "Başak", libra: "Terazi", scorpio: "Akrep",
  sagittarius: "Yay", capricorn: "Oğlak", aquarius: "Kova", pisces: "Balık"
};

const cache = {};

function addDays(date, n) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + n); return d; }
function dayOffset(day) {
  if (day === "yesterday") return -1;
  if (day === "tomorrow") return 1;
  return 0;
}
function trDateFor(day) {
  const base = new Date();
  const target = addDays(base, dayOffset(day));
  return new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul" }).format(target);
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
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

// --- Utility: choose base text per language ---
function systemPrompt(lang, type="daily") {
  const tone = "Professional astrologer voice, concise, elegant, trustworthy.";
  const tones = {
    en: `${tone} Write in natural English.`,
    tr: `AstroVogue için kıdemli astrologsun. Türkçe yaz. Ton net, sakin, profesyonel.`,
    es: `Eres un astrólogo profesional para AstroVogue. Escribe en español, tono elegante y confiable.`,
    dk: `Du er en professionel astrolog for AstroVogue. Skriv på dansk, kort og tillidsvækkende tone.`
  };
  return tones[lang] || tones["en"];
}

function fashionTip(color, mood) {
  const tipsByColor = {
    Gray: "Choose minimalist, structured tones.",
    Grey: "Choose minimalist, structured tones.",
    "Gri": "Sade tonlar ve net kesimler seç.",
    "Azul": "Elige tonos azules o denim para equilibrio.",
    "Blå": "Vælg blå nuancer for ro.",
    "Rojo": "Un toque rojo aporta energía.",
    "Rød": "Et rødt tilbehør giver energi."
  };
  return tipsByColor[color] || "Keep it elegant and balanced.";
}

// --- DAILY ---
app.get("/api/daily", async (req, res) => {
  try {
    const sign = String(req.query.sign || "").toLowerCase();
    const day = String(req.query.day || "today").toLowerCase();
    const lang = String(req.query.lang || "en").toLowerCase();
    if (!SIGNS.includes(sign)) return res.status(400).json({ error: "Invalid sign." });
    if (!DAY_VALUES.includes(day)) return res.status(400).json({ error: "Invalid day." });
    if (!LANGS.includes(lang)) return res.status(400).json({ error: "Invalid lang." });

    const cacheKey = `daily:${sign}:${day}:${lang}`;
    if (cache[cacheKey]?.expiresAt > Date.now()) return res.json(cache[cacheKey].data);

    const system = systemPrompt(lang, "daily");
    const user =
      JSON.stringify({ sign, day, lang }) +
      "\nReturn JSON with { description, mood, color, compatibility, lucky_number, lucky_time, paragraph }.";

    let j = await openaiJSON(system, user);

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
      fashion_tip: fashionTip(j.color, j.mood)
    };

    cache[cacheKey] = { data: payload, expiresAt: Date.now() + 30 * 60 * 1000 };
    res.json(payload);
  } catch (err) {
    console.error(err.message);
    res.json({ error: "Server error" });
  }
});

// --- PERSONALIZED ---
app.post("/api/personalized", async (req, res) => {
  try {
    const sun = String(req.body.sun || "").toLowerCase();
    const rising = String(req.body.rising || "").toLowerCase();
    const day = String(req.body.day || "today").toLowerCase();
    const lang = String(req.body.lang || "en").toLowerCase();
    if (!SIGNS.includes(sun)) return res.status(400).json({ error: "Invalid sun." });
    if (rising && !SIGNS.includes(rising)) return res.status(400).json({ error: "Invalid rising." });

    const system = systemPrompt(lang, "personalized");
    const user =
      JSON.stringify({ sun, rising, day, lang }) +
      "\nReturn JSON with { summary, guidance, color, mood, compatibility, paragraph }.";

    let j = await openaiJSON(system, user);
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
      fashion_tip: fashionTip(j.color, j.mood)
    };

    res.json(payload);
  } catch (err) {
    console.error(err.message);
    res.json({ error: "Server error" });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
