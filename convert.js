const fs = require("fs");
const path = require("path");

const inputPath = path.join(__dirname, "amazon-categories-2026-04-03.csv");
const chunksDir = path.join(__dirname, "chunks");
const CHUNK_COUNT = 300;

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      values.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  values.push(current);
  return values;
}

function buildRecords(csvText) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((value) => value.trim());
  const idIndex = header.indexOf("Category ID");
  const pathIndex = header.indexOf("Path");

  if (idIndex === -1 || pathIndex === -1) {
    throw new Error("Missing required columns: Category ID, Path");
  }

  const records = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const id = values[idIndex];
    const pathValue = values[pathIndex];

    if (id === undefined || pathValue === undefined) continue;

    records.push({ id, path: pathValue });
  }

  return records;
}

try {
  const csvText = fs.readFileSync(inputPath, "utf8");
  const records = buildRecords(csvText);
  fs.mkdirSync(chunksDir, { recursive: true });

  const chunkSize = Math.max(1, Math.ceil(records.length / CHUNK_COUNT));
  for (let i = 0; i < CHUNK_COUNT; i += 1) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    const chunk = records.slice(start, end);
    const fileName = `categories-${String(i + 1).padStart(3, "0")}.json`;
    const filePath = path.join(chunksDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(chunk));
  }

  console.log(`Wrote ${records.length} categories across ${CHUNK_COUNT} chunks.`);
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 1;
}
