// server.js
// Sulama Asistanı backend

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");
const PDFDocument = require("pdfkit");

const app = express();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ------------------------------------------------------
// Veri dosyalarını JSON olarak yükleme
// ------------------------------------------------------

function loadJSON(fileName) {
  const filePath = path.join(__dirname, "data", fileName);
  if (!fs.existsSync(filePath)) {
    console.warn("Uyarı: JSON dosyası bulunamadı:", filePath);
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("JSON parse hatası:", filePath, err);
    return [];
  }
}

const PRICE_LIST     = loadJSON("price_list.json");
const READY_SETS     = loadJSON("ready_sets.json");
const NOZZLE_DATA    = loadJSON("nozzle_data.json");
const PE100_FRICTION = loadJSON("pe100_friction.json");
const DRIP_DATA      = loadJSON("drip_data.json");
const ZONE_LIMITS    = loadJSON("zone_limits.json");
const K_FACTORS      = loadJSON("k_factors.json");


const USERS_FILE = path.join(__dirname, "users.json");
const ADMIN_KEY  = process.env.ADMIN_KEY || "";

function getProductPriceText(p) {
  const raw =
    p["Fiyat TL (KDV dahil)"] ??
    p["Fiyat TL (KDV Dahil)"] ?? // olası varyasyon
    p["Fiyat TL"] ??
    p["Fiyat (TL)"] ??
    p["Fiyat"] ??
    p["Fiyat (KDV Dahil)"] ??
    p["Fiyat (KDV dahil)"];

  return raw ? String(raw) : "";
}


// ------------------------------------------------------
// Basit ürün arama – PRICE_LIST içinden
// ------------------------------------------------------

function findRelatedProducts(query, limit = 10) {
  if (!query || !PRICE_LIST || !Array.isArray(PRICE_LIST)) return [];

  let q = String(query).toLowerCase();

  // Sayıları harflerden ayır → “tm24” → “tm 2 4”
  q = q.replace(/(\d)/g, " $1 ");

  const words = q.split(/\s+/).filter(Boolean);

  const scored = PRICE_LIST.map((p) => {
    const text = [
      p["SKU"],
      p["Ürün Adı"],
      p["Model"],
      p["Kategori"],
      p["İşlev Grubu"],
      p["Kullanım Yeri"],
      p["Uygun Olduğu Sistemler"],
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    let score = 0;

    // Tam geçen ifade
    if (text.includes(q)) score += 5;

    // Kelime bazlı eşleşme
    for (const w of words) {
      if (text.includes(w)) score += 2;
    }

    // TM2 özel eşleşme kuralları
    if (q.includes("tm2") && text.includes("tm2")) score += 10;
    if (q.includes("4") && text.includes("4 ist") && text.includes("tm2"))
      score += 10;

    return { score, product: p };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.product);
}

// ------------------------------------------------------
// Sulama / sulama dışı sınıflandırma
// ------------------------------------------------------

async function classifyIrrigation(message) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Kullanıcının mesajını sınıflandır. Eğer mesaj bahçe, tarla, sera veya peyzaj SULAMA sistemleri, sulama ürünleri, sulama projeleri, debi-basınç hesabı, otomatik sulama cihazları gibi konularla ilgiliyse sadece 'IRRIGATION' yaz. Diğer tüm konular (yazılım, JSON, kod, bilgisayar, internet, sağlık, ilişkiler, tarih, finans, oyun, eğitim vb.) için sadece 'NON_IRRIGATION' yaz. Başka hiçbir şey yazma."
        },
        { role: "user", content: String(message) }
      ]
    });

    const raw =
      completion.choices?.[0]?.message?.content?.trim().toUpperCase() || "";

    if (raw === "IRRIGATION" || raw === "NON_IRRIGATION") {
      return raw;
    }

    if (raw.includes("NON")) return "NON_IRRIGATION";
    return "IRRIGATION";
  } catch (err) {
    console.error("Sınıflandırma hatası, varsayılan IRRIGATION:", err);
    // Sınıflandırmada problem olursa kullanıcıyı bloklamamak için sulama kabul et
    return "IRRIGATION";
  }
}

// ------------------------------------------------------
// Middleware
// ------------------------------------------------------

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Statik dosyalar (public klasörü)
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------------------
// Yardımcı fonksiyonlar (kullanıcılar)
// ------------------------------------------------------

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const defaultUser = {
      email: "deneme@deneme.com",
      password: "1234",
      limit: 50,
      used: 0,
      memory: [],
      projects: [],
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify([defaultUser], null, 2), "utf8");
    return [defaultUser];
  }

  const raw = fs.readFileSync(USERS_FILE, "utf8");
  if (!raw.trim()) return [];

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("users.json parse hatası:", err);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

// Admin kontrol middleware
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Geçersiz admin anahtarı." });
  }
  next();
}

// ------------------------------------------------------
// Auth / Kullanıcı Endpoint'leri
// ------------------------------------------------------

