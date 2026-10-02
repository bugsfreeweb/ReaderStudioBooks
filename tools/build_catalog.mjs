/**
 * Builds `main/catalog.json` automatically from the PDFs in `books/`.
 *
 * The workflow this exists for: drop a PDF into `books/` and push. This script
 * reads what it can from the file itself, fills the gaps from the filename and
 * (optionally) Open Library, and writes the index both apps sync. No database
 * and no hand-typed index.
 *
 *   node tools/build_catalog.mjs            # write main/catalog.json
 *   node tools/build_catalog.mjs --check    # fail if it is out of date
 *   node tools/build_catalog.mjs --no-enrich
 *
 * Precedence, highest first:
 *   1. `books/<name>.meta.json`  - an explicit per-book override
 *   2. the existing catalog row  - preserves curated fields across rebuilds
 *   3. the PDF's own metadata    - /Info and XMP (title, author, dates, subject)
 *   4. the filename              - "Title - Author (Year).pdf" and friends
 *   5. Open Library              - first publish year, subjects, description
 *   6. defaults
 *
 * Fields derived from the file (`object`, `sha256`, `sizeMb`, `pageCount`,
 * `needsOcr`) are always recomputed so the index can never drift from the bytes.
 * Open Library is only trusted when the title matches closely; a weak match is
 * ignored rather than risking a wrong date, which is the manual-entry problem
 * this script exists to remove.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");
const BOOKS_DIR = join(ROOT, "books");
const CATALOG_PATH = join(ROOT, "main", "catalog.json");
const CACHE_PATH = join(HERE, "ol-cache.json");
const WRITERS_PATH = join(HERE, "writers.json");
const REBUILD = "node tools/build_catalog.mjs";

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const ENRICH = !args.has("--no-enrich") && process.env.ENRICH !== "0";

const log = (...a) => console.log(" ", ...a);

/* ------------------------------- helpers -------------------------------- */

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.pdf$/i.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function slugify(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const normal = (text) => slugify(text).replace(/-/g, " ");

function titleCase(text) {
  const minor = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "with", "from", "into", "over", "upon"]);
  return String(text)
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && minor.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function asString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    if (typeof value.value === "string") return value.value.trim();
    if (typeof value.Value === "string") return value.Value.trim();
  }
  return "";
}

const hashHex = (buf) => createHash("sha256").update(buf).digest("hex");
const unique = (list) => [...new Set(list)];

/* --------------------------- category mapping --------------------------- */

const CATEGORY_RULES = [
  { slug: "science-fiction", name: "Science Fiction", icon: "rocket", description: "Futures, inventions and the consequences of discovery.", keys: ["science fiction", "sci-fi", "sci fi", "space travel", "dystopia", "time travel", "space opera"] },
  { slug: "mystery", name: "Mystery", icon: "search", description: "Detection, deduction and the puzzle of crime.", keys: ["mystery", "detective", "crime", "murder", "sherlock"] },
  { slug: "gothic", name: "Gothic", icon: "ghost", description: "Dread, the uncanny and the shadow of the past.", keys: ["gothic", "horror", "ghost", "vampire"] },
  { slug: "fantasy", name: "Fantasy", icon: "wand", description: "Magic, myth and imagined worlds.", keys: ["fantasy", "magic", "myth", "legend"] },
  { slug: "romance", name: "Romance", icon: "heart", description: "Love, longing and the ties between people.", keys: ["romance", "love stories"] },
  { slug: "adventure", name: "Adventure", icon: "compass", description: "Voyages, quests and the open world.", keys: ["adventure", "voyages", "seafaring"] },
  { slug: "poetry", name: "Poetry", icon: "feather", description: "Verse and lyric.", keys: ["poetry", "poems", "verse", "sonnet"] },
  { slug: "philosophy", name: "Philosophy", icon: "scale", description: "Arguments about meaning, mind and conduct.", keys: ["philosophy", "ethics", "logic", "metaphysics"] },
  { slug: "biography", name: "Biography", icon: "user-round", description: "Lives told whole.", keys: ["biography", "autobiography", "memoir", "diaries", "letters"] },
  { slug: "history", name: "History", icon: "landmark", description: "The documented past.", keys: ["history", "historical", "war", "civilisation", "civilization"] },
  { slug: "science", name: "Science", icon: "flask-conical", description: "Nature, experiment and explanation.", keys: ["science", "physics", "biology", "chemistry", "mathematics", "astronomy"] },
  { slug: "children", name: "Children", icon: "smile", description: "Stories written for young readers.", keys: ["children", "juvenile", "fairy tale", "nursery"] },
  { slug: "religion", name: "Religion", icon: "book", description: "Faith, scripture and reflection.", keys: ["religion", "bible", "christian", "islam", "quran", "spiritual"] },
  { slug: "fiction", name: "Fiction", icon: "book-open", description: "Novels and stories.", keys: ["fiction", "novel", "literature", "classic"] },
];

