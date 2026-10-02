# Reader Studio — Books

The shared library node for **Reader Studio**. Both the desktop app and the
web app read this repository, so the same catalogue reaches every device.

## Layout

```
main/catalog.json   the manifest the apps sync  (branch name + /catalog.json)
books/*.pdf         the book files referenced by the manifest's `object`
tools/make-books.mjs  regenerates the PDFs and manifest from public-domain texts
```

The desktop client resolves a GitHub node's manifest at
`<branch>/catalog.json`, which is why the file lives under `main/`.

## Contents

| Title | Author | Year | Source |
| --- | --- | --- | --- |
| The Time Machine | H. G. Wells | 1895 | Project Gutenberg #35 |
| Frankenstein | Mary Shelley | 1818 | Project Gutenberg #84 |
| The Adventures of Sherlock Holmes | Arthur Conan Doyle | 1892 | Project Gutenberg #1661 |

All three works are in the **public domain**. The Project Gutenberg
header/footer boilerplate was removed and the text was reflowed into PDFs by
`tools/make-books.mjs`. The underlying texts remain public domain; the
typographic arrangement is released under the same terms as the repository.

## Adding a book

1. Drop the PDF under `books/<slug>.pdf`.
2. Add an entry to `main/catalog.json` (`slug`, `title`, `writer`, `category`,
   `object: "books/<slug>.pdf"`, `pageCount`, `sizeMb`, `sha256`, …).
3. Ensure the writer and category slugs exist in the manifest's `writers` and
   `categories` arrays.

Or edit the `BOOKS` table in `tools/make-books.mjs` and run:

```
node tools/make-books.mjs
```

## Adding a writer or category

Writers and categories are defined once in the manifest. Add the entry to the
respective array; books reference them by `slug`.

## Licence

Manifest, tooling and arrangement: MIT. Book texts: public domain.
