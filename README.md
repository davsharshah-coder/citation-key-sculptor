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
- DOI-only PubMed-indexed journal articles are first grounded through PubMed
  DOI lookup; if exactly one PMID is found, the plugin writes native `PMID` and
  uses that PMID key instead of falling back to DOI.
- **Web items** append a 2-word brief-title disambiguator (`Token-Year-domain-brieftitle`).
- **No-identifier items** (talks, podcasts, undated reports) fall back to
  `Token-Year(or ND)-brieftitle`.
- Organisation authors use an abbreviation; authorless web items use the host.

Examples: `ODonoghueML-2022-36342163`, `ASA-2022-asahqorg-statementtransesophageal`,
`RigolinVH-ND-cardiooncology`.

## Behaviour

- Auto-applies on item add/modify (toggle: pref `extensions.citation-key-sculptor.auto`).
- Right-click → **Generate citation key** for a selection.
- Right-click → **Attach PDF from Comet / OSU EasyProxy** queues selected
  records for PDF resolution through the shared helper at
  `~/.claude/Bin/zotero-smart-capture/zotero-smart-capture`. The queue stores
  item IDs, skips records that already have PDFs or lack a DOI, links resolved
  PDFs into the existing Zotero parent item, and leaves Zotero usable while it
  works through the selection. Resolved PDFs are placed at the configured
  linked-file base directory as `<citationKey>.pdf` and linked via Zotero's
  `attachments:` relative-path model; they are not imported into Zotero storage.
- Grounds DOI-only PubMed-indexed journal articles to native `PMID` before
  computing the key, avoiding inappropriate DOI fallback for PubMed records.
- Renames child PDFs deterministically: first PDF to `<citationKey>.pdf`, then
  `<citationKey>-2.pdf`, `<citationKey>-3.pdf`, etc. for multi-PDF parents
  (toggle: pref `extensions.citation-key-sculptor.renamePdfs`).
- Only writes when the computed key differs from the current value (loop-safe).

## Background PDF capture

The Zotero plugin only runs while Zotero is open. For unattended/background PDF
capture while Zotero is closed, use the same shared helper directly:

```bash
~/.claude/Bin/zotero-smart-capture/zotero-smart-capture attach-pdf ITEMKEY [ITEMKEY ...]
```

That mode reads the existing parent records through the Zotero Web API, resolves
PDFs through Comet's authenticated OSU EasyProxy session or lawful PMC fallback,
places PDFs in the linked-file base directory as `<citationKey>.pdf`, creates
`linked_file` child attachments through the Zotero Web API, and reports progress
via macOS notifications. It never reads or exports institutional credentials; login
stays inside Comet and the browser's password-manager/session layer.

If the OSU session has expired, the helper returns `auth-required`; authenticate
in Comet, then rerun the command.

## Install

Download the latest `.xpi` from [Releases](https://github.com/davsharshah-coder/citation-key-sculptor/releases),
then Zotero → **Tools → Plugins → gear → Install Plugin From File**. Updates after
that arrive automatically via **Tools → Plugins → gear → Check for Updates**.

## License

MIT. Authored by Tushar Shah.
