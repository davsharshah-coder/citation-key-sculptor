# Citation Key Sculptor

A small, self-contained Zotero 7/8/9 plugin that writes a deterministic citation
key to each item's **native `citationKey` field** and renames child PDFs to
deterministic key-derived names (`<citationKey>.pdf`, `<citationKey>-2.pdf`, ...)
— so the PDF filename, the Zotero citation key, and an external
[CitationSculptor](https://github.com/) reference tag all match.

Built to replace Better BibTeX for this workflow (BBT could not read Zotero's
native PMID field and degraded keys on edit). Independent of BBT and named
distinctly so a BBT install can never clobber it.

## Key format

```
foldAscii(FirstAuthorLastName) + ALL forename initials + "-" + Year + "-" + Identifier
```

- **foldAscii** strips diacritics, apostrophes, and hyphens (`O'Donoghue ML` → `ODonoghueML`,
  `Simental-Mendia LE` → `SimentalMendiaLE`, `Müller H` → `MullerH`).
- **Identifier chain:** PMID → `DOI`+foldAscii(DOI) → URL host-domain → brief-title.
- **Web items** append a 2-word brief-title disambiguator (`Token-Year-domain-brieftitle`).
- **No-identifier items** (talks, podcasts, undated reports) fall back to
  `Token-Year(or ND)-brieftitle`.
- Organisation authors use an abbreviation; authorless web items use the host.

Examples: `ODonoghueML-2022-36342163`, `ASA-2022-asahqorg-statementtransesophageal`,
`RigolinVH-ND-cardiooncology`.

## Behaviour

- Auto-applies on item add/modify (toggle: pref `extensions.citation-key-sculptor.auto`).
- Right-click → **Generate citation key** for a selection.
- Renames child PDFs deterministically: first PDF to `<citationKey>.pdf`, then
  `<citationKey>-2.pdf`, `<citationKey>-3.pdf`, etc. for multi-PDF parents
  (toggle: pref `extensions.citation-key-sculptor.renamePdfs`).
- Only writes when the computed key differs from the current value (loop-safe).

## Install

Download the latest `.xpi` from [Releases](https://github.com/davsharshah-coder/citation-key-sculptor/releases),
then Zotero → **Tools → Plugins → gear → Install Plugin From File**. Updates after
that arrive automatically via **Tools → Plugins → gear → Check for Updates**.

## License

MIT. Authored by Tushar Shah.
