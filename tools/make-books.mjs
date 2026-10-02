/**
 * Regenerates the sample book PDFs for ReaderStudioBooks.
 *
 *   node tools/make-books.mjs && node tools/build_catalog.mjs
 *
 * The source texts are public-domain works from Project Gutenberg. Only the
 * standard 14 PDF fonts are used, so no font needs embedding and the output is
 * reproducible. The Project Gutenberg header/footer boilerplate is removed; the
 * underlying text is public domain.
 *
 * This script writes the PDFs under `books/`, a curated `books/<slug>.meta.json`
 * per title, and `tools/writers.json`. It deliberately does NOT write the
 * catalog: `tools/build_catalog.mjs` owns `main/catalog.json` and rebuilds it
 * from every PDF in `books/` (drop a file in and the index follows).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const BOOKS = [
  {
    slug: "the-time-machine",
    title: "The Time Machine",
    subtitle: "An Invention",
    writer: "h-g-wells",
    category: "science-fiction",
    year: 1895,
    gutenbergId: 35,
    description:
      "A Victorian inventor travels to the year 802,701 and finds a world split between the gentle Eloi and the subterranean Morlocks. A founding text of science fiction.",
    tags: ["classic", "sci-fi", "novella"],
    featured: true,
  },
  {
    slug: "frankenstein",
    title: "Frankenstein",
    subtitle: "Or, The Modern Prometheus",
    writer: "mary-shelley",
    category: "gothic",
    year: 1818,
    gutenbergId: 84,
    description:
      "Victor Frankenstein assembles a living creature and abandons it. Mary Shelley's novel is at once a gothic horror and a meditation on responsibility.",
    tags: ["classic", "gothic", "horror"],
    featured: true,
  },
  {
    slug: "sherlock-holmes",
    title: "The Adventures of Sherlock Holmes",
    subtitle: "Twelve Stories",
    writer: "arthur-conan-doyle",
    category: "mystery",
    year: 1892,
    gutenbergId: 1661,
    description:
      "Twelve cases that established the consulting detective as a fixture of fiction, narrated by his friend and chronicler Dr. John Watson.",
    tags: ["classic", "mystery", "short-stories"],
    featured: false,
  },
];

const WRITERS = {
  "h-g-wells": { name: "H. G. Wells", country: "United Kingdom", era: "1866–1946", bio: "Novelist and social commentator, often called the father of science fiction.", accent: "#4a6fa5" },
  "mary-shelley": { name: "Mary Shelley", country: "United Kingdom", era: "1797–1851", bio: "Novelist, dramatist and essayist, best known for Frankenstein.", accent: "#7a5aa5" },
  "arthur-conan-doyle": { name: "Arthur Conan Doyle", country: "United Kingdom", era: "1859–1930", bio: "Physician and writer who created Sherlock Holmes.", accent: "#8a6a2a" },
};

/* ----------------------------- PDF toolkit ------------------------------ */

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 64;
const CONTENT_W = A4.w - MARGIN * 2;
const INK = "0.043 0.051 0.075";
const GOLD = "0.788 0.6 0.184";
const MUTED = "0.42 0.45 0.5";
const PARCHMENT = "0.976 0.929 0.863";

const esc = (s) => s.replace(/([\\()])/g, "\\$1");
const measure = (t, size) => t.length * size * 0.5;

function wrap(text, size, width) {
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, size) > width) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

class Content {
  constructor() {
    this.ops = [];
  }
  rect(x, y, w, h, colour) {
    this.ops.push(`${colour} rg`, `${x} ${y} ${w} ${h} re`, "f");
    return this;
  }
  text(lines, { x, y, size, font = "F1", colour = INK, leading = size * 1.5 }) {
    let cursor = y;
    this.ops.push("BT", `/${font} ${size} Tf`, `${colour} rg`, `1 0 0 1 ${x} ${cursor} Tm`, `${leading.toFixed(3)} TL`);
    lines.forEach((line, i) => {
      if (i > 0) this.ops.push("T*");
      this.ops.push(`(${esc(line)}) Tj`);
    });
    this.ops.push("ET");
    return cursor - leading * (lines.length - 1);
  }
  toString() {
    return this.ops.join("\n");
  }
}

/* --------------------------- text preparation --------------------------- */

/** Map common UTF-8 punctuation to WinAnsi-safe ASCII and drop the rest. */
function toLatin1(text) {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, "--")
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA1-\xFF]/g, "");
}

function stripGutenberg(raw) {
  const start = raw.search(/\*\*\*\s*START OF TH[EIS] PROJECT GUTENBERG/i);
  const end = raw.search(/\*\*\*\s*END OF TH[EIS] PROJECT GUTENBERG/i);
  let body = raw;
  if (start >= 0) body = body.slice(body.indexOf("\n", start) + 1);
  if (end >= 0) {
    const cut = body.search(/\*\*\*\s*END OF TH[EIS] PROJECT GUTENBERG/i);
    if (cut >= 0) body = body.slice(0, cut);
  }
  return body;
}

/** Split into paragraphs and flag the ones that read as chapter headings. */
function toParagraphs(text) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.split("\n").map((l) => l.trim()).filter(Boolean).join(" "))
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks.map((b) => {
    const letters = b.replace(/[^A-Za-z]/g, "");
    const isCaps = letters.length > 3 && letters === letters.toUpperCase();
    const isChapter = /^(CHAPTER|PART|BOOK|LETTER)\b/i.test(b) && b.length < 60;
    return { text: b, heading: isCaps || isChapter };
  });
}