// POST /register
app.post("/register", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "email ve password zorunlu." });
  }

  let users = loadUsers();
  const existing = users.find((u) => u.email === email);
  if (existing) {
    return res.status(409).json({ error: "Bu e-posta ile kullanıcı zaten var." });
  }

  const newUser = {
    email,
    password,
    limit: 20,
    used: 0,
    memory: [],
    projects: [],
  };

  users.push(newUser);
  saveUsers(users);

  return res.json({
    success: true,
    email: newUser.email,
    limit: newUser.limit,
    used: newUser.used,
    remaining: newUser.limit - newUser.used,
  });
});

// POST /login
app.post("/login", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "email ve password zorunlu." });
  }

  const users = loadUsers();
  const user  = users.find((u) => u.email === email);

  if (!user || user.password !== password) {
    return res.status(401).json({ error: "E-posta veya şifre hatalı." });
  }

  const remaining = user.limit - user.used;

  return res.json({
    success: true,
    email: user.email,
    limit: user.limit,
    used: user.used,
    remaining,
  });
});

// POST /purchase – paket satın alma (soru limitini artır)
app.post("/purchase", (req, res) => {
  const { email, packageType } = req.body || {};
  if (!email || !packageType) {
    return res.status(400).json({ error: "email ve packageType zorunlu." });
  }

  let users = loadUsers();
  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  let add = 0;
  if (packageType === "mini") add = 50;
  else if (packageType === "pro") add = 200;
  else if (packageType === "bayi") add = 1000;
  else {
    return res.status(400).json({ error: "Geçersiz paket tipi." });
  }

  user.limit += add;
  saveUsers(users);

  return res.json({
    success: true,
    email: user.email,
    limit: user.limit,
    used: user.used,
    remaining: user.limit - user.used,
  });
});

// ------------------------------------------------------
// STREAMING /chat endpoint'i
// ------------------------------------------------------

