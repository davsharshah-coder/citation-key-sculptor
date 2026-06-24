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
const OBSERVER_ID = "citation-key-sculptor";

// ----------------------------------------------------------------------------
// citationKeyFor algorithm — ported faithfully from zotero-curate/index.ts.
// Key format: foldAscii(FirstAuthorLastName) + initials(ALL given names)
//             + '-' + Year + '-' + Identifier
//   e.g. AbbasiJ-2026-41893839, ODonoghueML-2022-36342163
// Identifier fallback chain: PMID -> 'DOI'+foldAscii(DOI) -> URL hostname.
// Returns '' when author, year, or identifier is missing.
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
// native PMID field -> Extra "PMID: n" line -> existing citationKey suffix.
function pmidOf(item) {
  const native = safeGetField(item, "PMID").trim();
  if (native) return native;
  const extra = safeGetField(item, "extra");
  const em = extra.match(/^\s*PMID\s*:\s*(\d+)/im);
  if (em) return em[1];
  const ck = safeGetField(item, "citationKey");
  const cm = ck.match(/-(\d{6,9})$/);
  if (cm) return cm[1];
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

  const indiv = (creators || []).filter(
    (c) => isAuthor(c) && c.fieldMode !== 1 && c.lastName
  );
  if (indiv.length > 0) {
    const a = indiv[0];
    return {
      token: foldAscii(a.lastName) + initialsOf(a.firstName || ""),
      orgFallback: false,
    };
  }

  const org = (creators || []).find(
    (c) => isAuthor(c) && c.fieldMode === 1 && c.lastName
  );
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

  // Year-less web items: emit "ND" (matches CitationSculptor). Non-web items
  // still require a real year (else no key).
  const effYear = year || (isWeb && idPart ? "ND" : "");
  if (token && effYear && idPart) return token + "-" + effYear + "-" + idPart;
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

  // Compute + write the key for one item, ONLY if it differs (loop-safe).
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
    if (computed === current) return "unchanged"; // convergence guard

    item.setField("citationKey", computed);
    await item.saveTx();
    return "written";
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
    let written = 0, unchanged = 0, noKey = 0;
    for (const item of items) {
      try {
        await item.loadAllData();
        const r = await this.applyKey(item);
        if (r === "written") written++;
        else if (r === "unchanged") unchanged++;
        else if (r === "no-key") noKey++;
      } catch (e) {
        this.log(`generateForSelection error on item ${item.id}: ${e}`);
      }
    }
    this.notify(
      `Citation keys — written: ${written}, unchanged: ${unchanged}, skipped (no key): ${noKey}.`
    );
  }
}

// Singleton must exist the instant loadSubScript returns (bootstrap relies on it).
Zotero.CitationKeySculptor = new CitationKeySculptor();
