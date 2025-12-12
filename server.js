// server.js
// Sulama Asistanı backend

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");
const PDFDocument = require("pdfkit");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

const app = express();

// ------------------------------------------------------
// Session + Passport (Google OAuth için)
// ------------------------------------------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "sulama-secret",
    resave: false,
    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Kullanıcıyı session'a yaz / geri al
passport.serializeUser((user, done) => {
  done(null, user.email);
});

passport.deserializeUser((email, done) => {
  const users = loadUsers();
  const u = users.find((x) => x.email === email);
  done(null, u || null);
});


// ------------------------------------------------------
// Body parser + statik dosyalar
// ------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------------------
// SAYFA ROUTELARI (LOGIN / REGISTER)
// ------------------------------------------------------
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/register", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ------------------------------------------------------
// Sabitler & Dosyalar
// ------------------------------------------------------
const USERS_FILE = path.join(__dirname, "users.json");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
// Fiyat listesi tek kaynak: price_list.json
// Render'da genelde /data altında; local testte bazen proje kökünde olabiliyor.
const PRICE_LIST_FILE =
  process.env.PRICE_LIST_FILE || path.join(__dirname, "data", "price_list.json");

// Yanıt adımlama (step controller)
// ------------------------------------------------------
const STEP_CONTROLLER = {
  // Model gerektiğinde uzun cümle kurabilsin diye tavan yüksek kalsın,
  // asıl kısaltmayı prompt ile yapıyoruz.
  maxTokens: 900,
  chunkSize: 120,
  pauseMs: 0,
};

// ------------------------------------------------------
// Yardımcı fonksiyonlar
// ------------------------------------------------------
function parseQuantityFromText(message) {
  const t = String(message || "").toLowerCase();

  const patterns = [
    /(\d+)\s*(adet|tane|pcs|pc)\b/, // 20 adet
    /\bx\s*(\d+)\b/,               // x20
    /\b(\d+)\s*x\b/,               // 20x
    /\b(adet|tane)\s*(\d+)\b/      // adet 20
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      const num = m.find(v => /^\d+$/.test(v));
      if (num) {
        const q = parseInt(num, 10);
        if (Number.isFinite(q) && q > 0) return q;
      }
    }
  }
  return 1;
}


// ------------------------------------------------------

// Kullanıcı verisini oku
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    console.error("Kullanıcılar okunamadı:", e);
    return [];
  }
}

// Kullanıcı verisini kaydet
function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (e) {
    console.error("Kullanıcılar kaydedilemedi:", e);
  }
}

// PRICE_LIST'i belleğe al
let PRICE_LIST = [];
function loadPriceList() {
  try {
    let filePath = PRICE_LIST_FILE;

    // fallback: proje kökünde price_list.json varsa onu da dene
    if (!fs.existsSync(filePath)) {
      const alt = path.join(__dirname, "price_list.json");
      if (fs.existsSync(alt)) filePath = alt;
    }

    if (!fs.existsSync(filePath)) {
      console.warn(
        "price_list.json bulunamadı. (data/price_list.json veya ./price_list.json)"
      );
      PRICE_LIST = [];
      return;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    PRICE_LIST = JSON.parse(raw || "[]");
    console.log(`PRICE_LIST yüklendi, ürün sayısı: ${PRICE_LIST.length}`);
  } catch (e) {
    console.error("price_list.json okunamadı:", e);
    PRICE_LIST = [];
  }
}

loadPriceList();


// ------------------------------------------------------
// Fiyat listesi / tablo modu (kısıtları bypass eder, server-side tablo üretir)
// ------------------------------------------------------
const PRICE_TABLE_DEFAULT_PAGE_SIZE = 20;

function isPriceListTableRequest(message) {
  const t = String(message || "").toLowerCase().trim();
  if (!t) return false;

  // "sonraki 20", "önceki", "sayfa 2" gibi komutları da tablo modu say
  if (
    t.startsWith("sonraki") ||
    t.startsWith("önceki") ||
    t.startsWith("sayfa")
  )
    return true;

  // fiyat listesi / stok / tablo istemi
  const keywords = [
    "fiyat list",
    "fiyatları listele",
    "fiyatlari listele",
    "fiyat tablosu",
    "stok list",
    "listeyi göster",
    "tüm fiyat",
    "tum fiyat",
    "tüm ürün",
    "tum urun",
    "price_list",
    "price list",
    "tüm liste",
    "tum liste",
    "tüm listeyi ver",
    "tum listeyi ver",
    "liste ver",
    "tam liste",
    "bütün liste",
    "butun liste",
    "malzeme listesi",
    "malzemeleri listele",
    "tüm malzeme",
    "tum malzeme",
    "teklif tablosu",
    "teklif listesi",
  ];

  return keywords.some((k) => t.includes(k));
}

function parsePageSizeFromText(t) {
  const m = String(t || "").match(/\b(\d{1,3})\b/);
  const n = m ? Number(m[1]) : NaN;
  if (isFinite(n) && n >= 5 && n <= 100) return n;
  return PRICE_TABLE_DEFAULT_PAGE_SIZE;
}

function ensureTableState(userObj) {
  if (!userObj) return { offset: 0, pageSize: PRICE_TABLE_DEFAULT_PAGE_SIZE };
  if (!userObj.tableState || typeof userObj.tableState !== "object") {
    userObj.tableState = { offset: 0, pageSize: PRICE_TABLE_DEFAULT_PAGE_SIZE };
  }
  if (!isFinite(Number(userObj.tableState.offset))) userObj.tableState.offset = 0;
  if (!isFinite(Number(userObj.tableState.pageSize))) userObj.tableState.pageSize = PRICE_TABLE_DEFAULT_PAGE_SIZE;
  return userObj.tableState;
}

function getPriceBySku(sku) {
  if (!sku) return null;
  const s = String(sku).trim().toUpperCase();
  return PRICE_LIST.find(p => String(p["SKU"]||"").trim().toUpperCase() === s) || null;
}


// !!! kritik: prod yoksa unitPrice boş kalacak, GPT dolduramayacak


function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getPriceNumber(p) {
  const raw = getProductPriceText(p);
  const n = Number(String(raw || "").replace(",", ".").replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : null;
}

function renderPriceListTableHtml({ rows, offset, pageSize, total }) {
  const start = offset + 1;
  const end = Math.min(offset + pageSize, total);

  let html = "";
  html += `<p><strong>Fiyat Listesi</strong> — ${start}–${end} / ${total}</p>`;

  html += `<table class="malzeme-tablo">`;
  html += `<thead><tr><th>SKU</th><th>Ürün</th><th>Kategori</th><th>Birim Fiyat (TL)</th></tr></thead>`;
  html += `<tbody>`;

  for (const p of rows) {
    const sku = escapeHtml(p["SKU"] || "");
    const name = escapeHtml(p["Ürün Adı"] || p["Ad"] || "");
    const cat = escapeHtml(p["Kategori"] || p["Marka"] || "");
    const price = getPriceNumber(p);
    const priceText = price === null ? "-" : `${price.toFixed(2)}`;
    html += `<tr><td>${sku}</td><td>${name}</td><td>${cat}</td><td>${priceText}</td></tr>`;
  }

  html += `</tbody></table>`;

  const hasPrev = offset > 0;
  const hasNext = offset + pageSize < total;

  html += `<p style="margin-top:10px;">`;
  html += `Komutlar: `;
  if (hasPrev) html += `<strong>önceki</strong> `;
  if (hasNext) html += `<strong>sonraki</strong> `;
  html += `| <strong>sayfa 3</strong> | <strong>sonraki 50</strong>`;
  html += `</p>`;

  return html;
}

function buildPriceListPageForUser(currentUser, message) {
  const t = String(message || "").toLowerCase().trim();
  const state = ensureTableState(currentUser);

  // sayfa komutu: "sayfa 3"
  if (t.startsWith("sayfa")) {
    const m = t.match(/sayfa\s*(\d{1,4})/);
    const page = m ? Number(m[1]) : 1;
    const pageSize = parsePageSizeFromText(t);
    state.pageSize = pageSize;
    state.offset = Math.max(0, (Math.max(1, page) - 1) * pageSize);
  } else if (t.startsWith("önceki")) {
    const pageSize = parsePageSizeFromText(t);
    state.pageSize = pageSize;
    state.offset = Math.max(0, state.offset - pageSize);
  } else if (t.startsWith("sonraki")) {
    const pageSize = parsePageSizeFromText(t);
    state.pageSize = pageSize;
    state.offset = Math.min(Math.max(0, PRICE_LIST.length - pageSize), state.offset + pageSize);
  } else {
    // yeni "fiyat listesi" isteği: baştan başla
    state.pageSize = parsePageSizeFromText(t);
    state.offset = 0;
  }

  const total = Array.isArray(PRICE_LIST) ? PRICE_LIST.length : 0;
  const offset = Math.min(Math.max(0, state.offset), Math.max(0, total - 1));
  const pageSize = state.pageSize || PRICE_TABLE_DEFAULT_PAGE_SIZE;

  const rows = (PRICE_LIST || []).slice(offset, offset + pageSize);

  return {
    html: renderPriceListTableHtml({ rows, offset, pageSize, total }),
    state,
  };
}


// Basit kelime temizleme
function cleanText(raw) {
  if (!raw) return "";
  return String(raw).trim();
}

// ------------------------------------------------------
// Admin kontrol middleware
// ------------------------------------------------------
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Geçersiz admin anahtarı." });
  }
  next();
}


