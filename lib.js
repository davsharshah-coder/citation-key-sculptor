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
const PUBMED_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";

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

function normalizeDoi(doi) {
  return (doi || "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
}

function pmcidOf(item) {
  const native = safeGetField(item, "PMCID").trim();
  if (native) return native.toUpperCase().startsWith("PMC") ? native.toUpperCase() : `PMC${native}`;
  const extra = safeGetField(item, "extra");
  const em = extra.match(/^\s*PMCID\s*:\s*(PMC)?(\d+)/im);
  if (em) return `PMC${em[2]}`;
  return "";
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
    this.doiPmidCache = new Map();
    this.pdfQueue = [];
    this.pdfQueueRunning = false;
    this.pdfQueueSeen = new Set();
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
          {
            menuType: "menuitem",
            onShowing: (_event, context) => {
              const pane = Zotero.getActiveZoteroPane();
              const sel = pane ? pane.getSelectedItems() : [];
              const hasRegular = sel.some(
                (item) => item.isRegularItem() && !item.isFeedItem
              );
              context.setVisible(!!hasRegular);
              context.menuElem.setAttribute("label", "Attach PDF from Comet / OSU EasyProxy");
            },
            onCommand: (_event, _context) => {
              Zotero.CitationKeySculptor.attachPdfFromCometForSelection();
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

  async pmidForDoi(doi) {
    const clean = (doi || "").trim();
    if (!clean) return "";
    const key = clean.toLowerCase();
    if (this.doiPmidCache.has(key)) return this.doiPmidCache.get(key);

    const url =
      `${PUBMED_ESEARCH}?db=pubmed&retmode=json&retmax=2&term=` +
      encodeURIComponent(`${clean}[DOI]`);
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        this.log(`PubMed DOI lookup failed (${resp.status}) for ${clean}`);
        this.doiPmidCache.set(key, "");
        return "";
      }
      const data = await resp.json();
      const ids = (data && data.esearchresult && data.esearchresult.idlist) || [];
      if (ids.length === 1 && /^\d+$/.test(ids[0])) {
        this.doiPmidCache.set(key, ids[0]);
        return ids[0];
      }
      if (ids.length > 1) {
        this.log(`PubMed DOI lookup ambiguous for ${clean}: ${ids.join(", ")}`);
      }
    } catch (e) {
      this.log(`PubMed DOI lookup error for ${clean}: ${e}`);
    }
    this.doiPmidCache.set(key, "");
    return "";
  }

  async groundPmidFromDoi(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return false;
    if (pmidOf(item)) return false;

    const doi = safeGetField(item, "DOI").trim();
    if (!doi) return false;

    const fieldID = Zotero.ItemFields.getID("PMID");
    if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
      return false;
    }

    const pmid = await this.pmidForDoi(doi);
    if (!pmid) return false;

    item.setField("PMID", pmid);
    this.log(`Grounded DOI ${doi} to PMID ${pmid} for item ${item.key}`);
    return true;
  }

  async hasPdfAttachment(item) {
    const attIds = item.getAttachments() || [];
    if (!attIds.length) return false;
    const atts = await Zotero.Items.getAsync(attIds);
    return atts.some((a) =>
      a.isFileAttachment &&
      a.isFileAttachment() &&
      a.attachmentContentType === "application/pdf"
    );
  }

  async runSmartCapture(item, ck) {
    const helper = OS.Path.join(
      OS.Constants.Path.homeDir,
      ".claude",
      "Bin",
      "zotero-smart-capture",
      "zotero-smart-capture"
    );
    const args = [
      "resolve-pdf",
      "--doi", safeGetField(item, "DOI").trim(),
      "--pmid", pmidOf(item),
      "--pmcid", pmcidOf(item),
      "--citation-key", ck,
      "--title", safeGetField(item, "title"),
      "--no-notify",
    ];
    let stdout = "";
    let data = {};
    try {
      stdout = await Zotero.Utilities.Internal.subprocess(helper, args);
      data = JSON.parse((stdout || "{}").trim());
    } catch (e) {
      data = { ok: false, status: "error", error: (stdout || String(e)).slice(0, 500) };
    }
    if (data.status === "error") {
      this.log(`smart-capture failed for ${item.key}: ${JSON.stringify(data)}`);
    }
    return data;
  }

  async placeLinkedPdf(tempPath, ck) {
    const baseDir = Zotero.Prefs.get("baseAttachmentPath");
    if (!baseDir) {
      throw new Error("Zotero linked-file base directory is not configured (baseAttachmentPath).");
    }
    const filename = `${ck}.pdf`;
    const destPath = OS.Path.join(baseDir, filename);
    const exists = await OS.File.exists(destPath);
    if (exists) {
      const tempMd5 = await Zotero.Utilities.Internal.md5Async(tempPath);
      const destMd5 = await Zotero.Utilities.Internal.md5Async(destPath);
      try { await OS.File.remove(tempPath); } catch (e) {}
      if (tempMd5 === destMd5) {
        return { path: destPath, filename };
      }
      throw new Error(`Linked-file target already exists with different bytes: ${destPath}`);
    }
    await OS.File.copy(tempPath, destPath, { noOverwrite: true });
    try { await OS.File.remove(tempPath); } catch (e) {}
    return { path: destPath, filename };
  }

  async attachCometPdfToItem(item) {
    await item.loadAllData();
    if (await this.hasPdfAttachment(item)) {
      return { status: "skipped-has-pdf" };
    }
    if (!normalizeDoi(safeGetField(item, "DOI"))) {
      return { status: "skipped-not-eligible" };
    }

    const keyStatus = await this.applyKey(item);
    const ck = safeGetField(item, "citationKey") || citationKeyFor(item);
    if (!ck) throw new Error("Could not derive citation key before attaching PDF.");

    const smart = await this.runSmartCapture(item, ck);
    if (!smart || !smart.ok || !smart.path) {
      this.log(`No PDF found for item ${item.key}: ${JSON.stringify(smart)}`);
      return { status: "no-pdf-found" };
    }
    let attachment;
    try {
      const linked = await this.placeLinkedPdf(smart.path, ck);
      attachment = await Zotero.Attachments.linkFromFileWithRelativePath({
        path: linked.filename,
        parentItemID: item.id,
        title: "Full Text PDF",
        contentType: "application/pdf",
      });
    } catch (e) {
      try { await OS.File.remove(smart.path); } catch (_ignore) {}
      throw e;
    }
    await this.renameAttachments(item, ck);
    return {
      status: "attached",
      url: smart.url || "",
      keyStatus,
      attachmentKey: attachment ? attachment.key : "",
      size: smart.size || 0,
    };
  }

  // Test/support entry point for debug-bridge and future automation.
  async attachPdfFromCometForItemKey(itemKey) {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, itemKey);
    if (!item) throw new Error(`Item not found: ${itemKey}`);
    return await this.attachCometPdfToItem(item);
  }

  enqueuePdfItems(items) {
    let queued = 0;
    for (const item of items) {
      const queueKey = `${item.libraryID}:${item.id}`;
      if (this.pdfQueueSeen.has(queueKey)) continue;
      this.pdfQueueSeen.add(queueKey);
      this.pdfQueue.push({ id: item.id, libraryID: item.libraryID, key: item.key, queueKey });
      queued++;
    }
    if (!this.pdfQueueRunning) {
      this.processPdfQueue(); // Intentionally fire-and-forget so Zotero remains usable.
    }
    return queued;
  }

  async processPdfQueue() {
    if (this.pdfQueueRunning) return;
    this.pdfQueueRunning = true;
    let attached = 0, skipped = 0, notEligible = 0, notFound = 0, failed = 0;
    try {
      while (this.pdfQueue.length) {
        const entry = this.pdfQueue.shift();
        try {
          const item = await Zotero.Items.getAsync(entry.id);
          if (!item || !item.isRegularItem || !item.isRegularItem() || item.isFeedItem) {
            notEligible++;
            continue;
          }
          const result = await this.attachCometPdfToItem(item);
          if (result.status === "attached") attached++;
          else if (result.status === "skipped-has-pdf") skipped++;
          else if (result.status === "skipped-not-eligible") notEligible++;
          else if (result.status === "no-pdf-found") notFound++;
          else failed++;
        } catch (e) {
          failed++;
          this.log(`PDF queue error on item ${entry.key || entry.id}: ${e}`);
        } finally {
          this.pdfQueueSeen.delete(entry.queueKey);
        }
      }
    } finally {
      this.pdfQueueRunning = false;
      this.notify(
        `Comet / OSU PDF attach finished — attached: ${attached}, already had PDF: ${skipped}, ` +
        `not eligible: ${notEligible}, not found: ${notFound}, failed: ${failed}.`
      );
      if (this.pdfQueue.length) {
        this.processPdfQueue();
      }
    }
  }

  // Compute + write the key for one item, ONLY if it differs (loop-safe), then
  // rename its child PDFs deterministically (gated by PREF_RENAME).
  // Returns "written" | "unchanged" | "skipped" | "no-key".
  async applyKey(item) {
    if (!item || !item.isRegularItem() || item.isFeedItem) return "skipped";

    const fieldID = Zotero.ItemFields.getID("citationKey");
    if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
      return "skipped";
    }

    const grounded = await this.groundPmidFromDoi(item);
    const computed = citationKeyFor(item);
    if (!computed) return "no-key";

    const current = item.getField("citationKey") || "";
    let result = "unchanged";
    if (computed !== current) {
      item.setField("citationKey", computed);
    }
    if (grounded || computed !== current) {
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

  async attachPdfFromCometForSelection() {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return;
    const items = pane
      .getSelectedItems()
      .filter((item) => item.isRegularItem() && !item.isFeedItem);
    if (!items.length) {
      this.notify("No regular items selected.");
      return;
    }

    const queued = this.enqueuePdfItems(items);
    this.notify(
      queued
        ? `Queued ${queued} item${queued === 1 ? "" : "s"} for Comet / OSU PDF attach. You can keep using Zotero.`
        : "Selected items are already queued for Comet / OSU PDF attach."
    );
  }
}

// Singleton must exist the instant loadSubScript returns (bootstrap relies on it).
Zotero.CitationKeySculptor = new CitationKeySculptor();
