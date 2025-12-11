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
const PRICE_LIST_FILE = path.join(__dirname, "price_list.json");

// ------------------------------------------------------
// Yardımcı fonksiyonlar
// ------------------------------------------------------

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
    if (!fs.existsSync(PRICE_LIST_FILE)) {
      console.warn("price_list.json bulunamadı.");
      PRICE_LIST = [];
      return;
    }
    const raw = fs.readFileSync(PRICE_LIST_FILE, "utf8");
    PRICE_LIST = JSON.parse(raw || "[]");
    console.log(`PRICE_LIST yüklendi, ürün sayısı: ${PRICE_LIST.length}`);
  } catch (e) {
    console.error("PRICE_LIST okunamadı:", e);
    PRICE_LIST = [];
  }
}
loadPriceList();

// ------------------------------------------------------
// Express Ortamı
// ------------------------------------------------------
app.use(express.json({ limit: "2mb" }));

// Statik dosyalar (public klasörü)
app.use(express.static(path.join(__dirname, "public")));

// Basit CORS (gerekirse)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-admin-key, Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

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
// Basit kelime temizleme
// ------------------------------------------------------
function cleanText(raw) {
  if (!raw) return "";
  return String(raw).trim();
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
      memory: [],
      projects: [],
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
            profile?.emails && profile.emails[0] && profile.emails[0].value;
          if (!email) {
            return done(new Error("Google hesabında e-posta bulunamadı."));
          }

          const users = loadUsers();
          const cleanEmail = email.trim().toLowerCase();

          let user = users.find((u) => u.email === cleanEmail);
          if (!user) {
            user = {
              email: cleanEmail,
              used: 0,
              limit: 30,
              memoryCount: 0,
            };
            users.push(user);
            saveUsers(users);
          }

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  // Google giriş rotaları
  app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", {
      failureRedirect: "/login",
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

  // Rotalar dursun ama hata vermesin
  app.get("/auth/google", (req, res) => {
    res
      .status(503)
      .send("Google ile giriş bu sunucuda devre dışı (env tanımlı değil).");
  });

  app.get("/auth/google/callback", (req, res) => {
    res.redirect("/login");
  });
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
  // Birden fazla olası kolon ismi
  const priceKeys = ["Fiyat", "Fiyat (TL)", "Fiyat TL", "SatisFiyat", "Price"];

  for (const key of priceKeys) {
    if (p[key] != null && p[key] !== "") {
      return String(p[key]);
    }
  }
  return "";
}

// ------------------------------------------------------
// Basit ürün arama – PRICE_LIST içinden
// ------------------------------------------------------

function findRelatedProducts(query, limit = 10) {
  if (!query || !PRICE_LIST || !Array.isArray(PRICE_LIST)) return [];

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

const STEP_INSTRUCTION = `
HER ZAMAN kısa yaz.
Asla tüm çözümü tek seferde verme.
Sadece ilk adımı yaz ve mutlaka "Devam edeyim mi?" diye sor.
Kullanıcı izin vermedikçe bir sonraki adımı üretme.
Büyük listeleri asla tek cevapta yazma.
`;
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

PRICE_LIST KURALLARI
- Ürün price_list’te varsa mutlaka fiyat kullan.
- Fiyat alanı boşsa: “price_list’te fiyat yok, yerelden sorulmalı” de.
- Listede olmayan ürünün fiyatını uydurma.
- Fiyatları KDV dahil yaz.

MALZEME LİSTESİ / TEKLİF CEVAPLARI
- Önce malzeme listesini çıkar (Ürün, Açıklama, Adet / Metre).
- Sonra ayrı bölümde “Fiyatlı tablo” ver:
  - Kolonlar: Ürün, Açıklama, Adet, Birim Fiyat (TL), Toplam (TL).
- PRICE_LIST’te olmayan kalemleri tablonun altına “Yerelden fiyat alınacak kalemler” başlığıyla ayrı listele.
- İşçilik maliyeti, montaj ücreti, proje çizim bedeli vb. HİÇBİRİ için fiyat yazma.

OTOMATİK MALZEME SEÇİM KURALLARI
Bu kurallar, bahçe için malzeme listesi çıkarırken ve teklif hazırlarken GEÇERLİDİR.

1) KONTROL ÜNİTESİ SEÇİMİ
- Müşteri elektrikli (220 V) sistem istiyorsa:
  - Sadece 1 model öner:
    - Rain Bird ESP-TM2 serisinden, istasyon sayısına uygun bir model seç (ör: 4 istasyon gerekliyse ESP-TM2 4).
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
- Solenoid vana sayısı kadar Rain Bird MTT-100 kollektör seç.
  - Örnek: 3 solenoid vana → 3 adet MTT-100.