// ------------------------------------------------------
// Kullanıcı bul / oluştur
// ------------------------------------------------------
function findOrCreateUserByEmail(email) {
  let users = loadUsers();
  let u = users.find((x) => x.email === email);
  if (!u) {
    u = {
      email,
      used: 0,
      limit: 20,
    };
    users.push(u);
    saveUsers(users);
  }
  return u;
}

  // ------------------------------------------------------
// Google OAuth (opsiyonel)
// ------------------------------------------------------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || "";

const hasGoogleOAuth =
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALLBACK_URL;

if (hasGoogleOAuth) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => {
        try {
          const email =
            profile.emails && profile.emails[0] && profile.emails[0].value;
          if (!email) {
            return done(new Error("Google profilden e-posta alınamadı"), null);
          }

          const cleanEmail = email.trim().toLowerCase();
          const user = findOrCreateUserByEmail(cleanEmail);
          return done(null, { email: user.email });
        } catch (err) {
          console.error("GoogleStrategy hatası:", err);
          return done(err, null);
        }
      }
    )
  );

  app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", {
      failureRedirect: "/login.html",
      session: true,
    }),
    (req, res) => {
      const email = req.user?.email || "";
      const redirectUrl = "/?googleEmail=" + encodeURIComponent(email);
      res.redirect(redirectUrl);
    }
  );

  console.log("Google OAuth etkin.");
} else {
  console.warn(
    "Google OAuth devre dışı: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL tanımlı değil."
  );
}


// ------------------------------------------------------
// Kullanıcı limiti doldu mu?
// ------------------------------------------------------
function isUserLimitExceeded(user) {
  const used = user.used || 0;
  const limit = user.limit || 20;
  return used >= limit;
}

// ------------------------------------------------------
// getProductPriceText – fiyat metnini ortak fonksiyon
// ------------------------------------------------------
function getProductPriceText(p) {
  const raw =
    p["Fiyat TL (KDV dahil)"] ??
    p["Fiyat TL (KDV Dahil)"] ??
    p["Fiyat (KDV dahil)"] ??
    p["Fiyat (KDV Dahil)"] ??
    p["Fiyat (TL)"] ??
    p["Fiyat TL"] ??
    p["Fiyat"] ??
    p["price"] ??
    p["Price"] ??
    "";

  if (raw == null) return "";

  // "33,98" -> "33.98"
  let s = String(raw).trim();
  if (!s) return "";

  // Binlik ayırıcı vs. gelebilir diye normalize:
  // "1.234,56" -> "1234.56"
  s = s.replace(/\./g, "").replace(",", ".");

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return "";

  // İstersen burada formatlayabilirsin
  return n.toFixed(2);
}


// ------------------------------------------------------
// Basit ürün arama – PRICE_LIST içinden
// ------------------------------------------------------