const ACCENTS = ["#4a6fa5", "#7a5aa5", "#8a6a2a", "#2f7d6b", "#a5504a", "#4a7d3f", "#8a4a6a", "#5a6a8a"];

function accentFor(slug) {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

function categoryFor(subjects) {
  const hay = subjects.map((s) => normal(s)).join(" ");
  return CATEGORY_RULES.find((rule) => rule.keys.some((k) => hay.includes(k))) || null;
}

/* ------------------------------ filename -------------------------------- */

/**
 * Pull a title/author/year out of a filename. The conventions people actually
 * use, tried most-specific first. Anything ambiguous is left for the PDF
 * metadata or a sidecar to settle.
 */
function parseFilename(file) {
  const base = basename(file, extname(file)).replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const Y = "(1[5-9]\\d{2}|20\\d{2})";
  const year = (v) => Number(v) || 0;

  let m = base.match(new RegExp(`^(.+?)\\s*\\(([^()]+?),\\s*(${Y})\\)\\s*$`));
  if (m) return { title: m[1].trim(), author: m[2].trim(), year: year(m[3]) };

  m = base.match(new RegExp(`^(.+?)\\s+[-–—]\\s+(.+?)\\s*[,(]?\\s*(${Y})\\)?\\s*$`));
  if (m) return { title: m[1].trim(), author: m[2].trim(), year: year(m[3]) };

  m = base.match(new RegExp(`^(.+?)\\s*\\((${Y})\\)\\s*$`));
  if (m) return { title: m[1].trim(), author: "", year: year(m[2]) };

  return { title: base.replace(/[-_]+/g, " ").trim(), author: "", year: 0 };
}

/* -------------------------------- PDF ----------------------------------- */

async function readPdf(file) {
  const buf = readFileSync(file);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, verbosity: 0 }).promise;

  let info = {};
  let xmp = null;
  try {
    const meta = await doc.getMetadata();
    info = meta.info ?? {};
    xmp = meta.metadata ?? null;
  } catch {
    /* metadata is optional */
  }

  const xmpGet = (name) => {
    try {
      return xmp ? asString(xmp.get(name)) : "";
    } catch {
      return "";
    }
  };

  const created = asString(info.CreationDate) || xmpGet("xmp:CreateDate");
  const createdYear = Number((created.match(/(1[5-9]\d{2}|20\d{2})/) || [])[1] || 0);

  // First pages of text: used for the OCR check.
  let text = "";
  for (let n = 1; n <= Math.min(4, doc.numPages); n++) {
    try {
      const content = await (await doc.getPage(n)).getTextContent();
      text += content.items.map((i) => ("str" in i ? i.str : "")).join(" ") + "\n";
    } catch {
      /* a broken page should not stop the index */
    }
  }
  const textLen = text.replace(/\s+/g, " ").trim().length;
  const pages = doc.numPages;
  await doc.destroy();

  return {
    bytes: buf.length,
    sha256: hashHex(buf),
    pageCount: pages,
    title: asString(info.Title) || xmpGet("dc:title"),
    author: asString(info.Author) || xmpGet("dc:creator"),
    subject: asString(info.Subject) || xmpGet("dc:description"),
    keywords: asString(info.Keywords),
    createdYear,
    needsOcr: textLen < 40,
  };
}

/* ----------------------------- Open Library ----------------------------- */

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

const olCache = loadCache();
let cacheDirty = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "ReaderStudioBooks/1.0 (catalog builder)" } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/**
 * Look a book up on Open Library. Returns `{year, subjects, description}`, but
 * only keeps a year when the title matches closely - a loose match would put
 * the wrong date on a real book.
 */
