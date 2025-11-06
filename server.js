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
const TR_SIGN = {
  aries: "Koç", taurus: "Boğa", gemini: "İkizler", cancer: "Yengeç",
  leo: "Aslan", virgo: "Başak", libra: "Terazi", scorpio: "Akrep",
  sagittarius: "Yay", capricorn: "Oğlak", aquarius: "Kova", pisces: "Balık"
};

const cache = {}; // { key: { data, expiresAt } }

// ---------- OpenAI helpers ----------
async function openaiJSON(system, user) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is missing");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text.slice(0,160)}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

function fashionTip(color, mood) {
  const tipsByColor = {
    "Gri": "Sade tonlar ve temiz kesimler sofistike bir hava verir.",
    "Mavi": "Açık mavi gömlek ya da denim günün ritmini dengeler.",
    "Kırmızı": "Küçük bir kırmızı aksesuar enerjiyi yükseltir.",
    "Yeşil": "Doğal tonlar ve dokular iç huzuru yansıtır.",
    "Pembe": "Yumuşak pembe detaylar sıcaklık katar.",
    "Siyah": "Net bir siluetle minimal ve güçlü görün."
  };
  const tipsByMood = {
    "Dengeli": "Minimal ama zarif bir görünüm seç.",
    "Enerjik": "Spor-şık parçalar ritmine uyum sağlar.",
    "Romantik": "İnce kumaşlar ve pastel tonlar ruh haline iyi gelir.",
    "Sakin": "Nötr tonlar ve rahat kesimler konfor sağlar."
  };
  return tipsByColor[color] || tipsByMood[mood] || "Zarif bir aksesuar ekle ve sade kal.";
}

// ---------- Routes ----------

// OpenAI-only daily by sun sign
app.get("/api/daily", async (req, res) => {
  try {
    const sign = String(req.query.sign || "").toLowerCase();
    const day = String(req.query.day || "today").toLowerCase();
    if (!SIGNS.includes(sign)) return res.status(400).json({ error: "Geçersiz burç." });
    if (!DAY_VALUES.includes(day)) return res.status(400).json({ error: "Geçersiz gün." });

    const cacheKey = `daily:${sign}:${day}`;
    const now = Date.now();
    if (cache[cacheKey]?.expiresAt > now) return res.json(cache[cacheKey].data);

    const system = "Rolün AstroVogue editörü. Türkçe, sakin ve premium yaz. Abartı yok. Kısa, net ve güven verici ol.";
    const user = JSON.stringify({
      tur: "gunluk",
      gun: day,
      gunes: TR_SIGN[sign],
      alanlar: ["aciklama","ruh_hali","renk","uyum","sansli_sayi","sansli_saat","analiz"]
    }) + "\n" + [
      "Yalnızca aşağıdaki JSON anahtarlarını üret:",
      "{ aciklama, ruh_hali, renk, uyum, sansli_sayi, sansli_saat, analiz }",
      "hepsi kısa ve doğal cümleler olsun"
    ].join("\n");

    let j = await openaiJSON(system, user);

    // safety defaults
    j.renk = j.renk || "Gri";
    j.ruh_hali = j.ruh_hali || "Dengeli";

    const payload = {
      burc: TR_SIGN[sign],
      gun: day,
      tarih: new Date().toLocaleDateString("tr-TR"),
      aciklama: j.aciklama || "",
      uyum: j.uyum || "",
      ruh_hali: j.ruh_hali,
      renk: j.renk,
      sansli_sayi: j.sansli_sayi || "",
      sansli_saat: j.sansli_saat || "",
      analiz: j.analiz || "",
      moda_onerisi: fashionTip(j.renk, j.ruh_hali)
    };

    cache[cacheKey] = { data: payload, expiresAt: now + 30 * 60 * 1000 };
    res.json(payload);
  } catch (err) {
    console.error(err.message);
    // graceful fallback so UI never breaks
    res.json({
      burc: TR_SIGN[String(req.query.sign||"").toLowerCase()] || "—",
      gun: req.query.day || "today",
      tarih: new Date().toLocaleDateString("tr-TR"),
      aciklama: "Bugün enerjini dengede tut. Küçük adımlar en verimlisi.",
      uyum: "Yengeç",
      ruh_hali: "Dengeli",
      renk: "Gri",
      sansli_sayi: "4",
      sansli_saat: "14:00",
      analiz: "Günü sade planla, net iletişim kur. Akışa izin ver.",
      moda_onerisi: "Sade tonlar ve temiz kesimler sofistike bir hava verir."
    });
  }
});

// Personalized with sun + rising + optional birth placeholders
app.post("/api/personalized", async (req, res) => {
  try {
    const sun = String(req.body.sun || "").toLowerCase();
    const rising = String(req.body.rising || "").toLowerCase();
    const day = String(req.body.day || "today").toLowerCase();
    if (!SIGNS.includes(sun)) return res.status(400).json({ error: "Geçersiz güneş burcu." });
    if (rising && !SIGNS.includes(rising)) return res.status(400).json({ error: "Geçersiz yükselen burç." });
    if (!DAY_VALUES.includes(day)) return res.status(400).json({ error: "Geçersiz gün." });

    const system = "Rolün AstroVogue editörü. Türkçe, sakin ve premium yaz. Kısa, net, güven verici.";
    const userObj = {
      tur: "kisisel",
      gun: day,
      gunes: TR_SIGN[sun],
      yukselen: rising ? TR_SIGN[rising] : null,
      // ileride gerçek doğum verisi ve harita özetleri buraya eklenecek
      dogum: req.body.birth || null
    };
    const user = JSON.stringify(userObj) + "\n" + [
      "Sadece şu JSON anahtarlarını üret:",
      "{ odak, rehber, stil, aciklama, ruh_hali, renk, uyum }",
      "odak: günün teması. rehber: 2-3 cümle yönlendirme.",
      "stil: 1 cümle moda önerisi. Diğer alanlar kısa olmalı."
    ].join("\n");

    let j = await openaiJSON(system, user);

    j.renk = j.renk || "Gri";
    j.ruh_hali = j.ruh_hali || "Dengeli";

    res.json({
      tarih: new Date().toLocaleDateString("tr-TR"),
      gunes: TR_SIGN[sun],
      yukselen: rising ? TR_SIGN[rising] : null,
      aciklama: j.aciklama || "",
      ruh_hali: j.ruh_hali,
      renk: j.renk,
      uyum: j.uyum || "",
      odak: j.odak || "Genel",
      rehber: j.rehber || "Planı sade tut ve iletişimde net ol.",
      stil: j.stil || fashionTip(j.renk, j.ruh_hali)
    });
  } catch (err) {
    console.error(err.message);
    res.json({
      tarih: new Date().toLocaleDateString("tr-TR"),
      gunes: TR_SIGN[String(req.body.sun||"").toLowerCase()] || "—",
      yukselen: req.body.rising ? TR_SIGN[String(req.body.rising).toLowerCase()] : null,
      aciklama: "Bugün sade hedeflerle ilerle.",
      ruh_hali: "Dengeli",
      renk: "Gri",
      uyum: "Yengeç",
      odak: "Genel",
      rehber: "Net plan yap, küçük adımlar at.",
      stil: "Minimal bir siluet ve tek güçlü aksesuar uygula."
    });
  }
});

// root
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