app.post("/chat", async (req, res) => {
  let { message, user, mode, designData } = req.body;

  // 1) Kullanıcı doğrulama (DEV modu: user gelmezse guest kullan)
  if (!user || !user.email) {
    user = { email: "guest@sulamaasistani.local" };
  }

  // 2) Sistemdeki kullanıcıyı çek / yoksa oluştur
  let users = loadUsers();
  let currentUser = users.find((u) => u.email === user.email);

  if (!currentUser) {
    currentUser = {
      email: user.email,
      password: "",
      limit: 9999,          // Lokal geliştirme için bol limit
      used: 0,
      memory: [],
      projects: [],
      createdAt: new Date().toISOString()
    };

    users.push(currentUser);
    saveUsers(users);
  }

  // 3) Hafıza (son 20 mesaj) – BUNU currentUser oluştuKTAN SONRA yap
  const history = Array.isArray(currentUser.memory)
    ? currentUser.memory.slice(-20)
    : [];


  // 4) Sulama / sulama dışı sınıflandırma
  const category = await classifyIrrigation(message);

  // --- Sulama bağlamı var mı? (geçmiş user mesajlarına bak) ---
  const hasHistory = Array.isArray(history) && history.length > 0;

  let irrigationContextText = "";
  if (hasHistory) {
    irrigationContextText = history
      .filter((m) => m.role === "user")
      .map((m) => (m.content || "").toLowerCase())
      .join(" ");
  }

  const hasIrrigationInHistory =
    irrigationContextText.includes("bahçe") ||
    irrigationContextText.includes("bahce") ||
    irrigationContextText.includes("sulama") ||
    irrigationContextText.includes("sprink") ||
    irrigationContextText.includes("sprinkler") ||
    irrigationContextText.includes("damla") ||
    irrigationContextText.includes("damlama") ||
    irrigationContextText.includes("vana") ||
    irrigationContextText.includes("m²") ||
    irrigationContextText.includes("m2");

  // Kullanıcı kısa yanıt istiyorsa (varsayılan), modeli en fazla 3 cümleye ZORLA
let finalUserMessage = message;
const isDetailRequest = /detaylı|detayli|uzun|hesap|metraj|tam liste|tam malzeme|hidrolik|basınç hesabı/i.test(message);

if (!isDetailRequest) {
  finalUserMessage =
    "KURAL: Bana en fazla 3 cümlelik KISA bir cevap ver. Liste, paragraf, başlık, teknik açıklama, uzun metin yasak. Soruma sadece kısa, net ve tek noktadan cevap ver.\nKULLANICI MESAJI: " +
    message;
}


  // --- Mesaj tipi: sayı mı, devam isteği mi? ---
  const msg = (message || "").toLowerCase();

  const isNumericFollowup =
    typeof msg === "string" &&
    msg.length <= 30 &&
    /\d/.test(msg) &&
    hasHistory;

  // Kısa devam sorularını, ürün listesi ve fiyat isteyen soruları da kapsa
  const continuationKeywords = [
    "detay",
    "detaylı",
    "devam",
    "anlat",
    "hangi",
    "nasıl",
    "neresi",
    "nereden",
    "hangisi",
    "tamam",
    "yaz",
    "evet",
    // Ürün / liste / fiyat odaklı devam soruları
    "ürün",
    "urun",
    "liste",
    "listesini",
    "ürün listesi",
    "urun listesi",
    "ürün listesini",
    "urun listesini",
    "fiyat",
    "fiyatı",
    "fiyatı nedir",
    "fiyatları",
    "fiyatlarını",
    "fiyat bilgisi",
    "fiyatlarıyla",
    "fiyatlariyla",
    "verir misin",
    "yazar mısın",
    "yazarmısın",
    "çıkarır mısın",
    "cikarir misin"
  ];

  const isContinuationFollowup =
    typeof msg === "string" &&
    msg.length <= 160 && // "tam ürün listesini fiyatlarıyla verir misin?" gibi cümlelere izin
    continuationKeywords.some((kw) => msg.includes(kw)) &&
    hasHistory;

  // --- Etkin kategori ---
  let effectiveCategory = category;

  // Eğer model "NON_IRRIGATION" dese bile,
  // geçmişte sulama konuşuyorsak ve bu mesaj sadece kısa bir devam isteğiyse → SULAMA say
  if (
    category === "NON_IRRIGATION" &&
    hasIrrigationInHistory &&
    (isNumericFollowup || isContinuationFollowup)
  ) {
    effectiveCategory = "IRRIGATION";
  }

  // NON_IRRIGATION kontrolü artık effectiveCategory üzerinden
  if (effectiveCategory === "NON_IRRIGATION") {
    const remaining = currentUser.limit - currentUser.used;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Remaining", String(remaining));

    res.write(
      "Bu soru sulama kapsamım dışında. Ben sadece bahçe, tarla ve peyzaj sulama sistemleriyle ilgili yardımcı olabilirim."
    );
    return res.end();
  }


  // 5) Ürün eşleme: soruya göre PRICE_LIST’ten ilgili ürünleri bul
  const relatedProducts = findRelatedProducts(message, 8);

  let productContext = "";
  if (relatedProducts.length > 0) {
    productContext =
      "İLGİLİ ÜRÜNLER VE FİYATLAR (CSV'den):\n" +
      relatedProducts
        .map((p) => {
          // Tüm kolon varyasyonlarını kullanan ortak fonksiyon
          const temizFiyat = getProductPriceText(p).trim();

          let fiyatMetni;

          // Fiyat boşsa veya 0 ise “fiyat yok” de
          if (
            !temizFiyat ||
            temizFiyat === "0" ||
            temizFiyat === "0,00" ||
            temizFiyat === "0.00"
          ) {
            fiyatMetni =
              "FİYAT BİLGİSİ CSV'DE YOK (bu ürün için fiyat UYDURMA, müşteriye fiyat veremediğini söyle)";
          } else {
            fiyatMetni = `${temizFiyat} TL (CSV)`;
          }

          return `- SKU: ${p["SKU"]} | Ürün: ${p["Ürün Adı"]} | Fiyat: ${fiyatMetni}`;
        })
        .join("\n");
  }

  // 6) Sulama Asistanı sistem prompt'u
  let systemPrompt = `
Sen “Sulama Asistanı” adında, Türkiye şartlarına göre çalışan profesyonel bir sulama danışmanısın.
Villa / peyzaj bahçeleri için sprinkler ve damla sulama projelendirme, ürün seçimi, maliyet mantığı ve hazır set önerileri konusunda uzmansın.

KESİN KURAL
- Sulama ile ilgisi olmayan (ör: yazılım, JSON, bilgisayar, internet, ilişki, tarih, finans, oyun, eğitim vb.) sorulara cevap verme.
- Böyle bir soru gelirse sadece kısaca: 
  "Bu soru sulama sistemleriyle ilgili değil. Ben sadece bahçe sulama, damlama, sprinkler ve otomatik sulama sistemleriyle ilgili yardımcı olabilirim."
  de ve konuyu sulamaya çek.

DİL ve TON
- Kullanıcıyla her zaman TÜRKÇE konuş.
- Samimi ama profesyonel ol; teknik bilgiyi sade dille anlat.
- Gereksiz süslü, duygusal, edebî cümleler KULLANMA.
- Kullanıcıyı asla küçümseme; sıfır bilgili bir bahçe sahibi bile her adımı anlayabilmeli.

GENEL DAVRANIŞ (ÇOK ÖNEMLİ)

- Kullanıcının sorusunu önce niyetine göre analiz et:
  1) Sorunun amacı kısa bir bilgi almak mı?
  2) Yoksa mühendislik/teknik analiz, basınç hesabı, zone planı, proje detayı gibi derin bir açıklama mı istiyor?

--------------------------------------------
1) KISA SORULARDA (varsayılan format)
--------------------------------------------
- Genel, kısa, yönlendirici veya basit bilgi isteyen sorularda cevabın:
  → EN FAZLA 3 CÜMLE olacak.
- Format her zaman şu:
  1) Kullanıcının isteğini tek bir cümleyle özetle.
  2) Zone / boru çapı / ürün tipi gibi temel yönlendirmeyi tek cümlede ver.
  3) Bir sonraki adımı belirten 1 cümlelik yönlendirme yap.
- Bu modda:
  • Madde işareti kullanma.
  • Tablo verme.
  • Uzun paragraf yazma.
  • Teknik sayı detayına girme (bar, L/dk vs).
  • Proje şeması, hesap veya metraj çıkarma.
- Kısa format; “Tamam”, “yaz”, “evet”, “devam”, “hangi”, “nasıl”, “ürünleri yazar mısın?” gibi basit takip sorularında da geçerlidir.

--------------------------------------------
2) DETAYLI TEKNİK / MÜHENDİSLİK SORULARINDA
--------------------------------------------
- Eğer kullanıcı şu tarz ifadeler kullanırsa:
  “detaylı anlat”, 
  “basınç kaybı hesabı yap”, 
  “neden düşüyor açıklayarak yaz”, 
  “boru çapı hesapla”, 
  “hidrolik hesap”, 
  “zone planını çıkar”, 
  “detaylı proje ver”, 
  “metraj çıkar”, 
  “tam malzeme listesi”,
  “teknik olarak açıkla”
→ Bu durumda 3 cümle kuralı uygulanmaz.

- Bu modda yazım kuralları:
  • Cevabı 2–5 ARASI KISA PARAGRAFA böl.
  • Her paragraf 2–3 cümleden oluşsun.
  • Teknik değerler gerekiyorsa bar, L/dk, debi limitleri, boru sürtünme kayıpları gibi sayıları kullanabilirsin.
  • Açıklamalar net, adım adım ve kullanıcıyı boğmadan olmalı.
  • Roman gibi tek blok yazma; her paragraf tek bir fikri anlatsın.
  • Okunabilirlik her zaman önceliklidir.
  • Gerekirse küçük madde işaretleri kullanılabilir.

--------------------------------------------
3) FİYAT VE MALZEME LİSTESİ İSTENDİĞİNDE
--------------------------------------------
- Kullanıcı “ürün listesi”, “tam liste”, “malzeme listesi”, “fiyatlarla yaz” gibi şeyler söylerse:
  • 3 cümle formatı devre dışı kalır.
  • Liste şeklinde yazmak serbesttir.
  • Fiyat istiyorsa fiyat ver (ürün fiyatı sistemde yoksa bunu belirt).
  • Sprink/rotor adetlerine göre priz kolye + kaplin erkek dirsek kuralını uygula.

--------------------------------------------
4) ÜSLUP
--------------------------------------------
- Ton: sakin, net, profesyonel ve kolay anlaşılır.
- Kullanıcı teknik bilmiyormuş gibi yaz ama aptal yerine koyma.
- Gereksiz edebiyat, süslü anlatım, “roman tarzı” uzun akışlar yasak.
- Her cevap son derece fonksiyonel ve amaca yönelik olmalı.

--------------------------------------------
5) NE ZAMAN FORMAT DEĞİŞTİRİLMEZ?
--------------------------------------------
- Kullanıcı net olarak “kısa yaz”, “özet yaz” derse → 3 cümleye dön.
- Kullanıcı format talep etmiyorsa otomatik analizle uygun moda geç.



İÇ VERİ SETLERİ (KULLANICIYA GÖSTERME)
- Arkada PRICE_LIST, READY_SETS, NOZZLE_DATA, DRIP_DATA, PE100_FRICTION, ZONE_LIMITS ve K_FACTORS gibi JSON tabloları kullanıyorsun.
- Bunlar senin iç veri tabanındır; CEVAPLARINDA BU İSİMLERİ ASLA ANMA.
- Kullanıcıya bunlardan bahsederken sadece doğal Türkçe kullan:
  - “nozul verileri” veya “sprinkler debi tablosu”,
  - “damla sulama verileri” veya “damlama hat debi tablosu”,
  - “PE100 basınç kaybı tablosu”,
  - “bağlantı kaybı katsayıları” vb.
- Asla şu kelimeleri yazma:
  "NOZZLE_DATA", "DRIP_DATA", "PE100_FRICTION", "K_FACTORS", "PRICE_LIST", "READY_SETS", "ZONE_LIMITS".

BORU ÇAPI / LATERAL KURALI
- Ana hat (şebekeden veya hidrofordan vana kutusuna kadar) için varsayılan boru çapın: PE100 32 mm.
- Zone içi LATERAL hatlarda (vana → sprinkler / damla boru) varsayılan boru çapın: PE100 20 mm’dir; BUNU DEĞİŞTİRME.
- Villa / peyzaj bahçelerinde lateraller için 25 mm veya 32 mm boru ÖNERME; özellikle “lateral” kelimesi geçen hiçbir cümlede 25 mm yazma.
- Lateral boru söylemen gerekiyorsa sadece şöyle yaz:
  "PE100 20 mm lateral hat (SKU: KALPE1002016)".
- 25 mm boru sadece gerekiyorsa çok kısa ana bağlantılarda veya kolektör yanlarında kullanılabilir; bunu da 1 cümleyi geçmeyecek şekilde, teknik detaya boğmadan yaz.

MALZEME LİSTESİ – PRİZ KOLYE ve ERKEK DİRSEK KURALI
- Ana hat borusu 32 mm veya 40 mm ise ve sistemde sprinkler veya rotor kullanıyorsan:
  - Toplam sprinkler + rotor adedi kadar uygun çapta priz kolye ver.
  - Her bir priz kolye için 2 adet 20 mm x 1/2" kaplin dış dişli (erkek) dirsek ver.
- Bu kuralı formül olarak AKLINDA TUT:
  - priz kolye adedi = sprinkler adedi + rotor adedi
  - 20 x 1/2" kaplin dış dişli erkek dirsek adedi = (sprinkler + rotor) x 2
- Malzeme listesi yazarken bu adetleri NET ve AÇIK şekilde cümleyle belirt:
  Örnek ifade: "10 adet rotor için 10 adet 32 mm priz kolye ve 20 adet 20 x 1/2\" kaplin dış dişli erkek dirsek gerekir."
- Varsayılan cevapta SKU vermek zorunda değilsin; kullanıcı özellikle kod istemedikçe sadece ürün tipini yaz.

FİYAT KURALLARI
- PRICE_LIST ve productContext içindeki fiyatlar senin için referanstır, ama kullanıcıya HER ZAMAN fiyat vermek zorunda değilsin.
- Kullanıcı özellikle “fiyat”, “kaç TL”, “maliyeti ne”, “bütçe”, “metre fiyatı”, “toplam ne tutar” gibi kelimelerle fiyat/maliyet sormadıkça:
  - Ürünleri TL cinsinden fiyatla yazma.
  - İstersen sadece: “İstersen bu ürünlerin yaklaşık fiyatlarını da yazabilirim.” diye teklif et.
- Kullanıcı açıkça fiyat veya maliyet sorarsa:
  - productContext’teki fiyatı kullan ve kısa yaz: 
    "Bu ürünün toptansulama.com’daki güncel fiyatı yaklaşık X TL’dir." 
  - Birden çok ürün varsa 3–5 satırı geçmeyecek şekilde en önemli ürünleri özetle.
  - productContext’te fiyat yoksa: 
    "Bu ürünün fiyatı listemde yok; güncel fiyat için toptansulama.com’dan bakman daha doğru olur." de.

ÜRÜN KODU ve TEKNİK DETAY KURALI
- Varsayılan cevaplarda ürün KODU / SKU yazma; sadece ürün tipini ve markasını söyle (örneğin “Rain Bird 3504 rotor sprinkler” gibi).
- Kullanıcı özellikle “ürün kodlarını da yazar mısın”, “SKU lazım”, “stok kodu ver” gibi istemedikçe SKU göstermeyi yasak kabul et.
- Varsayılan cevaplarda ayrıntılı debi / basınç hesabı (L/dk, bar, ~0,3–0,4 bar vb.) yazma; sadece “basınç açısından uygundur” veya “hidrolik açıdan yeterli olur” gibi kısa ifadeler kullan.
- Kullanıcı özellikle “hidrolik hesabını da yaz”, “basınç / debi hesabını göster” derse bir SONRAKİ cevabında teknik sayıları kullanarak detay verebilirsin.

SATIN ALMA / SİTE YÖNLENDİRMESİ
- Uygun yerlerde kısaca:
  "Bu ürünü toptansulama.com üzerinden temin edebilirsin."
  diye yönlendirme yap.
- Kullanıcı “nereden alırım”, “hangi siteden”, “online alabilir miyim”, “link var mı” gibi sorular sorarsa:
  - Öncelikle toptansulama.com’u öner; başka site ismi vermene gerek yok.
- Çok uzun tanıtım yapma; yönlendirme 1 cümleyi geçmesin.

UZMANLIK ALANI
- Peyzaj / villa bahçesi sulama:
  - Çim alanlar için pop-up sprinkler, rotorlar, rotary nozullar (Rain Bird marka).
  - Çiçek, çalı, bordür ve sebze alanları için damlama ve mini-sprink sistemleri.
- Ana borulama ve ekipman:
  - PE100 borular, vana grupları, kolektör, filtre, vana kutuları, otomasyon (kontrol ünitesi, kablolama).
- Su kaynakları:
  - Şebeke suyu, kuyu, depo + hidrofor, terfi sistemleri; Türkiye’de tipik basınç / debi koşulları.
- Maliyet mantığı:
  - Ürün birim fiyat listesi varsa ona göre, yoksa sadece “düşük/orta/yüksek maliyet” gibi niteliksel yorum yap.

GENEL ÖZET
- Kısa yaz, en fazla 4 cümle.
- Lateral borularda varsayılan PE100 20 mm (KALPE1002016) kullan.
- Fiyatları sadece kullanıcı sorarsa ver; aksi durumda fiyat yazma, sadece ürün tiplerini ve grupları söyle.
- Mümkün olduğunda toptansulama.com’a yönlendir.
- İç veri seti isimlerini asla gösterme; her şeyi son kullanıcı gözüyle, sade Türkçe ve sulama odaklı anlat.
`;

  // JSON veri context'i (fiyat listesi, hazır setler, teknik tablolar)
  const dataContext = `
PRICE_LIST = ${JSON.stringify(PRICE_LIST)};
READY_SETS = ${JSON.stringify(READY_SETS)};
NOZZLE_DATA = ${JSON.stringify(NOZZLE_DATA)};
PE100_FRICTION = ${JSON.stringify(PE100_FRICTION)};
DRIP_DATA = ${JSON.stringify(DRIP_DATA)};
ZONE_LIMITS = ${JSON.stringify(ZONE_LIMITS)};
K_FACTORS = ${JSON.stringify(K_FACTORS)};
`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "assistant", content: "(Bu iç veri setidir, kullanıcıya gösterme.) " + dataContext },
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

  messages.push(
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message }
  );

  // Kullanım hakkını bir artır ve kaydet (SADECE sulama sorularında)
  currentUser.used += 1;
  saveUsers(users);

  // Streaming response ayarları
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Remaining", String(currentUser.limit - currentUser.used));

  let fullReply = "";

  try {
    const stream = await client.chat.completions.create({
      model: "gpt-5.1",
      messages,
      stream: true,
    });

    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content || "";
      if (delta) {
        fullReply += delta;
        res.write(delta);
      }
    }

    res.end();
  } catch (err) {
    console.error("OpenAI streaming hata:", err);
    if (!fullReply) {
      return res
        .status(500)
        .end("Sunucu hatası: Asistan şu anda yanıt veremiyor.");
    } else {
      res.write(
        "\n\n[Uyarı] Cevap tam olarak tamamlanamadı, lütfen tekrar deneyin."
      );
      return res.end();
    }
  }

  // Streaming bittikten sonra hafıza + proje kaydı
  try {
    users = loadUsers();
    currentUser = users.find((u) => u.email === user.email);
    if (!currentUser) return;

    if (!Array.isArray(currentUser.memory)) currentUser.memory = [];
    currentUser.memory.push({ role: "user", content: message });
    currentUser.memory.push({ role: "assistant", content: fullReply });

    if (currentUser.memory.length > 40) {
      currentUser.memory = currentUser.memory.slice(-40);
    }

    if (mode === "design") {
      if (!Array.isArray(currentUser.projects)) currentUser.projects = [];
      const now = new Date();
      const id = String(now.getTime());
      const title =
        (designData && designData.title) ||
        `Özel Tasarım - ${now.toLocaleString("tr-TR")}`;

      currentUser.projects.push({
        id,
        title,
        type: "design",
        createdAt: now.toISOString(),
        summary: fullReply.slice(0, 400),
        content: fullReply,
        rawDesignData: designData || {},
      });
    }

    saveUsers(users);
  } catch (err) {
    console.error("Streaming sonrası kullanıcı kaydetme hatası:", err);
  }
});

