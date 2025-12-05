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

const USERS_FILE = path.join(__dirname, "users.json");
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// -------------------------------------------------------------------
// Middleware
// -------------------------------------------------------------------

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Statik dosyalar (public klasörü)
app.use(express.static(path.join(__dirname, "public")));

// -------------------------------------------------------------------
// Yardımcı fonksiyonlar
// -------------------------------------------------------------------

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
    fs.writeFileSync(
      USERS_FILE,
      JSON.stringify([defaultUser], null, 2),
      "utf-8"
    );
    return [defaultUser];
  }

  const raw = fs.readFileSync(USERS_FILE, "utf-8");
  if (!raw.trim()) return [];

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("users.json parse hatası:", err);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
}

// Admin kontrol middleware
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Geçersiz admin anahtarı." });
  }
  next();
}

// -------------------------------------------------------------------
// Auth / Kullanıcı Endpoint'leri
// -------------------------------------------------------------------

// POST /register
app.post("/register", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "email ve password zorunlu." });
  }

  let users = loadUsers();
  const existing = users.find((u) => u.email === email);
  if (existing) {
    return res
      .status(400)
      .json({ error: "Bu e-posta ile zaten kayıtlı bir kullanıcı var." });
  }

  const newUser = {
    email,
    password, // TODO: ileride hash
    limit: 50,
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
  const user = users.find((u) => u.email === email);

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

// POST /purchase
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

// -------------------------------------------------------------------
// STREAMING /chat endpoint'i (düzeltilmiş final sürüm)
// -------------------------------------------------------------------

app.post("/chat", async (req, res) => {
  let { message, user, mode, designData } = req.body;

  // 1) Kullanıcı doğrulama
  if (!user || !user.email) {
    return res.status(400).json({ error: "Kullanıcı bilgisi eksik." });
  }

  // Sistemdeki kullanıcıyı çek
  let users = loadUsers();
  let currentUser = users.find((u) => u.email === user.email);
  if (!currentUser) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  // 2) Limit kontrolü
  if (currentUser.used >= currentUser.limit) {
    return res
      .status(403)
      .json({ error: "Soru hakkınız doldu. Paket satın almanız gerekiyor." });
  }

  // 3) Sistem prompt
  let systemPrompt = `
Sen "Sulama Asistanı" isimli yapay zekâsın.
Türkiye şartlarında villa / site / peyzaj bahçeleri için profesyonel bir sulama mühendisi gibi davranacaksın.

Görevin:
- Kullanıcının verdiği bahçe bilgilerine göre profesyonel sulama hesabı yapmak,
- Sprink sayısı, zone sayısı, vana sayısı, boru uzunluğu, boru çapı, kablo, filtre, kollektör, fittings ve tüm sarf malzemelerini otomatik olarak hesaplamak,
- Sonuçta eksiksiz bir malzeme listesi (BOM) çıkarmak.

Kullanıcı hiçbir hesap yapmayacak. Tüm hesapları kendin yapacaksın.

────────────────────────────────────────
1) Sprink sayısını bahçeye ve modele göre hesapla.
2) Debi + zone limitine göre solenoid vana sayısını çıkar.
3) Ana hat boru uzunluğunu kaynak → kolektör + kolektör → son sprink şeklinde hesapla.
4) Lateral boru uzunluğu = sprink sayısı × 2 m.
5) Kontrol ünitesi istasyon sayısını vana sayısına göre (4/6/8/12) seç.
6) Sinyal kablosu: damar = vana sayısı + 1. Kablo: 3/5/7/9/13 damar’dan uygun olanı seç.
7) Vana kutusu: 1→6", 2→10", 3→12", 4→14", 4+ için mantıklı dağıtım yap.
8) Priz kolye: Sprey & 3504 = 1/2", 5004 = 3/4". Adet = sprink sayısı.
9) Filtre sistemi: Boru çapına göre filtre + küresel vana + adaptör kombinasyonu seç.
10) 20 mm erkek dirsek: priz kolye adedi × 2 (1/2" veya 3/4").
11) Kontrol panosu: istasyon sayısına göre uygun pano seç.
12) Kolektör: 1" solenoid vana varsa, vana sayısı kadar MTT-100 + 1 adet 1" dişi tapa + giriş adaptörü ekle.
13) Vana adaptörleri: vana sayısı kadar erkek adaptör + vana sayısı kadar kaplin tapa.
14) Yedek fittings: boru çapına göre 2 te + 2 dirsek + 2 manşon ekle.
15) Teflon bant: minimum 1, gerekirse 2 adet.
16) Elektrik bandı: 1 adet.
17) Montaj eldiveni: 1 adet.

GENEL KURALLAR:
- Tüm hesaplamaları kendin yap, kullanıcıya “sen hesapla” deme.
- Listeyi gruplandır (Sprinkler, Vanalar, Borular, Elektrik, Fittings, Sarf).
- Her üründe: ürün adı, adet/metre ve kısa açıklama ver.
- Teknik ol ama sade ve anlaşılır Türkçe yaz.
────────────────────────────────────────
`;

  // 4) Özel tasarım modu ise prompt'u genişlet
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

    message =
      `ÖZEL TASARIM TALEBİ:\n` +
      JSON.stringify(designData || {}, null, 2) +
      `\n\nLütfen yukarıdaki başlıklara göre detaylı cevapla.`;
  }

  // 5) Hafıza (son 20 mesaj)
  const history = Array.isArray(currentUser.memory)
    ? currentUser.memory.slice(-20)
    : [];

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];

  // 6) Kullanım hakkını düş
  currentUser.used += 1;
  saveUsers(users);

  // 7) Streaming yanıt başlat
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader(
    "X-Remaining",
    String(currentUser.limit - currentUser.used)
  );

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

  // 8) Streaming bittikten sonra hafıza + proje kaydı
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

// -------------------------------------------------------------------
// Proje endpoint'leri
// -------------------------------------------------------------------

// GET /projects?email=...
app.get("/projects", (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: "email parametresi zorunlu." });
  }

  const users = loadUsers();
  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  const projects = Array.isArray(user.projects) ? user.projects : [];

  const list = projects.map((p) => ({
    id: p.id,
    title: p.title,
    type: p.type,
    createdAt: p.createdAt,
    summary: p.summary,
  }));

  return res.json({ success: true, projects: list });
});

