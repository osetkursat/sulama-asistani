require("dotenv").config(); // .env dosyasını oku

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const client = new OpenAI(); // apiKey .env'den

// Kullanıcıları sakladığımız dosya
const USERS_FILE = path.join(__dirname, "users.json");

// Kullanıcıları dosyadan yükle
function loadUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(data);

    // Eski kayıtlarda memory / projects yoksa ekle
    return parsed.map((u) => ({
      ...u,
      memory: Array.isArray(u.memory) ? u.memory : [],
      projects: Array.isArray(u.projects) ? u.projects : [],
    }));
  } catch (e) {
    console.log("users.json bulunamadı, boş liste ile başlıyoruz.");
    return [];
  }
}

// Kullanıcıları dosyaya kaydet
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

let users = loadUsers();

// Eğer hiç kullanıcı yoksa, varsayılan bir tane oluştur
if (users.length === 0) {
  users.push({
    email: "deneme@deneme.com",
    password: "1234",
    limit: 50, // toplam soru limiti
    used: 0,   // kullanılan soru
    memory: [], // konuşma geçmişi
    projects: [], // kayıtlı projeler
  });
  saveUsers(users);
}

// Basit admin auth middleware'i
function isAdmin(req, res, next) {
  const headerKey = req.headers["x-admin-key"];
  const adminKey = process.env.ADMIN_KEY;

  if (!adminKey) {
    console.warn("UYARI: ADMIN_KEY .env içinde tanımlı değil!");
    return res.status(500).json({ error: "Admin yapılandırması eksik." });
  }

  if (!headerKey || headerKey !== adminKey) {
    return res.status(401).json({ error: "Yetkisiz. Admin anahtarı hatalı." });
  }

  next();
}

// Kayıt endpoint'i
app.post("/register", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.json({
      success: false,
      message: "E-posta ve şifre zorunludur.",
    });
  }

  const exists = users.find((u) => u.email === email);
  if (exists) {
    return res.json({
      success: false,
      message: "Bu e-posta ile zaten bir hesap var.",
    });
  }

  const newUser = {
    email,
    password,
    limit: 50, // yeni kullanıcıya başlangıç 50 soru
    used: 0,
    memory: [],
    projects: [],
  };

  users.push(newUser);
  saveUsers(users);

  return res.json({ success: true, message: "Kayıt başarılı." });
});

// Giriş endpoint'i
app.post("/login", (req, res) => {
  const { email, password } = req.body || {};

  const user = users.find(
    (u) => u.email === email && u.password === password
  );

  if (!user) {
    return res.json({
      success: false,
      message: "E-posta veya şifre hatalı.",
    });
  }

  if (!Array.isArray(user.memory)) user.memory = [];
  if (!Array.isArray(user.projects)) user.projects = [];
  saveUsers(users);

  return res.json({
    success: true,
    email: user.email,
    remaining: user.limit - user.used,
  });
});

// Paket satın alma (demo) endpoint'i
app.post("/purchase", (req, res) => {
  const { email, packageType } = req.body || {};

  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.json({ success: false, message: "Kullanıcı bulunamadı." });
  }

  let addQuestions = 0;
  if (packageType === "mini") addQuestions = 50;
  else if (packageType === "pro") addQuestions = 200;
  else if (packageType === "bayi") addQuestions = 1000;

  if (addQuestions === 0) {
    return res.json({ success: false, message: "Geçersiz paket." });
  }

  user.limit += addQuestions;
  saveUsers(users);

  return res.json({
    success: true,
    message: `Paketten ${addQuestions} soru eklendi.`,
    remaining: user.limit - user.used,
  });
});