// ------------------------------------------------------
// Proje endpoint'leri
// ------------------------------------------------------

// GET /projects?email=...
app.get("/projects", (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: "email parametresi zorunlu." });
  }

  const users = loadUsers();
  const user  = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  const projects = Array.isArray(user.projects) ? user.projects : [];

  const list = projects.map((p) => ({
    id: p.id,
    title: p.title,
    type: p.type,
    createdAt: p.createdAt,
    summary: p.summary || "",
  }));

  return res.json({ projects: list });
});

// GET /projects/:id?email=...
app.get("/projects/:id", (req, res) => {
  const email = req.query.email;
  const id    = req.params.id;

  if (!email || !id) {
    return res
      .status(400)
      .json({ error: "email parametresi ve id zorunludur." });
  }

  const users = loadUsers();
  const user  = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  const projects = Array.isArray(user.projects) ? user.projects : [];
  const project  = projects.find((p) => p.id === id);

  if (!project) {
    return res.status(404).json({ error: "Proje bulunamadı." });
  }

  return res.json({ project });
});

// ------------------------------------------------------
// PDF export
// ------------------------------------------------------

// POST /export-pdf { email, title, content }
app.post("/export-pdf", (req, res) => {
  const { email, title, content } = req.body || {};

  if (!email || !title || !content) {
    return res
      .status(400)
      .json({ error: "email, title ve content zorunlu." });
  }

  const users = loadUsers();
  const user  = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  const safeTitle =
    title.replace(/[^\wığüşöçİĞÜŞÖÇ\- ]+/g, "_").slice(0, 80) || "proje";
  const fileName = `${safeTitle}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileName}"`
  );

  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
  });

  doc.pipe(res);

  doc.fontSize(18).text(title, { align: "center" });
  doc.moveDown();

  const paragraphs = String(content).split(/\n{2,}/);
  doc.fontSize(11);

  paragraphs.forEach((p) => {
    doc.text(p.trim());
    doc.moveDown(0.7);
  });

  doc.end();
});