function findRelatedProducts(query, limit = 8) {

  let q = String(query).toLowerCase();

  // Sayıları harflerden ayır → “tm24” → “tm 2 4”
  q = q
    .replace(/(\d+)/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();

  // Sorgu kelimeleri
  const words = q.split(" ").filter((w) => w.length > 1);

  const scored = PRICE_LIST.map((p) => {
    const name = String(p["Ürün Adı"] || p["Ad"] || "").toLowerCase();
    const sku = String(p["SKU"] || p["Kod"] || "").toLowerCase();
    const desc = String(p["Açıklama"] || p["Description"] || "").toLowerCase();

    let score = 0;

    for (const w of words) {
      if (name.includes(w)) score += 3;
      if (sku.includes(w)) score += 4;
      if (desc.includes(w)) score += 1;
    }

    return { p, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);

}
// ------------------------------------------------------
// Kategori sınıflandırma (sulama mı değil mi?)
// ------------------------------------------------------
function classifyIrrigationCategory(message) {
  const text = message.toLowerCase();

  const irrigationKeywords = [
    "sprink",
    "sprinkler",
    "yağmurlama",
    "sulama",
    "damla",
    "pe100",
    "pe 100",
    "polietilen",
    "vana",
    "solenoid",
    "kollektör",
    "sprink başlık",
    "rotor",
    "rain bird",
    "hunter",
    "damlatıcı",
    "nozul",
    "nozzle",
    "fıskiye",
    "fiskiye",
    "hortum",
    "boru",
    "hidrofor",
    "basınç",
    "debi",
    "debisi",
    "bahçe sulama",
    "yeşil alan",
    "peyzaj",
    "tarla",
    "sera",
    "otomat",
    "kontrol ünitesi",
    "kontrol paneli",
    "kontrol cihazı",
    "valf",
    "valve",
    "filtre",
    "süzgeç",
    "damlama",
    "sulandırma",
    "spray",
    "line",
    "lateral",
    "ana hat",
    "ana boru",
    "zone",
    "bölge",
    "zon",
  ];

  const nonIrrigationKeywords = [
    "aşk",
    "sevgili",
    "ilişki",
    "psikoloji",
    "felsefe",
    "programlama",
    "yazılım",
    "oyun",
    "film",
    "dizi",
    "bilgisayar",
    "telefon",
    "monitor",
    "mouse",
    "klavye",
    "oyuncu",
    "kripto",
    "borsa",
    "yatırım",
    "hisse",
    "coin",
    "bitcoin",
    "ethereum",
    "hukuk",
    "mahkeme",
    "dava",
    "icra",
    "boşanma",
    "evlilik",
    "ilişkiler",
    "hayat tavsiyesi",
    "kişisel gelişim",
  ];

  let scoreIrr = 0;
  let scoreNon = 0;

  for (const k of irrigationKeywords) {
    if (text.includes(k)) scoreIrr += 2;
  }
  for (const k of nonIrrigationKeywords) {
    if (text.includes(k)) scoreNon += 2;
  }

  if (scoreIrr === 0 && scoreNon === 0) return "UNKNOWN";
  if (scoreIrr >= scoreNon) return "IRRIGATION";
  return "NON_IRRIGATION";
}

// ------------------------------------------------------
// CEVAP STİLİ (ChatGPT mantığında kısa, adım adım)
// ------------------------------------------------------
const STYLE_PROMPT = `
HER CEVAPTA AŞAĞIDAKİ KURALLARA UY:

1) Fiyatlı malzeme listesi istendiğinde SADECE HTML TABLO kullan.
   Markdown, pipe tablo, düz liste, format karışımı ASLA üretme.

2) HTML tablo iskelesi ŞU OLACAK (ASLA DEĞİŞTİRME):
<table class="malzeme-tablo">
  <thead>
    <tr>
      <th>Grup</th>
      <th>Ürün</th>
      <th>Açıklama</th>
      <th>Adet / Metre</th>
      <th>Birim Fiyat (TL)</th>
      <th>Tutar (TL)</th>
    </tr>
  </thead>
  <tbody>
    <!-- Ürün satırları -->
  </tbody>
</table>

3) Her ürün bir <tr> içinde olacak. Her <td> doğru sırada olacak.
4) Fiyat yoksa:
   - Birim fiyat: "-"
   - Tutar: "Teklifte belirlenecek"

5) Tablo bittikten sonra şu genel toplam bloğunu üret:
<p class="genel-toplam">
  <strong>Genel Toplam (KDV dahil):</strong> XXX TL
</p>

6) Teknik açıklama veya tasarım anlatımı tablodan önce olacak,
   fakat HTML tablo ile karışmayacak.
   Tablonun önüne sadece sade metin paragrafı yaz.

7) Asla "<td> ürün >" gibi bozuk tag, eksik kapanan <td> üretme.
   Model çıktısı düzenli HTML olacak.
`;

const PRICE_STRICT_RULE = `
KESİN KURAL (FİYAT):
- Kullanıcı fiyat/liste/teklif isterse ASLA fiyat yazma, ASLA TL yazma.
- Sadece ilgili ürünlerin SKU listesini (maks 20 adet) JSON formatında döndür:
  {"skus":["ARCPK2534","..."]}
- Listede yoksa {"skus":[]} döndür.
`;



function isSinglePriceQuestion(message) {
  const t = String(message || "").toLowerCase();
  if (!t) return false;

  // fiyat / kaç para gibi niyet var mı?
  const hasPriceIntent = /fiyat|ücret|ucret|kaç para|kac para|ne kadar|tl|₺/.test(t);
  if (!hasPriceIntent) return false;

  // Adet bilgisi var mı?
  const hasQuantityIntent = /\d+\s*(adet|pcs?)/.test(t); // "20 adet", "15 pcs" gibi

  if (hasQuantityIntent) {
    // Adet bilgisini parse et
    const quantityMatch = t.match(/\d+\s*(adet|pcs?)/);
    const quantity = parseInt(quantityMatch[0], 10); // Adeti yakala
    return { quantity };
  }

  // liste/tablo/sayfalama ise tek ürün fiyatı sayma
  if (isPriceListTableRequest(t)) return false;
  if (/liste|tablo|tüm|tum|stok|malzeme/.test(t)) return false;

  return true;
}


// ------------------------------------------------------
// Ana Prompt – Sistem mesajı
// ------------------------------------------------------
function buildSystemPrompt() {
  return `
Sen "Sulama Asistanı" isimli profesyonel bir peyzaj ve bahçe sulama danışmanısın. 
Türkiye şartlarına göre villa bahçeleri, peyzaj alanları ve küçük tarımsal alanlar için:
- Sulama projelendirme,
- Ürün seçimi ve kombinasyonu,
- Tesisat şeması ve zonlama,
- Basınç / debi değerlendirmesi,
- Maliyet çıkarma
konularında uzman, serin kanlı ve net konuşan bir uzmansın.

GENEL DAVRANIŞ KURALLARI
- ChatGPT gibi konuş: kısa, net, hızlı.
- Cevabı ASLA tek seferde uzun yazma.
- Büyük işlemleri PARÇALI ver:
  1) Kısa analiz + 1–2 soru
  2) Kullanıcı “devam et” derse malzeme listesinin ilk kısmı
  3) Kullanıcı isterse detaylı liste
  4) Kullanıcı isterse fiyat tablosu
- Kullanıcı onay vermeden sonraki adıma geçme.
- Uzun paragraflar yok → sadece maddeli, kısa cümleler.
- İşçilik/montaj fiyatı verme.


FİYAT KURALI:
- Fiyat verirken sadece backend tarafından sağlanan productContext içindeki fiyatları kullan.
- Backend tarafından fiyat verilmeyen hiçbir ürüne tahmini veya uydurma fiyat yazma.
- CSV / JSON içinde fiyat yoksa o ürünün fiyatı "-" ve "Teklifte belirlenecek" olacak.

MALZEME LİSTESİ / TEKLİF CEVAPLARI
-- **AŞAĞIDAKİ “HTML TABLO KURALLARI” ZORUNLUDUR — ASLA DEĞİŞMEYECEK!** ---

HTML TABLO FORMAT KURALLARI (ÇOK ÖNEMLİ)

1) Fiyatlı tablo ÜRETİRKEN SADECE aşağıdaki HTML iskeletini kullan:

<table class="malzeme-tablo">
  <thead>
    <tr>
      <th>Grup</th>
      <th>Ürün</th>
      <th>Açıklama</th>
      <th>Adet / Metre</th>
      <th>Birim Fiyat (TL)</th>
      <th>Tutar (TL)</th>
    </tr>
  </thead>
  <tbody>
    <!-- Ürün satırları -->
  </tbody>
</table>

2) Tabloyu ASLA değiştirme:
- <thead> sabit
- 6 kolon sabit
- Tüm <tr> doğru kapanmalı
- Markdown tablo, pipe tablo, bozuk HTML YASAK.

3) Her ürün mutlaka tek <tr> içinde olacak.

4) Fiyat yoksa:
- Birim fiyat = "-"
- Tutar = "Teklifte belirlenecek"

5) Tablo bittikten sonra şu formatta genel toplam satırı ZORUNLU:

<p class="genel-toplam">
  <strong>Genel Toplam (KDV dahil):</strong> XXX TL
</p>

6) Tabloyu bozan karakterler kesinlikle yasaktır:
- "|", "|||" ile başlayan satırlar
- "<td> ürün >" gibi bozuk tag’ler
- Eksik kapanan <td> ve <tr>
- HTML’siz fiyat listesi
- Karma liste

TABLO = HTML.  
HTML = Yukarıdaki yapı.  
Bu yapı dışına ASLA çıkma.


OTOMATİK MALZEME SEÇİM KURALLARI
Bu kurallar, bahçe için malzeme listesi çıkarırken ve teklif hazırlarken GEÇERLİDİR.

1) KONTROL ÜNİTESİ SEÇİMİ
- Müşteri elektrikli (220 V) sistem istiyorsa:
  - Sadece 1 model öner:
    - Rain Bird ESP-TM2 serisinden, istasyon sayısına uygun bir model seç.
- Müşteri pilli sistem (elektrik yok) istiyorsa:
  - Sadece 1 model öner:
    - Rain Bird ESP-9V serisinden, istasyon sayısına uygun bir model seç.
- Birden fazla kontrol ünitesi seçeneğini aynı anda listeleme; müşteriye TEK öneri sun.

2) SPREY vs ROTOR SEÇİMİ (Bahçe alanına göre)
- Küçük bahçeler (kabaca 0–300 m²):
  - Ağırlıklı olarak sprey sprinkler (sprey sprink) öner.
- Orta-büyük bahçeler (300–800 m² arası):
  - Gerekirse karışık kullanım (uygun yerlerde sprey, uygun yerlerde rotor) önerebilirsin.
- Büyük bahçeler (800 m² ve üzeri):
  - Ağırlıklı olarak rotor sprinkler öner. 
- Cevapta bahçe alanını yorumlayarak “Bu alan için sprey/rotor tercih sebebi şu...” diye 1–2 cümle ile açıkla.

3) SOLENOID VANA MODELİ (Boru çapı ve elektrik durumuna göre)
Bahçede ELEKTRİK VARSA (24 V AC):
- Ana boru 1" ise: Rain Bird 100-HV 24 V modelini seç. 
- Ana boru 1 1/2" ise: Rain Bird 150-PGA 24 V modelini seç. 
- Ana boru 2" ise: Rain Bird 200-PGA 24 V modelini seç. 

Bahçede ELEKTRİK YOKSA (PİLLİ sistem, 9 V):
- Ana boru 1" ise: Rain Bird 100-HV 9 V modelini seç. 
- Ana boru 1 1/2" ise: Rain Bird 150-PGA 9 V modelini seç. 
- Ana boru 2" ise: Rain Bird 200-PGA 9 V modelini seç. 

4) PRİZ KOLYE ADEDİ
- Sprink + rotor toplam adedi kadar ANA BORUYA UYGUN priz kolye seç. 
  - Örnek: Toplam 12 sprink/rotor varsa → 12 adet ana boru çapına uygun priz kolye.

5) LATERAL HAT BAĞLANTISI
- Lateral hat PE boru çapı 20 mm kabul edilir (küçük/orta bahçeler için). 
- Priz kolye sayısının 2 katı kadar 20 mm lateral PE boruya uygun KAPLIN ERKEK DİRSEK seç: 
  - 1 adet priz kolye çıkışına,
  - 1 adet sprink/rotor altına gelecek şekilde.
  - Örnek: 12 priz kolye varsa → 24 adet 20 mm kaplin erkek dirsek.

6) KOLLEKTÖR SEÇİMİ
- Solenoid vana sayısı kadar Arangül MTT-100 kollektör seç. 
  - Örnek: 3 solenoid vana → 3 adet MTT-100.

7) ANA BORUYA GEÇİŞ ADAPTÖRLERİ
- Solenoid vana sayısı kadar, vana çıkışından ANA BORUYA geçmek için uygun çapta KAPLIN ERKEK ADAPTÖR seç. 
  - Örnek: 3 solenoid vana → 3 adet kaplin erkek adaptör.

8) KAPLIN TAPA
- Solenoid vana sayısı kadar, ana boru üzerinde kullanılmak üzere ANA BORU ÇAPINA UYGUN kaplin tapa seç. 
  - Örnek: 3 solenoid vana → 3 adet kaplin tapa.

9) SİNYAL KABLOSU SEÇİMİ (İstasyon/solenoid sayısına göre)
- 1–2 solenoid vana → 3 damarlı 
- 3–4 solenoid vana → 5 damarlı 
- 5–6 solenoid vana → 7 damarlı 
- 7–8 solenoid vana → 9 damarlı 
- 9–12 solenoid vana → 13 damarlı 
- Kablo uzunluğunu proje durumuna göre yaklaşık metre cinsinden yaz (ör: 25–50 m).

10) VANA KUTUSU SEÇİMİ
- 1 solenoid vana → 6" vana kutusu 
- 2 solenoid vana → 10" vana kutusu 
- 3 solenoid vana → 12" vana kutusu
- 4 solenoid vana → 14" vana kutusu 
- Vana sayısına göre TEK tip vana kutusu öner, gereksiz alternatif verme.

11) ANA BORU FİTTİNGLERİ
- Ana boru hangi çaptaysa, o çapa uygun:
  - 2 adet dirsek 
  - 2 adet te 
  - 2 adet manşon 
  ekle.
- Açıklamada “İş sırasında çıkabilecek ekstra dönüşler/ekler için yedek fittings” diye belirt.

12) LAZIM OLABİLECEK YARDIMCI ÜRÜNLER
- Aşağıdaki ürünleri “Yardımcı malzemeler” başlığı altında listeye ekle:
  - Boru kesme makası – 1 adet 
  - Pah açma aparatı – 1 adet 
  - Teflon bant – 2 adet 
  - Elektrik bandı – 1–2 adet 
  - İş eldiveni – 1 çift 
  - Lokma uç seti veya uygun lokma uç – 1 set 
- Bu kalemler için de PRICE_LIST’te varsa fiyat yaz, yoksa “yerelden fiyat alınacak” diye belirt.

13) İŞÇİLİK FİYATI YOK
- ASLA işçilik / montaj / uygulama ücreti hesaplama.
- Müşteri işçilik sorarsa:
  - “Ben malzeme ve sistem tasarımında yardımcı oluyorum; işçilik fiyatı için yerel bir uygulamacıdan teklif almalısınız.” şeklinde kısaca açıkla.

KAPSAM KURALI
- Bahçe, peyzaj, sulama, tesisat, pompa, boru, vana, filtre, otomasyon, basınç, debi, sprinkler, damla sulama gibi konularda HER ZAMAN sulama uzmanı olarak detaylı ama KISA ve ADIM ADIM cevap ver.
- Sulama ile alakası olmayan konularda nazikçe kapsam dışı olduğunu belirtip, sadece çok kısa yardımcı ol.

HESAPLAMA ve KABULLER:
- Küçük villa / peyzaj bahçelerinde ana boru genelde 32mm veya 40mm PE100 seç.
- Lateral (sprinkler hatları) genelde 20mm PE100 kabul et.
- Sprinkler ve rotor sayısını debi ve basınca göre mantıklı zonlara böl.
- Yetersiz basınç / debi görürsen mutlaka uyar, çözüm öner.
- Fiyat sorulursa sadece verilen ürün listesi veya CSV’deki veriler üzerinden konuş. Uydurma fiyat verme.

ÜRÜN EŞLEME:
- Kullanıcı ürün kodu (SKU) veya isim yazarsa, mutlaka ürün eşlemesi yapmaya çalış.
- CSV’den bulabildiğin ürünleri “mantıklı bir kombinasyon” halinde listele.
- Fiyatları yazarken TL olarak “KDV dahil” olduğunu belirt.
- Kullanıcı fiyat sormuyorsa durduk yere TL yazma.

FORMAT
- Mesaja giriş 1 kısa cümle.
- Sonra “Adım 1:” şeklinde kısa maddeli çıktı.
- Her adımın sonunda: “Devam edeyim mi?”

PDF PROJELER:
- Kullanıcı özel tasarım isterse alanı, su kaynağını, basıncı, debiyi, kontrol cihazını sor.
- Mantıklı bir zonlama + ürün seti + kısa açıklama üret.
- Çıktıyı tablolara dönüştürülebilir, temiz bir metin olarak yaz (başlıklar, alt başlıklar, madde işaretleri).

UNUTMA:
- Odak noktan SULAMA. Konu tamamen alakasızsa, kibarca reddet.
- Kullanıcının bütçesini, bakım kolaylığını ve Türkiye’de bulunabilirliği dikkate al.
`;
}



// ------------------------------------------------------
// PDF Teklif Oluşturma
// ------------------------------------------------------
function createOfferPDF(projectData, res) {
  const doc = new PDFDocument({
    margin: 40,
    size: "A4",
  });

  // PDF response ayarları
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="teklif.pdf"');

  doc.pipe(res);

  // Başlık
  doc
    .fontSize(20)
    .fillColor("#1b8a5a")
    .text("Sulama Sistemi Teklif Raporu", { align: "center" })
    .moveDown(1.5);

  // Firma bilgileri (örnek)
  doc
    .fontSize(10)
    .fillColor("#000000")
    .text("Firma: Sulama Asistanı", { align: "left" })
    .text("Adres: Ankara / Türkiye")
    .text("Telefon: 0 (312) 000 00 00")
    .text("E-posta: info@sulamaasistani.com")
    .moveDown(1);

  // Proje Özeti
  doc
    .fontSize(14)
    .fillColor("#1b8a5a")
    .text("Proje Özeti", { underline: true })
    .moveDown(0.5);

  if (projectData && projectData.summary) {
    doc
      .fontSize(11)
      .fillColor("#000000")
      .text(projectData.summary, {
        align: "left",
      })
      .moveDown(1);
  } else {
    doc
      .fontSize(11)
      .fillColor("#000000")
      .text("Proje özeti bilgisi bulunamadı.", { align: "left" })
      .moveDown(1);
  }

  // Tablolar
  if (Array.isArray(projectData?.tables)) {
    projectData.tables.forEach((table, index) => {
      doc
        .addPage()
        .fontSize(14)
        .fillColor("#1b8a5a")
        .text(table.title || `Tablo ${index + 1}`, { underline: true })
        .moveDown(0.5);

      const headers = table.headers || [];
      const rows = table.rows || [];

      // Basit tablo çizimi
      const startX = 40;
      let startY = doc.y + 10;
      const rowHeight = 18;

      doc.fontSize(10).fillColor("#000000");

      // Header çiz
      headers.forEach((h, i) => {
        doc.text(h, startX + i * 120, startY, { width: 110 });
      });

      startY += rowHeight;

      rows.forEach((r) => {
        r.forEach((cell, i) => {
          doc.text(String(cell), startX + i * 120, startY, { width: 110 });
        });
        startY += rowHeight;
        if (startY > 750) {
          doc.addPage();
          startY = 60;
        }
      });
    });
  }

  // Toplam Fiyat Bölümü
  doc.addPage().fontSize(14).fillColor("#1b8a5a").text("Toplam Teklif", {
    underline: true,
  });

  const total = projectData?.totalPrice;
  if (typeof total === "number") {
    doc
      .moveDown(1)
      .fontSize(12)
      .fillColor("#000000")
      .text(`Genel Toplam (KDV dahil): ${total.toLocaleString("tr-TR")} TL`);
  } else {
    doc
      .moveDown(1)
      .fontSize(12)
      .fillColor("#000000")
      .text("Toplam fiyat bilgisi belirtilmemiştir.");
  }

  doc.end();
}

// ------------------------------------------------------
// POST /api/pdf – Teklif PDF oluştur
// ------------------------------------------------------
app.post("/api/pdf", (req, res) => {
  const { project } = req.body || {};
  if (!project) {
    return res.status(400).json({ error: "project verisi eksik." });
  }

  createOfferPDF(project, res);
});


// Kullanıcı kayıt (e-posta + şifre)
// Body: { email: "...", password: "..." }
app.post("/api/register", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Geçersiz e-posta." });
  }

  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Şifre zorunludur." });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail.includes("@")) {
    return res.status(400).json({ error: "Geçersiz e-posta formatı." });
  }

  const users = loadUsers();
  const existing = users.find((u) => u.email === cleanEmail);

  if (existing) {
    return res.status(400).json({ error: "Bu e-posta zaten kayıtlı." });
  }

  const newUser = {
    email: cleanEmail,
    password,         // not: gerçek ortamda hash’lenmeli
    used: 0,
    limit: 20,        // istersen DEFAULT_DAILY_LIMIT gibi bir sabite bağla
  };

  users.push(newUser);
  saveUsers(users);

  res.json({
    email: newUser.email,
    used: newUser.used,
    limit: newUser.limit,
    remaining: newUser.limit,
  });
});