// GET /project?email=...&id=...
app.get("/project", (req, res) => {
  const email = req.query.email;
  const id = req.query.id;

  if (!email || !id) {
    return res.status(400).json({ error: "email ve id zorunlu." });
  }

  const users = loadUsers();
  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  const projects = Array.isArray(user.projects) ? user.projects : [];
  const project = projects.find((p) => p.id === id);
  if (!project) {
    return res.status(404).json({ error: "Proje bulunamadı." });
  }

  return res.json({
    success: true,
    project: {
      id: project.id,
      title: project.title,
      type: project.type,
      createdAt: project.createdAt,
      summary: project.summary,
      content: project.content,
    },
  });
});

// -------------------------------------------------------------------
// PDF export
// -------------------------------------------------------------------

// POST /export-pdf { email, title, content }
app.post("/export-pdf", (req, res) => {
  const { email, title, content } = req.body || {};

  if (!email || !title || !content) {
    return res
      .status(400)
      .json({ error: "email, title ve content zorunlu." });
  }

  const users = loadUsers();
  const user = users.find((u) => u.email === email);
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

  const doc = new PDFDocument({ margin: 50 });

  doc.pipe(res);

  doc.fontSize(18).text(title, { underline: true });
  doc.moveDown();
  doc.fontSize(11).text(content, {
    align: "left",
  });

  doc.end();
});

// -------------------------------------------------------------------
// Admin endpoint'leri
// -------------------------------------------------------------------

// GET /admin/users
app.get("/admin/users", requireAdmin, (req, res) => {
  const users = loadUsers();

  const list = users.map((u) => ({
    email: u.email,
    limit: u.limit,
    used: u.used,
    remaining: u.limit - u.used,
    memoryCount: Array.isArray(u.memory) ? u.memory.length : 0,
    projectCount: Array.isArray(u.projects) ? u.projects.length : 0,
  }));

  return res.json({ success: true, users: list });
});

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

// -------------------------------------------------------------------
// Sunucu başlat
// -------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sulama Asistanı server ${PORT} portunda çalışıyor.`);
});