function loadUsersFile() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function saveUsersFile(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

// Admin doğrulama middleware
function checkAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Yetkisiz" });
  }
  next();
}

// 1) Kullanıcı listesini getir
app.get("/admin/users", checkAdmin, (req, res) => {
  const all = loadUsersFile();

  const mapped = all.map(u => ({
    email: u.email,
    used: u.used || 0,
    limit: u.limit || 20,
    remaining: (u.limit || 20) - (u.used || 0),
    memoryCount: (u.memory || []).length
  }));

  res.json({ users: mapped });
});

// 2) Kullanıcı güncelle
app.post("/admin/update-user", checkAdmin, (req, res) => {
  const { email, limit, resetUsed, resetMemory } = req.body;
  if (!email) return res.status(400).json({ error: "E-posta eksik." });

  const all = loadUsersFile();
  const idx = all.findIndex(u => u.email === email);
  if (idx === -1) return res.status(404).json({ error: "Kullanıcı bulunamadı." });

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
    success: true,
    user: {
      email: updated.email,
      used: updated.used || 0,
      limit: updated.limit || 20,
      remaining: (updated.limit || 20) - (updated.used || 0),
      memoryCount: (updated.memory || []).length
    }
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

  // 1) Kullanıcı doğrulama (guest fallback)
  if (!user || !user.email) {
    user = { email: "guest@sulamaasistani.local" };
  }

  // 2) Kullanıcıyı çek / yoksa oluştur
  let users = loadUsers();
  let currentUser = users.find((u) => u.email === user.email);

  if (!currentUser) {
    currentUser = {
      email: user.email,
      password: "",
      limit: 9999,
      used: 0,
      memory: [],
      projects: [],
      createdAt: new Date().toISOString(),
    };
    users.push(currentUser);
    saveUsers(users);
  }

  const history = Array.isArray(currentUser.memory)
    ? currentUser.memory.slice(-20)
    : [];

  // 3) Sınıflandırma
  const category = await classifyIrrigation(message);

  let irrigationContextText = "";
  const hasHistory = Array.isArray(history) && history.length > 0;

  if (hasHistory) {
    irrigationContextText = history
      .filter((m) => m.role === "user")
      .map((m) => (m.content || "").toLowerCase())
      .join(" ");
  }

  const hasIrrigationInHistory =
    irrigationContextText.includes("bahçe") ||
    irrigationContextText.includes("bahce") ||
    irrigationContextText.includes("sulama") ||
    irrigationContextText.includes("sprink") ||
    irrigationContextText.includes("sprinkler") ||
    irrigationContextText.includes("damla") ||
    irrigationContextText.includes("damlama") ||
    irrigationContextText.includes("vana") ||
    irrigationContextText.includes("m²") ||
    irrigationContextText.includes("m2");

  const msg = (message || "").toLowerCase();

  const isNumericFollowup =
    typeof msg === "string" &&
    msg.length <= 30 &&
    /\d/.test(msg) &&
    hasHistory;

  const continuationKeywords = [
    "detay",
    "detaylı",
    "devam",
    "anlat",
    "hangi",
    "nasıl",
    "neresi",
    "nereden",
    "hangisi",
    "tamam",
    "yaz",
    "evet",
    "ürün",
    "urun",
    "liste",
    "listesini",
    "ürün listesi",
    "urun listesi",
    "ürün listesini",
    "urun listesini",
    "fiyat",
    "fiyatı",
    "fiyatı nedir",
    "fiyatları",
    "fiyatlarını",
    "fiyat bilgisi",
    "fiyatlarıyla",
    "fiyatlariyla",
    "verir misin",
    "yazar mısın",
    "yazarmısın",
    "çıkarır mısın",
    "cikarir misin",
  ];

  const isContinuationFollowup =
    typeof msg === "string" &&
    msg.length <= 160 &&
    continuationKeywords.some((kw) => msg.includes(kw)) &&
    hasHistory;

  let effectiveCategory = category;

  if (
    category === "NON_IRRIGATION" &&
    hasIrrigationInHistory &&
    (isNumericFollowup || isContinuationFollowup)
  ) {
    effectiveCategory = "IRRIGATION";
  }

  if (effectiveCategory === "NON_IRRIGATION") {
    const reply =
      "Bu soru sulama kapsamım dışında. Ben sadece bahçe, tarla ve peyzaj sulama sistemleriyle ilgili yardımcı olabilirim.";
    return res.json({ reply });
  }

  // 4) Ürün eşleme
  const relatedProducts = findRelatedProducts(message, 8);

  let productContext = "";
  if (relatedProducts.length > 0) {
    productContext =
      "İLGİLİ ÜRÜNLER VE FİYATLAR (CSV'den):\n" +
      relatedProducts
        .map((p) => {
          const temizFiyat = getProductPriceText(p).trim();
          let fiyatMetni;

          if (
            !temizFiyat ||
            temizFiyat === "0" ||
            temizFiyat === "0,00" ||
            temizFiyat === "0.00"
          ) {
            fiyatMetni =
              "FİYAT BİLGİSİ CSV'DE YOK (bu ürün için fiyat UYDURMA, müşteriye fiyat veremediğini söyle)";
          } else {
            fiyatMetni = `${temizFiyat} TL (CSV)`;
          }

          return `- SKU: ${p["SKU"]} | Ürün: ${p["Ürün Adı"]} | Fiyat: ${fiyatMetni}`;
        })
        .join("\n");
  }

  // 5) Sistem prompt'u (aynı ama proje bilgisiyle güçlendirilmiş)
  let systemPrompt2 = `
Sen “Sulama Asistanı” adında, Türkiye şartlarına göre çalışan profesyonel bir sulama danışmanısın.
Villa / peyzaj bahçeleri için sprinkler ve damla sulama projelendirme, ürün seçimi, maliyet mantığı ve hazır set önerileri konusunda uzmansın.

AŞAĞIDAKİ PROJE ÖN BİLGİLERİNİ MUTLAKA DİKKATE AL:
${project ? JSON.stringify(project, null, 2) : "(Proje bilgisi kısıtlı veya yok)"}

Diğer tüm kurallar, üslup ve davranış biçimi /chat endpoint’inde tarif edilenle aynıdır:
- Kısa sorularda en fazla 3 cümle.
- Detaylı teknik istenirse 2–5 kısa paragraf.
- Lateral hatlarda PE100 20 mm kullan, 25 mm lateral önermemek vb.
`;

  if (mode === "design") {
    systemPrompt2 += `
KULLANICI ÖZEL TASARIM MODUNU AÇTI.
Cevabını şu başlıklarla ver:

1) Proje özeti
2) Zone planı (alan, debi, tip)
3) Malzeme listesi (adet + açıklama + yaklaşık fiyat aralığı, TL)
4) Toplam maliyet aralığı (minimum - maksimum, TL)
5) Montaj notları (pratik öneriler)

Türkiye koşullarına göre dengeli ve gerçekçi öneri yap.
`;
    message =
      `ÖZEL TASARIM TALEBİ:\n` +
      JSON.stringify(designData || {}, null, 2) +
      `\n\nLütfen yukarıdaki kurallara göre detaylı cevapla.`;
  }

  const dataContext2 = `
PRICE_LIST = ${JSON.stringify(PRICE_LIST)};
READY_SETS = ${JSON.stringify(READY_SETS)};
NOZZLE_DATA = ${JSON.stringify(NOZZLE_DATA)};
PE100_FRICTION = ${JSON.stringify(PE100_FRICTION)};
DRIP_DATA = ${JSON.stringify(DRIP_DATA)};
ZONE_LIMITS = ${JSON.stringify(ZONE_LIMITS)};
K_FACTORS = ${JSON.stringify(K_FACTORS)};
`;

  const messages = [
    { role: "system", content: systemPrompt2 },
    {
      role: "assistant",
      content: "(Bu iç veri setidir, kullanıcıya gösterme.) " + dataContext2,
    },
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

  messages.push(
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message }
  );

  // Kullanım arttır
  currentUser.used += 1;
  saveUsers(users);

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-5.1",
      messages,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "Asistan şu anda yanıt üretemedi.";

    // Hafızaya yaz
    try {
      users = loadUsers();
      currentUser = users.find((u) => u.email === user.email);
      if (currentUser) {
        if (!Array.isArray(currentUser.memory)) currentUser.memory = [];
        currentUser.memory.push({ role: "user", content: message });
        currentUser.memory.push({ role: "assistant", content: reply });

        if (currentUser.memory.length > 40) {
          currentUser.memory = currentUser.memory.slice(-40);
        }

        if (mode === "design") {
          if (!Array.isArray(currentUser.projects)) currentUser.projects = [];
          const now = new Date();
          const id = String(now.getTime());
          const title =
            (designData && designData.title) ||
            `Özel Tasarım - ${now.toLocaleString("tr-TR")}`;

          currentUser.projects.push({
            id,
            title,
            type: "design",
            createdAt: now.toISOString(),
            summary: reply.slice(0, 400),
            content: reply,
            rawDesignData: designData || {},
          });
        }

        saveUsers(users);
      }
    } catch (err) {
      console.error("JSON endpoint sonrası hafıza kaydetme hatası:", err);
    }

    // Şimdilik sadece reply dönüyoruz; ileride projectUpdate ekleriz
    return res.json({
      reply,
      projectUpdate: null,
    });
  } catch (err) {
    console.error("/api/sulama OpenAI hata:", err);
    return res
      .status(500)
      .json({ error: "Sunucu hatası: Asistan şu anda yanıt veremiyor." });
  }
});