// Kullanıcı login (e-posta + şifre)
// Body: { email: "...", password: "..." }
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Geçersiz e-posta." });
  }

  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Şifre zorunludur." });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail.includes("@")) {
    return res.status(400).json({ error: "Geçersiz e-posta formatı." });
  }

  // Kullanıcıları JSON'dan oku
  const users = loadUsers();
  const user = users.find((u) => u.email === cleanEmail);

  if (!user) {
    return res
      .status(400)
      .json({ error: "Bu e-posta ile kayıtlı kullanıcı bulunamadı." });
  }

  // Şifre kontrolü (prototip → düz metin; ileride hash'leriz)
  if (!user.password) {
    return res
      .status(400)
      .json({ error: "Bu kullanıcı için henüz şifre tanımlanmamış." });
  }

  if (user.password !== password) {
    return res.status(401).json({ error: "Şifre hatalı." });
  }

  // Başarılı giriş
  res.json({
    email: user.email,
    used: user.used || 0,
    limit: user.limit || 20,
    remaining: (user.limit || 20) - (user.used || 0),
  });
});

// ------------------------------------------------------
// Admin: tüm kullanıcıları listele
// ------------------------------------------------------
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = loadUsers();
  res.json(users);
});

// Admin: tek kullanıcının geçmişini ve limitini getir
app.get("/api/admin/user/:email", requireAdmin, (req, res) => {
  const email = (req.params.email || "").toLowerCase();
  const users = loadUsers();
  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }
  res.json(user);
});