async function enrich(title, author) {
  if (!ENRICH || !title) return {};
  const key = `${normal(title)}|${normal(author)}`;
  if (Object.prototype.hasOwnProperty.call(olCache, key)) return olCache[key];

  let result = {};
  try {
    const q = new URLSearchParams({ title, limit: "5", fields: "title,first_publish_year,subject,key" });
    if (author) q.set("author", author);
    const search = await getJson(`https://openlibrary.org/search.json?${q}`);
    const want = normal(title);
    const best = (search.docs || []).find((d) => {
      const t = normal(d.title);
      return t === want || t.startsWith(want + " ") || want.startsWith(t + " ");
    });
    if (best) {
      result = { year: Number(best.first_publish_year) || 0, subjects: (best.subject || []).slice(0, 24), description: "" };
      if (best.key) {
        try {
          const work = await getJson(`https://openlibrary.org${best.key}.json`);
          result.description = asString(work.description);
        } catch {
          /* a description is a bonus, not a requirement */
        }
      }
    }
  } catch (e) {
    log(`Open Library lookup skipped for "${title}": ${e.message}`);
    result = {};
  }

  olCache[key] = result;
  cacheDirty = true;
  await sleep(250);
  return result;
}

/* ------------------------------ assembly -------------------------------- */

function readSidecar(pdfFile) {
  const sidecar = pdfFile.replace(/\.pdf$/i, ".meta.json");
  if (!existsSync(sidecar)) return {};
  try {
    return JSON.parse(readFileSync(sidecar, "utf8"));
  } catch (e) {
    throw new Error(`${relative(ROOT, sidecar)} is not valid JSON: ${e.message}`);
  }
}

function uniqueSlug(base, taken) {
  const root = base || "book";
  let slug = root;
  for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
  taken.add(slug);
  return slug;
}

