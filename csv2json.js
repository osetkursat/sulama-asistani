// csv2json.js
const fs = require("fs");
const path = require("path");
const csv = require("csvtojson");

const inputPath = path.join(__dirname, "data", "price_list.csv");
const outputPath = path.join(__dirname, "data", "price_list.json");

csv({
  delimiter: ";",          // CSV’yi açıp bak, ; yerine , ise burayı "," yap
  ignoreEmpty: true,
})
  .fromFile(inputPath)
  .then((jsonArray) => {
    fs.writeFileSync(outputPath, JSON.stringify(jsonArray, null, 2), "utf8");
    console.log("price_list.json güncellendi. Toplam satır:", jsonArray.length);
  })
  .catch((err) => {
    console.error("Dönüştürme hatası:", err);
  });