// Admin: kullanıcı limitini güncelle
app.post("/api/admin/user/:email/limit", requireAdmin, (req, res) => {
  const email = (req.params.email || "").toLowerCase();
  const { limit } = req.body || {};

  let users = loadUsers();
  const idx = users.findIndex((u) => u.email === email);
  if (idx === -1) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  const newLimit = Number(limit);
  if (!isFinite(newLimit) || newLimit <= 0) {
    return res.status(400).json({ error: "Geçersiz limit değeri." });
  }

  users[idx].limit = newLimit;
  saveUsers(users);

  res.json({ ok: true, email, limit: newLimit });
});

// ------------------------------------------------------
// POST /api/sulama – STREAM cevap (chat + proje paneli için)
// ------------------------------------------------------
app.post("/api/sulama", async (req, res) => {
  let { message, user, mode, designData, project } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).send("message zorunlu.");
  }

  // Kullanıcı kontrolü
  if (!user || !user.email) {
    return res.status(400).send("Kullanıcı bilgisi (email) zorunludur.");
  }

  // Kullanıcı yükle / oluştur
  let users = loadUsers();
  let currentUser = users.find((u) => u.email === user.email);
  if (!currentUser) {
    currentUser = {
      email: user.email,
      used: 0,
      limit: 20,
      memory: [],
      projects: [],
    };
    users.push(currentUser);
  }

  // Limit kontrolü
  if (isUserLimitExceeded(currentUser)) {
    return res
      .status(403)
      .send(
        "Soru limitiniz dolmuştur. Lütfen admin ile iletişime geçin veya limitinizi yükseltin."
      );
  }

  // Soru sınıflandırma
  const category = classifyIrrigationCategory(message);
  let effectiveCategory = category;

  const strongIrrigationHints = ["sprink", "sulama", "damla", "PE100", "vana"];
  const hasStrongHint = strongIrrigationHints.some((k) =>
    message.toLowerCase().includes(k.toLowerCase())
  );
  if (category !== "IRRIGATION" && hasStrongHint) {
    effectiveCategory = "IRRIGATION";
  }

  // Sulama dışıysa, kısa metni direkt gönder (JSON değil, düz text!)
  if (effectiveCategory === "NON_IRRIGATION") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(
      "Ben sulama sistemleri konusunda uzmanlaşmış bir asistanım. Bu soru sulama ile ilgili olmadığı için yardımcı olamıyorum. Bahçe sulama, damla sulama, yağmurlama, ürün seçimi gibi konularda soru sorabilirsin."
    );
    return;
  }
  
