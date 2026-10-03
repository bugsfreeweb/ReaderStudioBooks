# Reader Studio — Books

The shared library node for **Reader Studio**. Both the desktop app and the
web app read this repository, so the same catalogue reaches every device.

You do not type the index by hand. Drop a PDF into `books/`, push, and
`main/catalog.json` rebuilds itself from the file.

## Layout

```
books/*.pdf              the books. adding one is all that is required
books/<name>.meta.json   optional per-book override (curation the PDF cannot hold)
tools/build_catalog.mjs  reads books/ and writes main/catalog.json
tools/categories.env     category rules; add a category without touching code
tools/make-books.mjs     regenerates the bundled public-domain PDFs
tools/writers.json       author detail (country, era, bio) that PDFs do not carry
tools/ol-cache.json      remembered Open Library lookups, so builds are repeatable
main/catalog.json        the manifest the apps sync
```

The desktop client resolves a GitHub node's manifest at
`<branch>/catalog.json`, which is why the file lives under `main/`.

## Adding a book

1. Drop the PDF into `books/`. Any filename works; to help the parser use
   `Title - Author (Year).pdf` or `Title (Author, Year).pdf`.
2. Push. The **Build catalog** workflow runs on any change under `books/`,
   reads the PDF, and commits the refreshed `main/catalog.json`.

To do it locally instead:

```
npm install
npm run build     # writes main/catalog.json
npm run check     # exits non-zero if the catalog is out of date
```

## Where each field comes from

The builder trusts, in order:

1. `books/<name>.meta.json` — an explicit override you write by hand.
2. The existing catalog row — so curated blurbs and tags survive a rebuild.
3. The PDF's own metadata — title, author, subject, dates (from `/Info` and XMP).
4. The filename — `Title - Author (Year).pdf` and similar.
5. Open Library — first publish year, subjects and a description, but only
   when the title matches closely.
6. Defaults.

Title, author, page count, file size and the SHA-256 are read from the bytes,
and `needsOcr` is set when the first pages carry no extractable text. Open
Library is a suggestion, never an override: a loose match is ignored rather
than stamping a wrong date on a real book.

A genre is guessed from the subjects. Override it, or anything else, by adding
`books/<name>.meta.json` next to the PDF:

```json
{
  "title": "Frankenstein",
  "author": "Mary Shelley",
  "year": 1818,
  "category": "gothic",
  "tags": ["classic", "gothic", "horror"],
  "featured": true,
  "rights": "Public domain",
  "description": "A short blurb, if the extracted one is not what you want."
}
```

## Categories

Categories are data, not code. They live in `tools/categories.env`, one line
per category, applied in ascending number order:

```
CATEGORY_10=liberation-war|মুক্তিযুদ্ধ ১৯৭১|landmark|liberation war, muktijuddho, bangladesh, 1971|বাংলাদেশের মুক্তিযুদ্ধ নিয়ে লেখা বই।
```

Fields are `slug|name|icon|match keys|description`; only `slug` and `name` are
required. A book is filed under the first category whose `match keys` appear in
its subjects or tags, so keep specific categories above broad ones. To pin a
book explicitly, set `"category"` in its sidecar. The header of
`tools/categories.env` documents every field, the available icons, and how to
add a new category. Point the builder elsewhere with `CATALOG_CATEGORIES`.

## Current library

| Title | Author | Language |
| --- | --- | --- |
| ১৯৭১ | হুমায়ূন আহমেদ | Bengali |
| ১৯৭১ ঘাতক-দালালদের বক্তৃতা ও বিবৃতি | সাইদুজ্জামান রওশন | Bengali |
| ১৯৭১ ভেতরে বাইরে | এ কে খন্দকার | Bengali |

These PDFs were supplied by the library operator. Copyright remains with the
respective authors and publishers — they are **not** public-domain works. If
you redistribute this repository you are responsible for having the rights to
the files under `books/`.

## Licence

The manifest (`main/catalog.json`), the tooling under `tools/`, and the
arrangement of this repository are MIT. The book files under `books/` are
**not** covered by that licence.