function splitAuthors(list) {
  return unique(
    list
      .map(asString)
      .filter(Boolean)
      .join(";")
      .split(/\s*(?:;|,|\band\b|&)\s*/i)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function loadWriterOverrides() {
  try {
    const raw = JSON.parse(readFileSync(WRITERS_PATH, "utf8"));
    const bySlug = new Map();
    const byName = new Map();
    for (const [key, w] of Object.entries(raw)) {
      const row = { slug: w.slug || key, ...w };
      bySlug.set(row.slug, row);
      if (w.name) byName.set(normal(w.name), row);
    }
    return { bySlug, byName };
  } catch {
    return { bySlug: new Map(), byName: new Map() };
  }
}

async function main() {
  const writerOverrides = loadWriterOverrides();
  const files = walk(BOOKS_DIR);
  if (!files.length) {
    console.error(`No PDFs found under ${relative(ROOT, BOOKS_DIR)}/`);
    process.exitCode = 1;
    return;
  }

  const currentText = existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, "utf8") : "";
  const current = currentText ? JSON.parse(currentText) : { books: [] };
  const priorByObject = new Map((current.books || []).map((b) => [b.object, b]));
  const priorWriterBySlug = new Map((current.writers || []).map((w) => [w.slug, w]));

  const writerSlugs = new Set();
  const writerByName = new Map();
  const categories = new Map();
  const books = [];

  for (const file of files) {
    const object = relative(ROOT, file).split(/[\\/]/).join("/");
    const sidecar = readSidecar(file);
    const prior = priorByObject.get(object) || {};

    log(`reading ${object}`);
    const pdf = await readPdf(file);
    const parsed = parseFilename(file);

    const authorNames = splitAuthors([sidecar.writer?.name, sidecar.author, pdf.author, parsed.author, prior.writer?.name]);

    const ol = await enrich(asString(sidecar.title) || pdf.title || parsed.title, authorNames[0]);

    const title = titleCase(asString(sidecar.title) || pdf.title || parsed.title || "Untitled");
    const year = Number(sidecar.year) || ol.year || parsed.year || Number(prior.year) || 0;
    const subjects = [...(ol.subjects || []), ...(sidecar.subjects || [])];
    const rule =
      CATEGORY_RULES.find((r) => r.slug === (sidecar.category || prior.category)) || categoryFor(subjects);

    // Writers are keyed by name so the same author keeps one slug across books.
    const writerRows = authorNames.map((raw) => {
      const name = titleCase(raw);
      const nameKey = normal(name);
      let row = writerByName.get(nameKey);
      if (!row) {
        const priorRow = [...priorWriterBySlug.values()].find((w) => normal(w.name) === nameKey);
        const slug = priorRow?.slug || uniqueSlug(slugify(name), writerSlugs);
        const override = writerOverrides.bySlug.get(slug) || writerOverrides.byName.get(nameKey) || {};
        row = {
          slug,
          name,
          country: priorRow?.country || override.country || "",
          era: priorRow?.era || override.era || "",
          bio: priorRow?.bio || override.bio || "",
          accent: priorRow?.accent || override.accent || accentFor(slug),
        };
        writerByName.set(nameKey, row);
        writerSlugs.add(slug);
      }
      return row;
    });

    books.push({
      slug: slugify(sidecar.slug || prior.slug || title),
      title,
      subtitle: asString(sidecar.subtitle) || asString(prior.subtitle) || "",
      year,
      language: asString(sidecar.language) || asString(prior.language) || "en",
      writer: writerRows[0]?.slug || "unknown",
      category: rule ? rule.slug : null,
      object,
      sizeMb: Math.round((pdf.bytes / (1024 * 1024)) * 100) / 100,
      pageCount: pdf.pageCount,
      description:
        asString(sidecar.description) ||
        asString(prior.description) ||
        asString(ol.description) ||
        `${title}${writerRows[0] ? ` by ${writerRows[0].name}` : ""}.`,
      tags: unique([...(sidecar.tags || []), ...(prior.tags || []), ...(pdf.keywords ? pdf.keywords.split(/[;,] ?/) : [])].map(slugify).filter(Boolean)).slice(0, 8),
      featured: Boolean(sidecar.featured ?? prior.featured),
      rights: asString(sidecar.rights) || asString(prior.rights) || "See source",
      sha256: pdf.sha256,
      needsOcr: pdf.needsOcr,
    });
  }

  for (const b of books) {
    if (!b.category || categories.has(b.category)) continue;
    const rule = CATEGORY_RULES.find((r) => r.slug === b.category);
    categories.set(b.category, { slug: rule.slug, name: rule.name, icon: rule.icon, accent: accentFor(rule.slug), description: rule.description });
  }

  // Category rails are generated. Hand-curated collections already in the
  // catalog are carried forward, so a carefully written shelf is never lost.
  const autoCollections = [...categories.values()].map((c) => ({
    slug: c.slug,
    name: c.name,
    kind: "category",
    description: c.description,
    accent: c.accent,
    bookSlugs: books.filter((b) => b.category === c.slug).map((b) => b.slug),
  }));
  const known = new Set(books.map((b) => b.slug));
  const curated = (current.collections || [])
    .filter((c) => c.kind !== "category")
    .map((c) => ({ ...c, bookSlugs: (c.bookSlugs || []).filter((s) => known.has(s)) }))
    .filter((c) => c.bookSlugs.length);
  const collections = [...curated, ...autoCollections];

  const manifest = {
    generatedAt: new Date().toISOString(),
    categories: [...categories.values()].sort((a, b) => a.name.localeCompare(b.name)),
    writers: [...writerByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    collections,
    books: books.sort((a, b) => a.title.localeCompare(b.title)),
  };

  if (cacheDirty) writeFileSync(CACHE_PATH, JSON.stringify(olCache, null, 2) + "\n");

  const next = JSON.stringify(manifest, null, 2) + "\n";
  const upToDate = stripTime(currentText) === stripTime(next);

  if (CHECK) {
    if (!upToDate) {
      console.error(`main/catalog.json is out of date. Run: ${REBUILD}`);
      process.exitCode = 1;
    } else {
      log("catalog is up to date");
    }
    return;
  }

  if (upToDate) {
    log(`main/catalog.json unchanged (${books.length} titles)`);
    return;
  }

  writeFileSync(CATALOG_PATH, next);
  log(`main/catalog.json written (${books.length} titles, ${categories.size} categories)`);
}

function stripTime(text) {
  try {
    const j = JSON.parse(text);
    delete j.generatedAt;
    return JSON.stringify(j);
  } catch {
    return text;
  }
}

main().catch((e) => {
  console.error(`build_catalog failed: ${e.stack || e.message}`);
  process.exitCode = 1;
});