// ------------------------------------------------------
// Fiyat listesi / tablo isteği: kısıtları devre dışı bırak, server-side tablo üret
// ------------------------------------------------------
if (isPriceListTableRequest(message)) {
  const page = buildPriceListPageForUser(currentUser || null, message);

  // state'i users.json'a yaz (sadece loginli endpointte anlamlı)
  try {
    if (currentUser) {
      currentUser.tableState = page.state;
      saveUsers(users);
    }
  } catch (_) {}

  // STREAM yerine tek seferde HTML dönelim (frontend zaten HTML basıyor)
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(page.html);

  // Hafızaya da yazalım
  try {
    if (currentUser) {
      if (!Array.isArray(currentUser.memory)) currentUser.memory = [];
      currentUser.memory.push({ role: "user", content: message });
      currentUser.memory.push({ role: "assistant", content: page.html });
      if (currentUser.memory.length > 40) {
        currentUser.memory = currentUser.memory.slice(-40);
      }
      saveUsers(users);
    }
  } catch (_) {}

  return;
}


  // Kullanıcının hafızasından son 20 mesaj
  const history = Array.isArray(currentUser.memory)
    ? currentUser.memory.slice(-20)
    : [];
  const hasHistory = Array.isArray(history) && history.length > 0;

  // Ürün eşleme
  const relatedProducts = findRelatedProducts(message, 8);
  let productContext = "";
  if (relatedProducts.length > 0) {
    productContext =
  "İLGİLİ ÜRÜNLER (JSON referansı):\n" +
  relatedProducts
    .map(p =>
      `- SKU: ${p["SKU"]} | Ürün: ${p["Ürün Adı"] || p["Ad"]}`
    )
    .join("\n");

  }


  // ------------------------------------------------------
  // Tek ürün fiyat sorusu: GPT'ye gitmeden fiyatı JSON'dan döndür
  // ------------------------------------------------------
  if (isSinglePriceQuestion(message)) {
  const best = relatedProducts?.[0] || null;

  if (!best) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send("Fiyatı bulamadım (liste eşleşmesi yok). Lütfen SKU yaz ya da ürün adını daha net belirt.");
  }

  const sku = best["SKU"] || best["sku"] || "";
  const name = best["Ürün Adı"] || best["Ad"] || best["name"] || "";
  const priceText = getProductPriceText(best).trim();

  if (!priceText) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(`Bu ürün bulundu ama JSON'da fiyat alanı boş görünüyor. (SKU: ${sku} | Ürün: ${name})`);
  }

  const quantity = parseQuantityFromText(message);

  const unitPrice = Number(priceText.replace(",", "."));
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(`Fiyat verisi bozuk görünüyor. (SKU: ${sku})`);
  



}