// -------------------------------------------
// ADMIN API BLOĞU
// -------------------------------------------


// Kullanıcı dosyasını oku
function loadUsersFile() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

// Kullanıcı dosyasını kaydet
function saveUsersFile(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

// Admin doğrulama middleware
function checkAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Yetkisiz" });
  }
  next();
}

// Tüm kullanıcıları getir
app.get("/admin/users", checkAdmin, (req, res) => {
  const all = loadUsersFile();

  const mapped = all.map(u => ({
    email: u.email,
    used: u.used || 0,
    limit: u.limit || 20,
    remaining: (u.limit || 20) - (u.used || 0),
    memoryCount: (u.memory || []).length
  }));

  res.json({ users: mapped });
});

// Kullanıcı limiti / kullanım / hafıza güncelle
app.post("/admin/update-user", checkAdmin, (req, res) => {
  const { email, limit, resetUsed, resetMemory } = req.body;

  if (!email) {
    return res.status(400).json({ error: "E-posta eksik." });
  }

  const all = loadUsersFile();
  const idx = all.findIndex(u => u.email === email);

  if (idx === -1) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  // Limit güncelle
  if (typeof limit === "number") {
    all[idx].limit = limit;
  }

  // Kullanımı sıfırla
  if (resetUsed) {
    all[idx].used = 0;
  }

  // Hafızayı sıfırla
  if (resetMemory) {
    all[idx].memory = [];
  }

  saveUsersFile(all);

  const updated = all[idx];

  res.json({
    success: true,
    user: {
      email: updated.email,
      used: updated.used || 0,
      limit: updated.limit || 20,
      remaining: (updated.limit || 20) - (updated.used || 0),
      memoryCount: (updated.memory || []).length
    }
  });
});


// ------------------------------------------------------
// Sunucu başlat
// ------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sulama Asistanı server ${PORT} portunda çalışıyor.`);
});
