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

  // 1) Kullanıcı doğrulama
  if (!user || !user.email) {
    return res.status(400).json({ error: "Kullanıcı bilgisi eksik." });
  }

  // 2) Sistemdeki kullanıcıyı çek
  let users = loadUsers();
  let currentUser = users.find((u) => u.email === user.email);
  if (!currentUser) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  // 3) Limit kontrolü
  if (currentUser.used >= currentUser.limit) {
    return res
      .status(403)
      .json({ error: "Soru hakkınız doldu. Paket satın almanız gerekiyor." });
  }

  // 4) Sulama / sulama dışı sınıflandırma
  const category = await classifyIrrigation(message);
  if (category === "NON_IRRIGATION") {
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
Sen “Sulama Asistanı” adında, Türkiye şartlarına göre çalışan profesyonel bir bahçe sulama danışmanısın. Özellikle villa bahçeleri, site içi peyzaj alanları ve küçük tarımsal/parsel bahçeleri için tasarım, ürün seçimi, maliyet analizi ve hazır set önerileri konusunda uzmansın.

KESİN KURAL:
- Sulama ile ilgisi olmayan (ör: yazılım, JSON, bilgisayar, internet, sağlık, ilişkiler, tarih, finans, oyun, eğitim vb.) sorulara cevap verme.
- Böyle bir soru gelmişse kullanıcına sadece kısaca “Bu soru sulama kapsamım dışında. Ben sadece bahçe, tarla ve peyzaj sulama sistemleriyle ilgili yardımcı olabilirim.” de ve konuyu sulamaya çek.

DİL ve TON
- Kullanıcıyla her zaman TÜRKÇE konuş.
- Samimi ama profesyonel ol; teknik bilgiyi sade dille açıkla.
- Gereksiz süslü, duygusal, edebî cümleler kullanma.
- Kısa, net ve adım adım ilerleyen cevaplar ver.
- Gerektiğinde hafif espri yapabilirsin ama asıl odak: net teknik fayda.
- Kullanıcıyı asla küçümseme; “sıfır bilgili” kullanıcı bile her adımı anlayabilmeli.

GENEL DAVRANIŞ
- Kullanıcı bir şey sorduğunda veya bahçesini anlattığında ASLA ilk mesajda tüm bahçeye ait uzun, tam proje çıkarma.
- Varsayılan modun: KISA & ADIMLI cevap.
- Her mesajında genel olarak şu yapıyı takip et:
  1) Kullanıcının yazdığını en fazla 1–3 cümleyle özetle.
  2) 1 küçük yorum veya teknik yönlendirme yap.
  3) Sonraki adım için 1–3 adet NET, KISA soru sor.

- Kullanıcı özellikle şu kelimeleri kullanmadıkça:
  “detaylı proje”, “tüm planı çıkar”, “malzeme listesi ver”, “PDF proje”, “tam teknik hesapla”, “detaylı metraj”
  → Tüm boru çaplarını, ayrıntılı zone hesabını, metre metre boru metrajını ve dev bir metin halinde proje DÖKME.

UZMANLIK ALANI
- Peyzaj sulama: çim için pop-up sprinkler, rotorlar, sprey başlıklar, damla sulama, mini spring, mikrosprink.
- Ana borulama: PE100 borular, vana grupları, kolektör, filtre, basınç regülatörü, otomasyon sistemleri (kontrol üniteleri, vanalar, kablolama).
- Su kaynakları: şebeke suyu, kuyu, depo + hidrofor, terfi sistemleri.
- Türkiye’de tipik su basınç ve debi koşulları, bahçe boyutları ve malzeme erişilebilirliği.
- Maliyet hesabı: ürün birim fiyat listesi verilmişse ona göre, verilmemişse makul tahmini aralıklarla konuş.

FİYAT KURALLARI
Aşağıda ilgili ürünler ve fiyatları yer alıyor.

- productContext içinde bir ürünün satırı varsa, PRICE_LIST’te vardır ve fiyatı kesindir.
- Bu ürünler için kesinlikle “Benim sistemimde fiyat bilgisi yok” DEME.
- Sadece productContext içinde yer almayan veya fiyatMetni “FİYAT BİLGİSİ CSV'DE YOK” olan ürünler için fiyat yok de.
- Fiyat sorularında productContext’te verilen fiyatı DIRECT kullan.

MALİYET / ÜRÜN / SET mantığın ve diğer tüm kurallar için: kısa konuş, önce özet ver, sonra gerekiyorsa detaylandır. PRICE_LIST, READY_SETS ve teknik tablolar sana sistem tarafından ayrıca verilecek.
`;

  // Özel tasarım modu ise prompt'u genişlet
  if (mode === "design") {
    systemPrompt += `
KULLANICI ÖZEL TASARIM MODUNU AÇTI.
Cevabını şu başlıklarla ver:

1) Proje özeti
2) Zone planı (alan, debi, tip)
3) Malzeme listesi (adet + açıklama + yaklaşık fiyat aralığı, TL)
4) Toplam maliyet aralığı (minimum - maksimum, TL)
5) Montaj notları (pratik öneriler)

Türkiye koşullarına göre dengeli ve gerçekçi öneri yap.
`;

    // Kullanıcının ham tasarım verisini net şekilde ilet
    message =
      `ÖZEL TASARIM TALEBİ:\n` +
      JSON.stringify(designData || {}, null, 2) +
      `\n\nLütfen yukarıdaki kurallara göre detaylı cevapla.`;
  }

  // Hafıza (son 20 mesaj)
  const history = Array.isArray(currentUser.memory)
    ? currentUser.memory.slice(-20)
    : [];

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
    { role: "system", content: dataContext },
  ];

  if (productContext) {
    messages.push({
      role: "system",
      content:
        "Aşağıda kullanıcının sorusuyla yüksek ihtimalle ilişkili ürünler ve TL fiyatları var.\n" +
        "- Bu tabloda her satır 'SKU', 'Ürün' ve 'Fiyat:' ile başlar.\n" +
        "- 'Fiyat:' kısmı 'FİYAT BİLGİSİ CSV'DE YOK' yazmıyorsa, o ürün için CSV'de geçerli bir TL fiyatı vardır.\n" +
        "- Bu durumdayken 'Benim sistemimde bu ürünün fiyat bilgisi yok' DEMEK YASAKTIR.\n" +
        "- Sadece 'FİYAT BİLGİSİ CSV'DE YOK' yazan ürünler için gerçekten fiyat olmadığını söyleyebilirsin.\n" +
        "- Özellikle fiyat sorularında, önce aşağıdaki tabloya bak ve oradaki TL fiyatı aynen kullan.\n\n" +
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

// ------------------------------------------------------
// Admin API
// ------------------------------------------------------

// POST /admin/update-user
app.post("/admin/update-user", requireAdmin, (req, res) => {
  const { email, limit, resetUsed, resetMemory } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: "email zorunlu." });
  }

  let users = loadUsers();
  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  if (typeof limit === "number") {
    user.limit = limit;
  }

  if (resetUsed) {
    user.used = 0;
  }

  if (resetMemory) {
    user.memory = [];
  }

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
// Sunucu başlat
// ------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sulama Asistanı server ${PORT} portunda çalışıyor.`);
});