const totalPrice = unitPrice * quantity;


    // Frontend HTML basabildiği için küçük bir tablo dönüyoruz
    const html = `
<div style="margin:6px 0 10px 0;">Bulduğum en yakın eşleşmenin KDV dahil fiyatı:</div>
<table>
  <thead>
    <tr><th>SKU</th><th>Ürün</th><th>Birim Fiyat (TL)</th></tr>
  </thead>
  <tbody>
    <tr><td>${escapeHtml(sku)}</td><td>${escapeHtml(name)}</td><td>${escapeHtml(priceText)}</td></tr>
  </tbody>
</table>
`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(html);
  }

  let irrigationContextText = "";
  if (hasHistory) {
    irrigationContextText =
      "KULLANICININ ÖNCEKİ SULAMA SOHBETLERİNDEN ÖZET KONTEXT:\n\n" +
      history
        .map(
          (m) =>
            `${m.role === "user" ? "KULLANICI" : "ASİSTAN"}: ${m.content}`
        )
        .join("\n") +
      "\n\n---\n\n";
  }

  const systemPrompt = buildSystemPrompt();

 const messages = [
  { role: "system", content: JSON.stringify(STEP_CONTROLLER) },
  { role: "system", content: systemPrompt },
  { role: "system", content: STYLE_PROMPT },
  { role: "system", content: PRICE_STRICT_RULE }, // 👈 BU ŞART
];



  if (irrigationContextText) {
    messages.push({
      role: "assistant",
      content:
        "(Bu içerik önceki konuşmalara dair özet bilgidir, kullanıcıya aynen gösterme.)\n\n" +
        irrigationContextText,
    });
  }

  if (productContext) {
    messages.push({
      role: "assistant",
      content:
        "(Bu tablo yalnızca senin dahili referansındır, kullanıcıya ASLA aynen yazma) \n" +
        "Kullanıcı FİYAT sorarsa bu tabloyu referans alabilirsin. Fiyat sormazsa TL bilgisi verme.\n\n" +
        productContext,
    });
  }

  messages.push({
    role: "user",
    content: JSON.stringify({ soru: message, email: user.email }),
  });

  // Kullanım arttır
  currentUser.used += 1;
  saveUsers(users);

  try {
    // *** BURADAN İTİBAREN STREAM ***
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    const completion = await client.chat.completions.create({
      model: "gpt-4.1",
      messages,
      max_tokens: STEP_CONTROLLER.maxTokens,
      temperature: 0.4,
      stream: true,
    });

    let fullText = "";

    for await (const chunk of completion) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (!delta) continue;

      fullText += delta;

      // Kullanıcıya her parçayı anında gönder
      res.write(delta);
    }

    // Stream bitti
    res.end();

    // Hafızayı güncelle (cevabı da kaydedelim)
    users = loadUsers();
    currentUser = users.find((u) => u.email === user.email);
    if (!currentUser) return;

    if (!Array.isArray(currentUser.memory)) currentUser.memory = [];
    currentUser.memory.push({ role: "user", content: message });
    currentUser.memory.push({ role: "assistant", content: fullText });

    if (currentUser.memory.length > 40) {
      currentUser.memory = currentUser.memory.slice(-40);
    }

    saveUsers(users);
  } catch (err) {
    console.error("OpenAI stream hata (/api/sulama):", err);

    if (!res.headersSent) {
      res
        .status(500)
        .send("OpenAI isteğinde hata oluştu, lütfen tekrar deneyin.");
    } else {
      // headers gönderildiyse, en azından stream'i düzgün kapat
      try {
        res.end();
      } catch (_) {}
    }
  }
});


