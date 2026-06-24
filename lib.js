// ============================================================================
// Citation Key Sculptor — lib.js
//
// Loaded via Services.scriptloader.loadSubScript(..., { Zotero }) so `Zotero`
// is present in this scope. Globals such as Services/Components/URL are
// provided by Zotero's privileged sandbox (Zotero 7/8/9).
//
// Responsibilities:
//   - Compute a CitationSculptor citation key from NATIVE item fields, faithful
//     to ~/.claude/Bin/zotero-curate/index.ts.
//   - Write it to the NATIVE citationKey field via setField + saveTx, ONLY when
//     it differs from the current value (loop-safe convergence).
//   - React to item add/modify via a Notifier observer, gated by a pref.
//   - Provide a right-click "Generate citation key" menu item (selection-based).
//   - Designed to be the SOLE writer of citationKey (Better BibTeX removed). If
//     BBT is still present with resetKeyOnChange ON, it logs a conflict warning.
// ============================================================================

const PLUGIN_ID = "citation-key-sculptor@tusharshah.local";
const PREF_AUTO = "extensions.citation-key-sculptor.auto"; // bool gate for notifier
const PREF_RENAME = "extensions.citation-key-sculptor.renamePdfs"; // rename child PDFs to <citationKey>.pdf / <citationKey>-N.pdf
const OBSERVER_ID = "citation-key-sculptor";

// ----------------------------------------------------------------------------
// citationKeyFor algorithm — ported faithfully from zotero-curate/index.ts.
// Key format: foldAscii(FirstAuthorLastName) + initials(ALL given names)
//             + '-' + Year + '-' + Identifier
//   e.g. AbbasiJ-2026-41893839, ODonoghueML-2022-36342163
// Identifier fallback chain: PMID -> 'DOI'+foldAscii(DOI) -> URL hostname[-briefTitle]
//   -> briefTitle (for items with no PMID/DOI/URL, e.g. talks/podcasts: Token-Year|ND-briefTitle).
// Returns '' only when no author/org token can be derived.
// ----------------------------------------------------------------------------

// foldAscii: diacritic map + NFD strip + non-alnum removal (CLI lines 62-70).
function foldAscii(s) {
  const map = {
    "ø": "o", "Ø": "O", "ð": "d", "Ð": "D",
    "þ": "th", "Þ": "Th", "ß": "ss",
    "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe",
    "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ı": "i",
  };
  let t = (s || "").split("").map((c) => (c in map ? map[c] : c)).join("");
  // Strip Unicode combining diacritical marks (U+0300-U+036F) after NFD.
  t = t.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return t.replace(/[^A-Za-z0-9]/g, "");
}