/* ----------------------------- pagination ------------------------------- */

function renderBook(book, paragraphs) {
  const pages = [];
  const push = (c) => pages.push(c.toString());

  // Title page.
  {
    const c = new Content();
    c.rect(0, 0, A4.w, A4.h, PARCHMENT);
    c.rect(0, A4.h - 210, A4.w, 210, INK);
    c.rect(MARGIN, A4.h - 236, 96, 3, GOLD);
    c.text(wrap(book.title, 30, CONTENT_W), { x: MARGIN, y: A4.h - 120, size: 30, font: "F2", colour: PARCHMENT });
    c.text(wrap(book.subtitle, 14, CONTENT_W), { x: MARGIN, y: A4.h - 176, size: 14, colour: GOLD });
    c.text(wrap(WRITERS[book.writer].name, 22, CONTENT_W), { x: MARGIN, y: 420, size: 22, font: "F2" });
    c.rect(MARGIN, 398, 180, 2, GOLD);
    c.text([String(book.year)], { x: MARGIN, y: 360, size: 13, colour: MUTED });
    c.text(["Public domain. Sourced from Project Gutenberg and set for Reader Studio."], {
      x: MARGIN,
      y: 120,
      size: 10,
      colour: MUTED,
    });
    push(c);
  }

  // Body.
  let c = new Content();
  c.rect(0, 0, A4.w, A4.h, PARCHMENT);
  let y = A4.h - MARGIN;
  let pageNo = 1;

  const newPage = () => {
    c.text([String(pageNo)], { x: MARGIN, y: MARGIN - 24, size: 9, colour: MUTED });
    push(c);
    pageNo++;
    c = new Content();
    c.rect(0, 0, A4.w, A4.h, PARCHMENT);
    y = A4.h - MARGIN;
  };

  for (const para of paragraphs) {
    if (para.heading) {
      const lines = wrap(para.text, 15, CONTENT_W);
      const need = lines.length * 22 + 30;
      if (y - need < MARGIN) newPage();
      y = c.text(lines, { x: MARGIN, y, size: 15, font: "F2", leading: 22 }) - 22;
    } else {
      const lines = wrap(para.text, 10.5, CONTENT_W);
      const leading = 15.5;
      if (y - lines.length * leading < MARGIN + 10) {
        // A paragraph longer than a page is split across pages.
        let start = 0;
        while (start < lines.length) {
          const room = Math.max(1, Math.floor((y - MARGIN - 10) / leading));
          const slice = lines.slice(start, start + room);
          y = c.text(slice, { x: MARGIN, y, size: 10.5, leading });
          start += room;
          if (start < lines.length) newPage();
        }
        y -= leading;
      } else {
        y = c.text(lines, { x: MARGIN, y, size: 10.5, leading });
        y -= leading;
      }
    }
  }
  c.text([String(pageNo)], { x: MARGIN, y: MARGIN - 24, size: 9, colour: MUTED });
  push(c);

  return { pages, pageCount: pages.length };
}

/* ------------------------------ serialise ------------------------------- */

function serialise(pages, book) {
  const objects = [];
  const add = (body) => (objects.push(body), objects.length);
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pagesObj = add("");
  const pageIds = [];
  for (const stream of pages) {
    const cid = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    const pid = add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`,
    );
    pageIds.push(pid);
  }
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R /PageMode /UseNone >>`);
  const infoId = add(
    `<< /Title (${esc(book.title)}) /Author (${esc(WRITERS[book.writer].name)}) ` +
      `/Subject (Public domain, via Project Gutenberg) /Creator (ReaderStudioBooks) /Producer (Reader Studio) >>`,
  );

  let pdf = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/* -------------------------------- main ---------------------------------- */

async function fetchText(id) {
  const url = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`;
  const res = await fetch(url, { headers: { "User-Agent": "ReaderStudioBooks/1.0" } });
  if (!res.ok) throw new Error(`Gutenberg ${id} returned ${res.status}`);
  return res.text();
}

mkdirSync(resolve(ROOT, "books"), { recursive: true });

for (const book of BOOKS) {
  process.stdout.write(`  ${book.slug} ... `);
  const raw = await fetchText(book.gutenbergId);
  const body = toLatin1(stripGutenberg(raw));
  const paragraphs = toParagraphs(body);
  const { pages, pageCount } = renderBook(book, paragraphs);
  const pdf = serialise(pages, book);

  writeFileSync(resolve(ROOT, `books/${book.slug}.pdf`), pdf);

  // The sidecar is the override the catalog builder reads first: curation that
  // is not carried in the PDF itself (genre, blurb, tags, rights).
  writeFileSync(
    resolve(ROOT, `books/${book.slug}.meta.json`),
    JSON.stringify(
      {
        title: book.title,
        subtitle: book.subtitle,
        author: WRITERS[book.writer].name,
        year: book.year,
        language: "en",
        category: book.category,
        description: book.description,
        tags: book.tags,
        featured: book.featured,
        rights: "Public domain",
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`${pageCount} pages, ${(pdf.length / 1024).toFixed(0)} KB`);
}

// Author detail that cannot be read from a PDF, kept so a rebuild keeps it.
writeFileSync(resolve(ROOT, "tools/writers.json"), JSON.stringify(WRITERS, null, 2) + "\n");
console.log(`  tools/writers.json  ${Object.keys(WRITERS).length} writers`);
console.log("  run: node tools/build_catalog.mjs");