7) ANA BORUYA GEÇİŞ ADAPTÖRLERİ
- Solenoid vana sayısı kadar, vana çıkışından ANA BORUYA geçmek için uygun çapta KAPLIN ERKEK ADAPTÖR seç.
  - Örnek: 3 solenoid vana → 3 adet kaplin erkek adaptör.

8) KAPLIN TAPA
- Solenoid vana sayısı kadar, ana boru üzerinde kullanılmak üzere ANA BORU ÇAPINA UYGUN kaplin tapa seç.
  - Örnek: 3 solenoid vana → 3 adet kaplin tapa.

9) SİNYAL KABLOSU SEÇİMİ (İstasyon/solenoid sayısına göre)
- 1–2 solenoid vana → 3 damarlı (3 renk) sinyal kablosu
- 3–4 solenoid vana → 5 damarlı (5 renk) sinyal kablosu
- 5–6 solenoid vana → 7 damarlı (7 renk) sinyal kablosu
- 7–8 solenoid vana → 9 damarlı (9 renk) sinyal kablosu
- 9–12 solenoid vana → 13 damarlı (13 renk) sinyal kablosu
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

// ------------------------------------------------------
// Google OAuth Routes
// ------------------------------------------------------

// Google ile giriş/kayıt başlat
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

// Google callback
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login.html" }),
  (req, res) => {
    const email = req.user && req.user.email;
    // Başarılı girişten sonra chate yönlendir,
// e-postayı query string ile gönderiyoruz
    if (email) {
      res.redirect("/index.html?googleEmail=" + encodeURIComponent(email));
    } else {
      res.redirect("/login.html");
    }
  }
);

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


// ------------------------------------------------------
// KULLANICI & ADMIN API'LERİ
// ------------------------------------------------------

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
  const users = loadUsers(); // sende zaten var olması lazım
  const user = users.find((u) => u.email === cleanEmail);

  if (!user) {
    return res
      .status(401)
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


// Kullanıcı profilini getir (limit ve kullanım)
app.post("/api/profile", (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: "E-posta eksik." });
  }

  const users = loadUsers();
  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  res.json({
    email: user.email,
    used: user.used || 0,
    limit: user.limit || 20,
    remaining: (user.limit || 20) - (user.used || 0),
  });
});

// ADMIN API BLOĞU
// -------------------------------------------

// Kullanıcı dosyasını oku (admin için)
function loadUsersFile() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

// Kullanıcı dosyasını kaydet (admin için)
function saveUsersFile(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

// Admin doğrulama middleware (yeniden)
function checkAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Geçersiz admin anahtarı." });
  }
  next();
}

// 1) Tüm kullanıcıları listele (özet)
app.get("/admin/users", checkAdmin, (req, res) => {
  const all = loadUsersFile();

  const mapped = all.map((u) => ({
    email: u.email,
    used: u.used || 0,
    limit: u.limit || 20,
    remaining: (u.limit || 20) - (u.used || 0),
    memoryCount: (u.memory || []).length,
  }));

  res.json({ users: mapped });
});