// Chat endpoint'i (tasarım modu + hafıza + proje kaydı)
app.post("/chat", async (req, res) => {
  const { email, message, mode, designData } = req.body || {};

  const user = users.find((u) => u.email === email);
  if (!user) return res.json({ error: "Kullanıcı bulunamadı." });

  if (user.used >= user.limit) {
    return res.json({ error: "Soru hakkınız bitti." });
  }

  if (!Array.isArray(user.memory)) user.memory = [];
  if (!Array.isArray(user.projects)) user.projects = [];

  const baseSystemPrompt =
    "Sen Türkiye'de peyzaj sulama sistemlerinde uzman bir sulama danışmanısın. " +
    "Rain Bird, Hunter, Irritec gibi markalara hakimsin. Kullanıcıya doğru çözümler sun, " +
    "fiyatlar TL cinsinden olsun, teknik bilgiler net olsun. " +
    "Kullanıcının önceki konuşmalarını da dikkate alarak tutarlı ve devamlı cevap ver.";

  const history = Array.isArray(user.memory)
    ? user.memory.slice(-20)
    : [];

  const messages = [
    {
      role: "system",
      content: baseSystemPrompt,
    },
    ...history,
  ];

  if (mode === "design" && designData) {
    messages.push({
      role: "system",
      content:
        "ÖZEL TASARIM MODU: Kullanıcı aşağıdaki proje girdilerini vermiştir. " +
        "Bu bahçe için Türkiye'deki villa/peyzaj uygulamalarına uygun DETAYLI bir sulama tasarımı yap. " +
        "Çıktıyı şu başlıklarla ver:\n" +
        "1) Proje özeti (kısa)\n" +
        "2) Zone / hat planı (kaç zone, hangi alanlar, tahmini debiler)\n" +
        "3) Malzeme listesi (adetli, örn: 12 adet Rain Bird 5004, 120 m 32 mm PE boru, 1 adet 1\" solenoid vana vb.)\n" +
        "4) Tahmini malzeme maliyet aralığı (TL olarak, minimum-maksimum)\n" +
        "5) Montaj notları ve dikkat edilmesi gerekenler.\n\n" +
        "Kullanıcının verdiği girdiler (JSON formatında):\n" +
        JSON.stringify(designData, null, 2),
    });
  }

  const userMessageContent =
    message && message.trim().length > 0
      ? message
      : mode === "design"
      ? "Yukarıdaki kriterlere göre bahçem için sulama projesi tasarla."
      : "Sulama ile ilgili danışmanlık istiyorum.";

  messages.push({
    role: "user",
    content: userMessageContent,
  });

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-5.1",
      messages,
    });

    const replyText = completion.choices[0].message.content;

    // Kullanım sayacı
    user.used++;

    // Hafızaya ekle
    user.memory.push(
      { role: "user", content: userMessageContent },
      { role: "assistant", content: replyText }
    );
    if (user.memory.length > 40) {
      user.memory = user.memory.slice(-40);
    }

    // Tasarım modunda ise proje olarak kaydet
    if (mode === "design" && designData) {
      const now = new Date();
      const id = now.getTime().toString();
      const titleParts = [];
      if (designData.alan_m2) titleParts.push(`${designData.alan_m2} m²`);
      if (designData.lokasyon) titleParts.push(designData.lokasyon);
      const titleBase = titleParts.join(" - ") || "Sulama Tasarımı";

      const project = {
        id,
        type: "design",
        title: `Sulama Tasarımı - ${titleBase}`,
        createdAt: now.toISOString(),
        summary: replyText.slice(0, 200),
        content: replyText,
        rawInput: designData,
      };

      user.projects.push(project);
      // Son 50 projeyi tut
      if (user.projects.length > 50) {
        user.projects = user.projects.slice(-50);
      }
    }

    saveUsers(users);

    res.json({
      reply: replyText,
      remaining: user.limit - user.used,
    });
  } catch (err) {
    console.error("OpenAI hatası:", err);
    res.json({ error: "API hatası" });
  }
});

// PDF export endpoint'i
app.post("/export-pdf", (req, res) => {
  const { email, title, content } = req.body || {};

  if (!email || !content) {
    return res.status(400).json({ error: "Eksik veri." });
  }

  const safeTitle = (title || "sulama-tasarim").replace(/[^a-z0-9-_]/gi, "_");

  const doc = new PDFDocument({ margin: 50 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeTitle}.pdf"`
  );

  doc.pipe(res);

  doc.fontSize(18).text(title || "Sulama Proje Raporu", {
    align: "left",
  });
  doc.moveDown();

  doc
    .fontSize(10)
    .fillColor("#444444")
    .text(`Kullanıcı: ${email}`, { align: "left" });
  doc.moveDown();

  doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor("#cccccc").stroke();
  doc.moveDown();

  doc.fontSize(12).fillColor("#000000");
  doc.text(content, {
    align: "left",
  });

  doc.end();
});

/* --------- PROJE API'LERİ (KULLANICI PANELİ) ----------- */

// Kullanıcının proje listesini getir (sadece özet)
app.get("/projects", (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: "Email gerekli." });
  }

  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  const projects = (user.projects || []).map((p) => ({
    id: p.id,
    title: p.title,
    createdAt: p.createdAt,
    type: p.type,
    summary: p.summary,
  }));

  res.json({ projects });
});

// Tek proje detayı getir
app.get("/project", (req, res) => {
  const email = req.query.email;
  const id = req.query.id;

  if (!email || !id) {
    return res.status(400).json({ error: "Email ve id gerekli." });
  }

  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  const project = (user.projects || []).find((p) => p.id === id);
  if (!project) {
    return res.status(404).json({ error: "Proje bulunamadı." });
  }

  res.json({ project });
});

/* ----------------- ADMIN API ------------------ */

// Tüm kullanıcıları listele (şifreleri gönderme!)
app.get("/admin/users", isAdmin, (req, res) => {
  const result = users.map((u) => ({
    email: u.email,
    limit: u.limit,
    used: u.used,
    remaining: u.limit - u.used,
    memoryCount: Array.isArray(u.memory) ? u.memory.length : 0,
    projectCount: Array.isArray(u.projects) ? u.projects.length : 0,
  }));

  res.json({ users: result });
});

// Tek bir kullanıcıyı güncelle (limit, used reset, memory reset)
app.post("/admin/update-user", isAdmin, (req, res) => {
  const { email, limit, resetUsed, resetMemory } = req.body || {};

  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  if (typeof limit === "number" && !Number.isNaN(limit)) {
    user.limit = limit;
  }

  if (resetUsed === true) {
    user.used = 0;
  }

  if (resetMemory === true) {
    user.memory = [];
  }

  saveUsers(users);

  res.json({
    success: true,
    user: {
      email: user.email,
      limit: user.limit,
      used: user.used,
      remaining: user.limit - user.used,
      memoryCount: Array.isArray(user.memory) ? user.memory.length : 0,
      projectCount: Array.isArray(user.projects) ? user.projects.length : 0,
    },
  });
});

app.listen(3000, () => {
  console.log("Sulama Asistanı Çalışıyor → http://localhost:3000");
});
