// server.js
import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import rateLimit from "express-rate-limit";
// Optional Stripe. Leave env empty to skip.
import Stripe from "stripe";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

app.use(morgan("tiny"));
app.use(express.json());
app.use(cors({ origin: true }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));
app.use(express.static(path.join(__dirname, "public")));

const SIGNS = [
  "aries","taurus","gemini","cancer","leo","virgo",
  "libra","scorpio","sagittarius","capricorn","aquarius","pisces"
];
const DAY_VALUES = ["today","tomorrow","yesterday"];
const LANGS = ["en","tr","es","dk"];

const cache = Object.create(null);

// Optional Stripe
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Simple in-memory users (replace with DB later)
const USERS = new Map(); // email -> { lang, sun, rising, birth, subscribed }

// Helpers
function addDays(date, n){ const d = new Date(date); d.setUTCDate(d.getUTCDate() + n); return d; }
function dayOffset(day){ return day === "yesterday" ? -1 : day === "tomorrow" ? 1 : 0; }
function dateFor(lang, day){
  const locales = { en: "en-GB", tr: "tr-TR", es: "es-ES", dk: "da-DK" };
  const tz = "Europe/Copenhagen";
  const target = addDays(new Date(), dayOffset(day));
  return new Intl.DateTimeFormat(locales[lang] || "en-GB", { timeZone: tz }).format(target);
}
function systemPrompt(lang){
  const tones = {
    en: "You are a professional astrologer for AstroVogue. Write ONLY in English. Keep it elegant, clear, and practical. No medical, legal, or financial claims.",
    tr: "AstroVogue için kıdemli bir astrologsun. YALNIZCA Türkçe yaz. Zarif, net ve uygulanabilir ol. Tıbbi, hukuki veya finansal iddiada bulunma.",
    es: "Eres astrólogo profesional de AstroVogue. Escribe SOLO en español. Elegante, claro y práctico. Sin afirmaciones médicas, legales ni financieras.",
    dk: "Du er professionel astrolog for AstroVogue. Skriv KUN på dansk. Elegant, klart og praktisk. Ingen medicinske, juridiske eller finansielle udsagn."
  };
  return tones[lang] || tones.en;
}
async function openaiJSON(system, user){
  if(!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
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
  if(!r.ok){
    const t = await r.text();
    throw new Error(`OpenAI ${r.status}: ${t.slice(0,200)}`);
  }
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

// Localized style detail fallback (no mixed language)
function fashionTip(color, mood, lang){
  const map = {
    en: {
      byColor: { Red:"Go for a bold accent. A red bag or lip is enough.", Blue:"Light blue or denim balances the day.", Green:"Natural textures echo inner calm.", Pink:"Soft pink details add warmth.", Black:"Keep a clean silhouette.", Gray:"Structured neutrals look sharp.", Grey:"Structured neutrals look sharp." },
      byMood: { Balanced:"Refined and pared back.", Energetic:"Blend sporty and chic.", Romantic:"Airy fabrics and pastels.", Calm:"Neutral tones and relaxed cuts." }
    },
    tr: {
      byColor: { Kırmızı:"Küçük bir kırmızı detay yeterli. Çanta ya da ruj.", Mavi:"Açık mavi veya denim denge sağlar.", Yeşil:"Doğal dokular huzur verir.", Pembe:"Yumuşak pembe sıcaklık katar.", Siyah:"Net siluetle güçlü görün.", Gri:"Yapılı nötrler şık durur." },
      byMood: { Dengeli:"Zarif ve yalın kal.", Enerjik:"Spor-şık karıştır.", Romantik:"Hafif kumaşlar ve pasteller.", Sakin:"Nötr tonlar ve rahat kesimler." }
    },
    es: {
      byColor: { Rojo:"Un detalle rojo basta. Bolso o labial.", Azul:"Azul claro o denim equilibra el día.", Verde:"Texturas naturales aportan calma.", Rosa:"Rosa suave añade calidez.", Negro:"Silueta limpia y firme.", Gris:"Neutros estructurados." },
      byMood: { Equilibrado:"Depurado y elegante.", Energético:"Mezcla sport y chic.", Romántico:"Tejidos ligeros y pasteles.", Sereno:"Neutros y cortes cómodos." }
    },
    dk: {
      byColor: { Rød:"Et lille rødt touch er nok. Taske eller læbe.", Blå:"Lyseblå eller denim giver balance.", Grøn:"Naturlige teksturer giver ro.", Lyserød:"Bløde lyserøde detaljer.", Sort:"Ren og stærk silhuet.", Grå:"Strukturerede neutrale toner." },
      byMood: { Balanceret:"Raffineret og enkelt.", Energisk:"Mix sporty og elegant.", Romantisk:"Let stof og pasteller.", Rolig:"Neutrale farver og afslappede snit." }
    }
  };
  const pack = map[lang];
  if(!pack) return "";
  if(color && pack.byColor[color]) return pack.byColor[color];
  if(mood && pack.byMood[mood]) return pack.byMood[mood];
  return "";
}

// Static image map per sign (put files in /public/img/)
const SIGN_IMAGES = Object.fromEntries(SIGNS.map(s => [s, `/img/${s}.jpg`]));

// DAILY
app.get("/api/daily", async (req, res) => {
  try {
    const sign = String(req.query.sign || "").toLowerCase();
    const day = String(req.query.day || "today").toLowerCase();
    const lang = String(req.query.lang || "en").toLowerCase();

    if(!SIGNS.includes(sign)) return res.status(400).json({ error: "Invalid sign" });
    if(!DAY_VALUES.includes(day)) return res.status(400).json({ error: "Invalid day" });
    if(!LANGS.includes(lang)) return res.status(400).json({ error: "Invalid lang" });

    const cacheKey = `daily:${sign}:${day}:${lang}`;
    if(cache[cacheKey]?.expiresAt > Date.now()){
      return res.json(cache[cacheKey].data);
    }

    const system = systemPrompt(lang);
    const user =
      JSON.stringify({ sign, day, lang }) +
      `
Return JSON with these keys only:
{ description, mood, color, compatibility, lucky_number, lucky_time, paragraph,
  fashion_tip, beauty_tip, style_advice, accessory_highlight, palette: [hex1,hex2,hex3] }
Short, specific, and stylish.`;

    const j = await openaiJSON(system, user);

    const payload = {
      brand: "AstroVogue",
      sign,
      lang,
      date: dateFor(lang, day),
      description: j.description || "",
      mood: j.mood || "",
      color: j.color || "",
      compatibility: j.compatibility || "",
      lucky_number: j.lucky_number || "",
      lucky_time: j.lucky_time || "",
      paragraph: j.paragraph || "",
      fashion_tip: j.fashion_tip || fashionTip(j.color, j.mood, lang),
      beauty_tip: j.beauty_tip || "",
      style_advice: j.style_advice || "",
      accessory_highlight: j.accessory_highlight || "",
      palette: Array.isArray(j.palette) && j.palette.length ? j.palette.slice(0,5) : [],
      image: SIGN_IMAGES[sign] || "/img/placeholder.jpg",
      affiliate: {
        url: "https://www.example.com/red-accessories?ref=astrovogue",
        label: lang === "tr" ? "Bu görünümü keşfet" :
               lang === "es" ? "Compra el look" :
               lang === "dk" ? "Shop looket" : "Shop the look"
      }
    };

    cache[cacheKey] = { data: payload, expiresAt: Date.now() + 20 * 60 * 1000 };
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PERSONALIZED
app.post("/api/personalized", async (req, res) => {
  try {
    const sun = String(req.body.sun || "").toLowerCase();
    const rising = String(req.body.rising || "").toLowerCase();
    const day = String(req.body.day || "today").toLowerCase();
    const lang = String(req.body.lang || "en").toLowerCase();

    if(!SIGNS.includes(sun)) return res.status(400).json({ error: "Invalid sun" });
    if(rising && !SIGNS.includes(rising)) return res.status(400).json({ error: "Invalid rising" });
    if(!DAY_VALUES.includes(day)) return res.status(400).json({ error: "Invalid day" });
    if(!LANGS.includes(lang)) return res.status(400).json({ error: "Invalid lang" });

    const system = systemPrompt(lang);
    const user =
      JSON.stringify({ sun, rising, day, lang }) +
      `
Return JSON with keys only:
{ summary, guidance, color, mood, compatibility, paragraph,
  fashion_tip, beauty_tip, style_advice, accessory_highlight, palette: [hex...] }`;

    const j = await openaiJSON(system, user);

    const payload = {
      brand: "AstroVogue",
      lang,
      date: dateFor(lang, day),
      sun,
      rising,
      summary: j.summary || "",
      guidance: j.guidance || "",
      color: j.color || "",
      mood: j.mood || "",
      compatibility: j.compatibility || "",
      paragraph: j.paragraph || "",
      fashion_tip: j.fashion_tip || fashionTip(j.color, j.mood, lang),
      beauty_tip: j.beauty_tip || "",
      style_advice: j.style_advice || "",
      accessory_highlight: j.accessory_highlight || "",
      palette: Array.isArray(j.palette) && j.palette.length ? j.palette.slice(0,5) : [],
      image: SIGN_IMAGES[sun] || "/img/placeholder.jpg",
      affiliate: {
        url: "https://www.example.com/red-accessories?ref=astrovogue",
        label: lang === "tr" ? "Bu görünümü keşfet" :
               lang === "es" ? "Compra el look" :
               lang === "dk" ? "Shop looket" : "Shop the look"
      }
    };

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Email capture
app.post("/api/subscribe", async (req, res) => {
  try {
    const { email, lang } = req.body || {};
    const ok = typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    if(!ok) return res.status(400).json({ error: "Invalid email" });
    USERS.set(email, { ...(USERS.get(email)||{}), lang: lang || "en", subscribed: true });
    console.log("New subscriber:", email, "lang:", lang || "en");
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Save chart data
app.post("/api/me/save-chart", async (req, res) => {
  const { email, lang="en", sun, rising, birth } = req.body || {};
  if(!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Invalid email" });
  USERS.set(email, { ...(USERS.get(email)||{}), lang, sun, rising, birth });
  res.json({ ok: true });
});

// Simple weekly alerts trigger (logs only)
app.post("/tasks/send-weekly-alerts", async (_req, res) => {
  try {
    for (const [email, profile] of USERS.entries()){
      const lang = profile.lang || "en";
      const sun = profile.sun || "aries";
      const system = systemPrompt(lang);
      const user = JSON.stringify({ weekly: true, sun, lang }) + "\nReturn JSON: { headline, focus, colors, tip }";
      const j = await openaiJSON(system, user);
      console.log("WEEKLY ALERT", email, j);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "job failed" });
  }
});

// Pricing checkout stub
app.post("/api/checkout/create-session", async (req, res) => {
  try{
    if(!stripe) return res.status(500).json({ error: "Stripe not configured" });
    const { email, priceId, successUrl, cancelUrl } = req.body || {};
    if(!priceId || !successUrl || !cancelUrl) return res.status(400).json({ error: "Missing params" });
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true
    });
    res.json({ url: session.url });
  }catch(e){ console.error(e); res.status(500).json({ error: "Stripe error" }); }
});

// Stripe webhook (optional)
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try{
    if(!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    // TODO: handle subscription events and persist to DB
    res.json({ received: true });
  }catch(e){ console.error(e); res.status(400).send("Webhook Error"); }
});

// Sign pages for SEO
function renderSignHTML(sign, lang, payload){
  const title = `AstroVogue | ${sign.toUpperCase()}`;
  const desc = payload?.description || "Daily style guidance.";
  return `<!doctype html><html lang="${lang}">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title><meta name="description" content="${desc}">
  <link rel="icon" href="/favicon.svg"></head>
  <body style="font-family:system-ui,-apple-system,Inter,Segoe UI,Roboto;margin:24px;max-width:760px">
    <a href="/" style="text-decoration:none">← AstroVogue</a>
    <h1>${sign.toUpperCase()} | ${payload?.date || ""}</h1>
    <p>${desc}</p>
    <img src="${payload?.image || "/img/placeholder.jpg"}" alt="${sign}" style="width:100%;border-radius:12px;margin:10px 0">
    <p>${payload?.paragraph || ""}</p>
    <p><a href="/" style="text-decoration:underline">Back to home</a></p>
  </body></html>`;
}
app.get("/daily/:sign", async (req, res) => {
  try{
    const sign = String(req.params.sign || "").toLowerCase();
    const lang = String(req.query.lang || "en").toLowerCase();
    if(!SIGNS.includes(sign) || !LANGS.includes(lang)) return res.redirect("/");
    const base = `${req.protocol}://${req.get("host")}`;
    const r = await fetch(`${base}/api/daily?sign=${sign}&day=today&lang=${lang}`);
    const data = await r.json();
    res.setHeader("Cache-Control","public, max-age=300");
    res.send(renderSignHTML(sign, lang, data));
  }catch(e){
    res.status(500).send(renderSignHTML(req.params.sign || "", "en", null));
  }
});

// robots + sitemap
app.get("/robots.txt", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.type("text/plain").send(`User-agent: *
Allow: /
Sitemap: ${base}/sitemap.xml
`);
});
app.get("/sitemap.xml", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const urls = ["/", ...SIGNS.map(s => `/daily/${s}`)];
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u=>`  <url><loc>${base}${u}</loc></url>`).join("\n")}
</urlset>`);
});

// health + root
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