// 2) Kullanıcı güncelle
app.post("/admin/update-user", checkAdmin, (req, res) => {
  const { email, limit, resetUsed, resetMemory } = req.body;
  if (!email) return res.status(400).json({ error: "E-posta eksik." });

  const all = loadUsersFile();
  const idx = all.findIndex((u) => u.email === email);
  if (idx === -1)
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });

  if (typeof limit === "number") {
    all[idx].limit = limit;
  }
  if (resetUsed) {
    all[idx].used = 0;
  }
  if (resetMemory) {
    all[idx].memory = [];
  }

  saveUsersFile(all);

  const updated = all[idx];
  res.json({
    ok: true,
    user: {
      email: updated.email,
      used: updated.used || 0,
      limit: updated.limit || 20,
      remaining: (updated.limit || 20) - (updated.used || 0),
      memoryCount: (updated.memory || []).length,
    },
  });
});

// 3) Kullanıcı sohbet geçmişi getir
app.get("/admin/user-history", checkAdmin, (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: "E-posta eksik." });
  }

  const all = loadUsersFile();
  const user = all.find((u) => u.email === email);

  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  const history = Array.isArray(user.memory) ? user.memory : [];

  return res.json({
    success: true,
    email: user.email,
    history,
  });
});

// ------------------------------------------------------
// POST /api/sulama – JSON cevap (chat + proje paneli için)
// ------------------------------------------------------

app.post("/api/sulama", async (req, res) => {
  let { message, user, mode, designData, project } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message zorunlu." });
  }

  // Kullanıcı kontrolü
  if (!user || !user.email) {
    return res
      .status(400)
      .json({ error: "Kullanıcı bilgisi (email) zorunludur." });
  }

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
    return res.status(403).json({
      error:
        "Soru limitiniz dolmuştur. Lütfen admin ile iletişime geçin veya limitinizi yükseltin.",
      code: "LIMIT_EXCEEDED",
    });
  }

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

  // Eğer hala NON_IRRIGATION ise, kibarca reddet
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

  // Kullanıcının hafızasından son 20 mesajı al
  const history = Array.isArray(currentUser.memory)
    ? currentUser.memory.slice(-20)
    : [];
  const hasHistory = Array.isArray(history) && history.length > 0;

  // Ürün eşleme
  const relatedProducts = findRelatedProducts(message, 8);
  let productContext = "";
  if (relatedProducts.length > 0) {
    productContext =
      "İLGİLİ ÜRÜNLER VE FİYATLAR (CSV'den):\n" +
      relatedProducts
        .map((p) => {
          const fiyatMetni = getProductPriceText(p).trim();
          const fiyat =
            !fiyatMetni || fiyatMetni === "0"
              ? "Bu ürün için CSV'de fiyat bilgisi yok."
              : `${fiyatMetni} TL (KDV dahil varsayılabilir)`;
          return `- SKU: ${p["SKU"] || ""} | Ürün: ${
            p["Ürün Adı"] || p["Ad"] || ""
          } | Fiyat: ${fiyat}`;
        })
        .join("\n");
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
  { role: "system", content: STEP_CONTROLLER },
  { role: "system", content: systemPrompt }
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

  messages.push({ role: "user", content: message });

  // Kullanım arttır
  currentUser.used += 1;
  saveUsers(users);

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1",
      messages,
        max_tokens: 200,
        temperature: 0.4,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "Şu anda yanıt üretemiyorum, lütfen tekrar deneyin.";

    // Hafızayı güncelle
    users = loadUsers();
    currentUser = users.find((u) => u.email === user.email);
    if (!currentUser) return res.json({ reply });

    if (!Array.isArray(currentUser.memory)) currentUser.memory = [];
    currentUser.memory.push({ role: "user", content: message });
    currentUser.memory.push({ role: "assistant", content: reply });

    if (currentUser.memory.length > 40) {
      currentUser.memory = currentUser.memory.slice(-40);
    }

    saveUsers(users);

    res.json({
      reply,
      meta: {
        category,
        effectiveCategory,
        used: currentUser.used || 0,
        limit: currentUser.limit || 20,
        remaining: (currentUser.limit || 20) - (currentUser.used || 0),
        productCount: relatedProducts.length,
      },
    });
  } catch (err) {
    console.error("OpenAI hata:", err);
    res.status(500).json({
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
