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
    throw new Error(`OpenAI ${r.status}: ${t.slice(0,160)}`);
  }
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

function fashionTip(color, mood) {
  const tipsByColor = {
    "Gri": "Sade tonlar ve net kesimler seç.",
    "Mavi": "Açık mavi veya denim dengeleme sağlar.",
    "Kırmızı": "Küçük bir kırmızı aksesuar enerji katar.",
    "Yeşil": "Doğal tonlar iç huzuru yansıtır.",
    "Pembe": "Yumuşak detaylarla sıcaklık ekle.",
    "Siyah": "Minimal ve güçlü bir siluet uygula."
  };
  const tipsByMood = {
    "Dengeli": "Zarif ve yalın kal.",
    "Enerjik": "Spor-şık parçaları karıştır.",
    "Romantik": "Pastel dokulara yönel.",
    "Sakin": "Nötr ve rahat kesimler kullan."
  };
  return tipsByColor[color] || tipsByMood[mood] || "Zarif bir aksesuar ekle.";
}

// ---------- DAILY: OpenAI-only ----------
app.get("/api/daily", async (req, res) => {
  try {
    const sign = String(req.query.sign || "").toLowerCase();
    const day = String(req.query.day || "today").toLowerCase();
    if (!SIGNS.includes(sign)) return res.status(400).json({ error: "Geçersiz burç." });
    if (!DAY_VALUES.includes(day)) return res.status(400).json({ error: "Geçersiz gün." });

    const cacheKey = `daily:${sign}:${day}`;
    if (cache[cacheKey]?.expiresAt > Date.now()) return res.json(cache[cacheKey].data);

    const system =
      "AstroVogue için kıdemli bir astrologsun. Türkçe yaz. Ton net, sakin, profesyonel. " +
      "Kısa cümleler. Kaderci söylem yok. Sağlık ve tıbbi iddialar yok. " +
      "Gerçekçi günlük yönlendirme ver. Sadece istenen alanları döndür.";

    const user =
      JSON.stringify({
        tur: "gunluk",
        gun: day,
        gunes: TR_SIGN[sign]
      }) +
      "\n" +
      "Sadece şu JSON anahtarlarını üret: " +
      "{ aciklama, ruh_hali, renk, uyum, sansli_sayi, sansli_saat, analiz }. " +
      "Her alan 1 cümle, analiz 1-2 cümle olsun.";

    let j = await openaiJSON(system, user);
    j.renk = j.renk || "Gri";
    j.ruh_hali = j.ruh_hali || "Dengeli";

    const payload = {
      marka: "AstroVogue",
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

    cache[cacheKey] = { data: payload, expiresAt: Date.now() + 30 * 60 * 1000 };
    res.json(payload);
  } catch (err) {
    console.error(err.message);
    res.json({
      marka: "AstroVogue",
      burc: TR_SIGN[String(req.query.sign||"").toLowerCase()] || "—",
      gun: req.query.day || "today",
      tarih: new Date().toLocaleDateString("tr-TR"),
      aciklama: "Günü basit planla ve iletişimde net ol.",
      uyum: "Yengeç",
      ruh_hali: "Dengeli",
      renk: "Gri",
      sansli_sayi: "4",
      sansli_saat: "14:00",
      analiz: "Odak dağılmasın. Sakin ilerle.",
      moda_onerisi: "Sade tonlar ve net kesimler seç."
    });
  }
});

// ---------- PERSONALIZED: sun + rising + pro-astrologer tone ----------
app.post("/api/personalized", async (req, res) => {
  try {
    const sun = String(req.body.sun || "").toLowerCase();
    const rising = String(req.body.rising || "").toLowerCase();
    const day = String(req.body.day || "today").toLowerCase();
    if (!SIGNS.includes(sun)) return res.status(400).json({ error: "Geçersiz güneş burcu." });
    if (rising && !SIGNS.includes(rising)) return res.status(400).json({ error: "Geçersiz yükselen burç." });
    if (!DAY_VALUES.includes(day)) return res.status(400).json({ error: "Geçersiz gün." });

    const system =
      "AstroVogue için kıdemli bir astrologsun. Türkçe yaz. Net, ölçülü, güvenilir ton. " +
      "Güneş ve yükseleni birlikte düşün. Somut yönlendirme ver. " +
      "Sağlık iddiası yok. Abartı yok. Sadece istenen alanları döndür.";

    const userObj = {
      tur: "kisisel",
      gun: day,
      gunes: TR_SIGN[sun],
      yukselen: rising ? TR_SIGN[rising] : null
      // ileride: dogum verisi ve harita özetleri eklenecek
    };
    const user =
      JSON.stringify(userObj) +
      "\n" +
      "Sadece şu JSON anahtarlarını üret: " +
      "{ odak, rehber, stil, aciklama, ruh_hali, renk, uyum }. " +
      "odak bir kelime ya da kısa ifade. rehber 2-3 cümle. stil 1 cümle.";

    let j = await openaiJSON(system, user);
    j.renk = j.renk || "Gri";
    j.ruh_hali = j.ruh_hali || "Dengeli";

    res.json({
      marka: "AstroVogue",
      tarih: new Date().toLocaleDateString("tr-TR"),
      gunes: TR_SIGN[sun],
      yukselen: rising ? TR_SIGN[rising] : null,
      aciklama: j.aciklama || "",
      ruh_hali: j.ruh_hali,
      renk: j.renk,
      uyum: j.uyum || "",
      odak: j.odak || "Genel",
      rehber: j.rehber || "Planı sade tut ve net ol.",
      stil: j.stil || fashionTip(j.renk, j.ruh_hali)
    });
  } catch (err) {
    console.error(err.message);
    res.json({
      marka: "AstroVogue",
      tarih: new Date().toLocaleDateString("tr-TR"),
      gunes: TR_SIGN[String(req.body.sun||"").toLowerCase()] || "—",
      yukselen: req.body.rising ? TR_SIGN[String(req.body.rising).toLowerCase()] : null,
      aciklama: "Bugün sade hedeflerle ilerle.",
      ruh_hali: "Dengeli",
      renk: "Gri",
      uyum: "Yengeç",
      odak: "Genel",
      rehber: "Net plan yap, küçük adımlar at.",
      stil: "Minimal bir siluet ve tek güçlü aksesuar."
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