// ------------------------------------------------------
// GPT için login gerektirmeyen sulama endpoint'i
// ------------------------------------------------------
app.post("/api/gpt-sulama", async (req, res) => {
  const { message, mode, designData, project } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message zorunlu." });
  }

  // Soru sınıflandırma
  const category = classifyIrrigationCategory(message);
  let effectiveCategory = category;

  // Sulama ile çok alakalı kelimeler varsa, NON_IRRIGATION bile dese IRRIGATION kabul et
  const strongIrrigationHints = ["sprink", "sulama", "damla", "PE100", "vana"];
  const hasStrongHint = strongIrrigationHints.some((k) =>
    message.toLowerCase().includes(k.toLowerCase())
  );
  if (category !== "IRRIGATION" && hasStrongHint) {
    effectiveCategory = "IRRIGATION";
  }

  // Hâlâ sulama dışıysa kibarca reddet
  if (effectiveCategory === "NON_IRRIGATION") {
    return res.json({
      reply:
        "Ben sulama sistemleri konusunda uzmanlaşmış bir asistanım. Bu soru sulama ile ilgili olmadığı için yardımcı olamıyorum. Bahçe sulama, damla sulama, yağmurlama, ürün seçimi gibi konularda soru sorabilirsin.",
      meta: {
        category,
        effectiveCategory,
      },
    });
  }
  
// ------------------------------------------------------
// Fiyat listesi / tablo isteği: kısıtları devre dışı bırak, server-side tablo üret
// ------------------------------------------------------
if (isPriceListTableRequest(message)) {
  const page = buildPriceListPageForUser(null, message);
  return res.json({
    reply: page.html,
    meta: {
      category,
      effectiveCategory,
      table: true,
      total: (Array.isArray(PRICE_LIST) ? PRICE_LIST.length : 0),
    },
  });
}





  // Ürün eşleme (JSON fiyat listesi)
  const relatedProducts = findRelatedProducts(message, 8);

  let productContext = "";
  if (Array.isArray(relatedProducts) && relatedProducts.length > 0) {
    productContext =
      "İLGİLİ ÜRÜNLER VE FİYATLAR (JSON'den):\n" +
      relatedProducts
        .map((p) => {
          const fiyatMetni = getProductPriceText(p).trim();
          const fiyat =
            !fiyatMetni || fiyatMetni === "0"
              ? "Bu ürün için JSON'da fiyat bilgisi yok."
              : `${fiyatMetni} TL (KDV dahil varsayılabilir)`;
          return `- SKU: ${p["SKU"] || ""} | Ürün: ${p["Ürün Adı"] || p["Ad"] || ""} | Fiyat: ${fiyat}`;
        })
        .join("\n");
  }

  // Tek ürün fiyat sorusu: GPT'ye gitmeden JSON'dan cevapla
  if (isSinglePriceQuestion(message)) {
  const best = relatedProducts?.[0] || null;

  if (!best) {
    return res.json({ reply: "Fiyatı bulamadım (liste eşleşmesi yok). Lütfen SKU yaz ya da ürün adını daha net belirt." });
  }

  const sku = best["SKU"] || best["sku"] || "";
  const name = best["Ürün Adı"] || best["Ad"] || best["name"] || "";
  const priceText = getProductPriceText(best).trim();

  if (!priceText) {
    return res.json({ reply: `Bu ürün bulundu ama JSON'da fiyat alanı boş görünüyor. (SKU: ${sku} | Ürün: ${name})` });
  }

  const quantity = parseQuantityFromText(message);

  const unitPrice = Number(priceText.replace(",", "."));
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return res.json({ reply: `Fiyat verisi bozuk görünüyor. (SKU: ${sku})` });
  }





const totalPrice = unitPrice * quantity;

    const html = `
<div style="margin:6px 0 10px 0;">Bulduğum en yakın eşleşmenin KDV dahil fiyatı:</div>
<table>
  <thead>
    <tr><th>SKU</th><th>Ürün</th><th>Birim Fiyat (TL)</th></tr>
  </thead>
  <tbody>
    <tr><td>${escapeHtml(sku)}</td><td>${escapeHtml(name)}</td><td>${escapeHtml(priceText)}</td></tr>
  </tbody>
</table>
`;
    return res.json({ reply: html });
  }

  const messages = [
  { role: "system", content: JSON.stringify(STEP_CONTROLLER) },
  { role: "system", content: systemPrompt },
  { role: "system", content: STYLE_PROMPT },
  { role: "system", content: PRICE_STRICT_RULE }, // 👈 BU ŞART
];






  if (productContext) {
    messages.push({
      role: "assistant",
      content:
        "(Bu tablo yalnızca senin dahili referansındır, kullanıcıya ASLA aynen yazma) \n" +
        "Kullanıcı FİYAT sorarsa bu tabloyu referans alabilirsin. Fiyat sormazsa TL bilgisi verme.\n\n" +
        productContext,
    });
  }

  // GPT tarafı için sahte ama sabit bir email kullanıyoruz
  messages.push({
    role: "user",
    content: JSON.stringify({
      soru: message,
      email: "gpt@sulamaasistani.com",
      mode: mode || null,
      designData: designData || null,
      project: project || null,
    }),
  });

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1",
      messages,
      max_tokens: STEP_CONTROLLER.maxTokens,
      temperature: 0.4,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "Şu anda yanıt üretemiyorum, lütfen tekrar deneyin.";

    return res.json({
      reply,
      meta: {
        category,
        effectiveCategory,
        productCount: relatedProducts.length,
      },
    });
  } catch (err) {
    console.error("OpenAI hata (gpt-sulama):", err);
    return res.status(500).json({
      error: "OpenAI isteğinde hata oluştu.",
    });
  }
});


// ------------------------------------------------------
// Sunucu başlat
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sulama Asistanı server ${PORT} portunda çalışıyor.`);
});