// initialsOf: ALL forename initials, uppercase (CLI lines 71-73).
function initialsOf(firstName) {
  return (firstName || "")
    .split(/[\s.\-]+/)
    .filter(Boolean)
    .map((tok) => tok[0])
    .join("")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

// yearOf: first 4-digit run (CLI line 74).
function yearOf(date) {
  const m = (date || "").match(/\d{4}/);
  return m ? m[0] : "";
}

// getField that never throws if the field isn't valid for the item type.
function safeGetField(item, field) {
  try {
    return item.getField(field) || "";
  } catch (e) {
    return "";
  }
}

// pmidOf: robust PMID sourcing to match zotero-curate's precedence —
// native PMID field -> Extra "PMID: n" line. Existing citationKey suffixes are
// intentionally ignored during migration.
function pmidOf(item) {
  const native = safeGetField(item, "PMID").trim();
  if (native) return native;
  const extra = safeGetField(item, "extra");
  const em = extra.match(/^\s*PMID\s*:\s*(\d+)/im);
  if (em) return em[1];
  // NOTE: deliberately do NOT mine a PMID from the existing citationKey suffix.
  // During a migration that replaces old keys, trusting the current key as a
  // PMID authority could freeze a wrong id. Native PMID / Extra PMID only.
  return "";
}

// authorToken: first INDIVIDUAL author, else org-abbreviation fallback
// (CLI lines 76-89). Zotero in-process creator shape:
//   { firstName, lastName, fieldMode, creatorTypeID }.
//   fieldMode === 1  => single-field organization name (stored in lastName).
//   author-ness      => Zotero.CreatorTypes.getName(creatorTypeID) === 'author'.
function authorToken(creators) {
  const isAuthor = (c) =>
    Zotero.CreatorTypes.getName(c.creatorTypeID) === "author";

  // Priority: (1) individual AUTHOR, (2) organisation AUTHOR, (3) first individual
  // creator of ANY type (presenter/podcaster/editor/director/…), (4) any org
  // creator. The "author" role — individual OR organisation — always beats a
  // non-author contributor, so an org-author is never overridden by a contributor.
  const cs = creators || [];
  let a = cs.find((c) => isAuthor(c) && c.fieldMode !== 1 && c.lastName);
  if (a) {
    return { token: foldAscii(a.lastName) + initialsOf(a.firstName || ""), orgFallback: false };
  }
  let org = cs.find((c) => isAuthor(c) && c.fieldMode === 1 && c.lastName);
  if (!org) {
    a = cs.find((c) => c.fieldMode !== 1 && c.lastName); // non-author individual
    if (a) {
      return { token: foldAscii(a.lastName) + initialsOf(a.firstName || ""), orgFallback: false };
    }
    org = cs.find((c) => c.fieldMode === 1 && c.lastName); // non-author organisation
  }
  if (org) {
    const name = String(org.lastName);
    const words = name
      .split(/[\s,]+/)
      .filter(
        (w) => /[A-Za-z]/.test(w) && !/^(of|the|and|for|on|in|a)$/i.test(w)
      );
    const abbr = words.map((w) => foldAscii(w)[0] || "").join("").toUpperCase();
    return { token: abbr || foldAscii(name).slice(0, 6), orgFallback: true };
  }

  return { token: "", orgFallback: false };
}

// briefTitleOf: deterministic 2-significant-word title slug for web-key
// disambiguation (so distinct pages on the same site get distinct keys).
// MUST be implemented identically in CitationSculptor + zotero-curate.
function briefTitleOf(title) {
  const STOP = new Set(["of", "the", "and", "for", "on", "in", "a", "an", "to", "with", "by", "from", "at", "as", "is", "are", "or", "but", "how", "what", "why"]);
  const words = (title || "").split(/[^A-Za-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w.toLowerCase()));
  return words.slice(0, 2).map(w => foldAscii(w).toLowerCase()).join("");
}

// authorlessToken: webpage/blog fallback — derive a token from the URL host
// (strip leading www. and the TLD, foldAscii, uppercase first letter). Kept
// deterministic (host-only, no scraped site name) so it matches CitationSculptor.
function authorlessToken(item) {
  const u = safeGetField(item, "url").trim();
  if (!u) return "";
  try {
    const host = new URL(u).hostname.replace(/^www\./, "");
    const noTld = host.replace(/\.[A-Za-z]{2,}$/, "");
    const folded = foldAscii(noTld);
    return folded ? folded.charAt(0).toUpperCase() + folded.slice(1) : "";
  } catch (e) {
    return "";
  }
}

// citationKeyFor: full pipeline (mirrors CLI planItem identifier chain).
function citationKeyFor(item) {
  let { token } = authorToken(item.getCreators());
  if (!token) token = authorlessToken(item); // authorless webpages/blogs
  const year = yearOf(safeGetField(item, "date") || item.getField("date", false, true) || "");

  let idPart = "", isWeb = false;
  const pmid = pmidOf(item);
  if (pmid) {
    idPart = pmid;
  } else {
    const doi = safeGetField(item, "DOI").trim();
    if (doi) {
      idPart = "DOI" + foldAscii(doi);
    } else {
      const url = safeGetField(item, "url").trim();
      if (url) {
        try {
          idPart = new URL(url).hostname
            .replace(/^www\./, "")
            .replace(/[^A-Za-z0-9]/g, "");
          isWeb = true;
        } catch (e) {
          idPart = "";
        }
      }
    }
  }

  // Web items get a brief-title disambiguator appended so distinct pages on the
  // same site (same Token-Year-domain) get distinct keys.
  if (isWeb && idPart) {
    const bt = briefTitleOf(safeGetField(item, "title"));
    if (bt) idPart = idPart + "-" + bt;
  }

  // Items WITH an identifier (PMID/DOI hard id, or web domain): Token-Year-id.
  // Year-less web items emit "ND"; non-web items with a hard id still need a year.
  if (token && idPart) {
    const effYear = year || (isWeb ? "ND" : "");
    if (effYear) return token + "-" + effYear + "-" + idPart;
    return "";
  }

  // No identifier at all (presentations, podcasts, undated reports, etc.):
  // fall back to a brief-title identifier so the item still gets a deterministic,
  // convention-matching key — Token-Year(or ND)-briefTitle.
  if (token) {
    const bt = briefTitleOf(safeGetField(item, "title"));
    if (bt) return token + "-" + (year || "ND") + "-" + bt;
  }
  return "";
}

// ----------------------------------------------------------------------------
// CitationKeySculptor singleton
// ----------------------------------------------------------------------------
class CitationKeySculptor {
  constructor() {
    this.notifier = undefined;
    this.menuRegistered = false;
    this.id = PLUGIN_ID;
  }

  log(msg) {
    Zotero.debug(`[CitationKeySculptor] ${msg}`);
  }

  notify(text) {
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Citation Key Sculptor");
      pw.addDescription(text);
      pw.show();
      pw.startCloseTimer(4000);
    } catch (e) {
      this.log(`notify failed: ${e}`);
    }
  }

  // Warn if Better BibTeX is present and configured to fight us over the field.
  checkBBTConflict() {
    try {
      const reset = Zotero.Prefs.get("translators.better-bibtex.resetKeyOnChange");
      if (reset === true) {
        this.log(
          "WARNING: Better BibTeX resetKeyOnChange is ON — it regenerates the native citationKey on every modify and will fight Citation Key Sculptor. Set it OFF or uninstall Better BibTeX."
        );
      }
    } catch (e) {
      /* BBT not installed — nothing to check */
    }
  }

  // ----- lifecycle ---------------------------------------------------------
  startup(_data) {
    if (Zotero.Prefs.get(PREF_AUTO) === undefined) {
      Zotero.Prefs.set(PREF_AUTO, true);
    }
    if (Zotero.Prefs.get(PREF_RENAME) === undefined) {
      Zotero.Prefs.set(PREF_RENAME, true); // rename PDFs to match the key by default
    }
    this.checkBBTConflict();

    this.notifier = Zotero.Notifier.registerObserver(
      {
        notify: async (action, _type, ids, _extraData) => {
          if (!Zotero.Prefs.get(PREF_AUTO)) return; // pref gate
          if (action !== "add" && action !== "modify") return;
          try {
            const items = await Zotero.Items.getAsync(ids);
            const regular = items.filter(
              (item) => item.isRegularItem() && !item.isFeedItem
            );
            if (!regular.length) return;
            await Promise.all(regular.map((item) => item.loadAllData()));
            for (const item of regular) {
              await this.applyKey(item);
            }
          } catch (e) {
            this.log(`notifier error: ${e}`);
          }
        },
      },
      ["item"],
      OBSERVER_ID
    );
    this.log("startup complete");
  }

  shutdown() {
    if (typeof this.notifier !== "undefined") {
      Zotero.Notifier.unregisterObserver(this.notifier);
      this.notifier = undefined;
    }
    this.log("shutdown complete");
  }

  onMainWindowLoad({ window: _window }) {
    if (this.menuRegistered) return;
    try {
      Zotero.MenuManager.registerMenu({
        menuID: `${PLUGIN_ID}-generate`,
        pluginID: PLUGIN_ID,
        target: "main/library/item",
        menus: [
          {
            menuType: "menuitem",
            onShowing: (_event, context) => {
              const pane = Zotero.getActiveZoteroPane();
              const sel = pane ? pane.getSelectedItems() : [];
              const hasRegular = sel.some(
                (item) => item.isRegularItem() && !item.isFeedItem
              );
              context.setVisible(!!hasRegular);
              context.menuElem.setAttribute("label", "Generate citation key");
            },
            onCommand: (_event, _context) => {
              Zotero.CitationKeySculptor.generateForSelection();
            },
          },
        ],
      });
      this.menuRegistered = true;
      this.log("menu registered");
    } catch (e) {
      this.log(`menu registration failed: ${e}`);
    }
  }

  onMainWindowUnload({ window: _window }) {}

  // ----- core operations ---------------------------------------------------

  // Compute + write the key for one item, ONLY if it differs (loop-safe), then
  // rename its child PDFs deterministically (gated by PREF_RENAME).
  // Returns "written" | "unchanged" | "skipped" | "no-key".
  async applyKey(item) {
    if (!item || !item.isRegularItem() || item.isFeedItem) return "skipped";

    const fieldID = Zotero.ItemFields.getID("citationKey");
    if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
      return "skipped";
    }

    const computed = citationKeyFor(item);
    if (!computed) return "no-key";

    const current = item.getField("citationKey") || "";
    let result = "unchanged";
    if (computed !== current) {
      item.setField("citationKey", computed);
      await item.saveTx(); // convergence: self-fired modify recomputes same key -> no change
      result = "written";
    }

    // Rename child PDFs to deterministic key-derived names. Runs on written AND
    // unchanged so a stale filename is corrected even when the key didn't change.
    if (Zotero.Prefs.get(PREF_RENAME)) {
      try { await this.renameAttachments(item, computed); } catch (e) { this.log(`rename error (item ${item.id}): ${e}`); }
    }
    return result;
  }

  // Rename child PDFs deterministically: PDFs are sorted by attachment id and the
  // first becomes <citationKey>.pdf, then <citationKey>-2.pdf, <citationKey>-3.pdf …
  // Stable across runs (idempotent for multi-PDF parents — no suffix churn). Since
  // the citationKey is unique library-wide, same-plugin target collisions should not
  // occur; unexpected filesystem collisions are logged rather than auto-suffixed.
  // Works for stored AND linked files. Attachment renames fire 'modify' on the
  // ATTACHMENT (not a regular item), so the notifier's regular-item filter ignores
  // them — no rename loop.
  async renameAttachments(item, ck) {
    if (!ck) return 0;
    const attIds = item.getAttachments() || [];
    if (!attIds.length) return 0;
    const atts = await Zotero.Items.getAsync(attIds);
    const pdfs = atts
      .filter((a) => a.isFileAttachment && a.isFileAttachment() && a.attachmentContentType === "application/pdf")
      .sort((a, b) => a.id - b.id);
    let renamed = 0;
    for (let i = 0; i < pdfs.length; i++) {
      const att = pdfs[i];
      const target = i === 0 ? `${ck}.pdf` : `${ck}-${i + 1}.pdf`;
      if ((att.attachmentFilename || "") === target) continue; // already correct
      try {
        const r = await att.renameAttachmentFile(target, { overwrite: false, unique: false, updateTitle: true });
        if (r && r !== -1) renamed++;
        else this.log(`PDF rename skipped (att ${att.id}, target ${target}, result ${r})`);
      } catch (e) {
        this.log(`PDF rename failed (att ${att.id}): ${e}`);
      }
    }
    return renamed;
  }

  // Right-click handler: run on the current selection.
  async generateForSelection() {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return;
    const items = pane
      .getSelectedItems()
      .filter((item) => item.isRegularItem() && !item.isFeedItem);
    if (!items.length) {
      this.notify("No regular items selected.");
      return;
    }
    let written = 0, unchanged = 0, noKey = 0, soft = 0;
    for (const item of items) {
      try {
        await item.loadAllData();
        const r = await this.applyKey(item);
        if (r === "written") written++;
        else if (r === "unchanged") unchanged++;
        else if (r === "no-key") noKey++;
        // Soft (brief-title) fallback: a key was produced from the title ALONE,
        // with NO PMID/DOI/URL. Surface it (parity with CitationSculptor's
        // manual-review flag) so a "merely missing" identifier on a scholarly
        // item isn't mistaken for "fully grounded" — these are grounding targets.
        if ((r === "written" || r === "unchanged") &&
            (item.getField("citationKey") || "") &&
            !pmidOf(item) &&
            !safeGetField(item, "DOI").trim() &&
            !safeGetField(item, "url").trim()) {
          soft++;
        }
      } catch (e) {
        this.log(`generateForSelection error on item ${item.id}: ${e}`);
      }
    }
    this.notify(
      `Citation keys — written: ${written}, unchanged: ${unchanged}, skipped (no key): ${noKey}.` +
      (soft ? ` ${soft} used a soft brief-title fallback (no PMID/DOI/URL) — consider grounding.` : "")
    );
  }
}

// Singleton must exist the instant loadSubScript returns (bootstrap relies on it).
Zotero.CitationKeySculptor = new CitationKeySculptor();
