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
const PUBMED_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

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

function cleanExtractedDoi(value) {
  const doi = normalizeDoi(value)
    .replace(/[)\].,;]+$/g, "")
    .replace(/%2f/gi, "/");
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : "";
}

function doiFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const doiParam = u.searchParams.get("doi");
    if (doiParam) {
      const decoded = decodeURIComponent(doiParam);
      const doi = cleanExtractedDoi(decoded);
      if (doi) return doi;
    }
    const decodedPath = decodeURIComponent(u.pathname || "");
    const pathMatch = decodedPath.match(/(?:\/doi\/(?:full|abs|epdf|pdf)?\/?|\/)(10\.\d{4,9}\/[^?#]+)/i);
    if (pathMatch) {
      const doi = cleanExtractedDoi(pathMatch[1]);
      if (doi) return doi;
    }
  } catch (e) {}
  const m = decodeURIComponent(raw).match(/10\.\d{4,9}\/[^\s"'<>]+/i);
  return m ? cleanExtractedDoi(m[0]) : "";
}

function pmidFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (!/pubmed|ncbi\.nlm\.nih\.gov/i.test(u.hostname)) return "";
    const m = `${u.pathname}/`.match(/\/(\d{6,9})(?:[/?#.]|$)/);
    return m ? m[1] : "";
  } catch (e) {
    const m = raw.match(/pubmed[^0-9]*(\d{6,9})(?:[/?#.]|$)/i);
    return m ? m[1] : "";
  }
}

function isCapturedResolverUrl(value) {
  return /click\.endnote\.com|clinicalkey|pubmed[-.a-z0-9]*proxy\.lib\.ohio-state\.edu/i.test(value || "");
}

function isPubMedCorrectionCandidate(item) {
  const url = safeGetField(item, "url").trim();
  return !!pmidOf(item) ||
    !!pmcidOf(item) ||
    !!normalizeDoi(safeGetField(item, "DOI")) ||
    !!doiFromUrl(url) ||
    !!pmidFromUrl(url) ||
    isCapturedResolverUrl(url);
}

function normalizeTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/&[a-z]+;/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|and|or|of|for|to|in|on|with|by|from|among)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesMatchExactly(input, candidate) {
  const a = normalizeTitle(input);
  const b = normalizeTitle(candidate);
  return !!a && !!b && a === b;
}

function titleWithoutCaptureSuffix(title) {
  return (title || "")
    .replace(/\s*\|\s*EndNote\s+Click\s*$/i, "")
    .replace(/\s*-\s*ClinicalKey\s*$/i, "")
    .replace(/\s*-\s*SciSpace\s+Literature\s+Review\s*$/i, "")
    .replace(/\s*\|\s*Psychology\s+Today\s*$/i, "")
    .replace(/\s*\|\s*[^|]{2,80}\s*$/i, "")
    .trim();
}

function titlesMatchAfterCaptureCleanup(input, candidate) {
  return titlesMatchExactly(input, candidate) ||
    titlesMatchExactly(titleWithoutCaptureSuffix(input), candidate);
}

function pubmedTitleSearchTerms(title) {
  const tokens = normalizeTitle(title)
    .split(" ")
    .filter((w) => w.length > 2 || /^\d{4}$/.test(w));
  const selected = tokens
    .filter((w) => !/^(united|states)$/.test(w) || tokens.length < 8)
    .slice(0, 10);
  return selected.length
    ? selected.map((w) => `${w}[Title]`).join(" AND ")
    : `"${title}"[Title]`;
}

function cleanPubMedExtra(extra) {
  return (extra || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*(Citation Key|PMID|PMCID|Place)\s*:/i.test(line))
    .join("\n")
    .trim();
}

function parseXmlDocument(xml) {
  const win = Zotero.getMainWindow && Zotero.getMainWindow();
  if (win && win.DOMParser) {
    return new win.DOMParser().parseFromString(xml, "application/xml");
  }
  if (typeof DOMParser !== "undefined") {
    return new DOMParser().parseFromString(xml, "application/xml");
  }
  return Components.classes["@mozilla.org/xmlextras/domparser;1"]
    .createInstance(Components.interfaces.nsIDOMParser)
    .parseFromString(xml, "application/xml");
}

function yearMatches(a, b) {
  const ay = Number(yearOf(a));
  const by = Number(yearOf(b));
  return !!ay && !!by && Math.abs(ay - by) <= 1;
}

function normalizedLastName(name) {
  return foldAscii(name || "").toLowerCase();
}

function firstCreatorLastName(item) {
  const creators = item.getCreators() || [];
  const first = creators.find((creator) => creator.lastName);
  return first ? normalizedLastName(first.lastName) : "";
}

function directChild(node, tagName) {
  if (!node || !node.children) return null;
  return Array.from(node.children).find((child) => child.tagName === tagName) || null;
}

function titleCaseJournalTitle(value) {
  const lowerWords = new Set([
    "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor",
    "of", "on", "or", "per", "the", "to", "v", "via", "vs", "with",
  ]);
  const input = String(value || "").trim().replace(/\s+/g, " ");
  if (!input) return "";
  return input.split(" ").map((word, index, words) => {
    const bare = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    const leading = word.slice(0, word.indexOf(bare));
    const trailing = word.slice(word.indexOf(bare) + bare.length);
    if (!bare) return word;
    if (/[A-Z]{2,}|\d/.test(bare)) return word;
    const lower = bare.toLowerCase();
    const forceCap = index === 0 || index === words.length - 1 || /[:.;!?]$/.test(words[index - 1] || "");
    const cased = !forceCap && lowerWords.has(lower)
      ? lower
      : lower.charAt(0).toUpperCase() + lower.slice(1);
    return leading + cased + trailing;
  }).join(" ");
}

async function fetchWithRetry(url, opts = {}) {
  const attempts = opts.attempts || 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const resp = await fetch(url);
    if (resp.status !== 429 && resp.status !== 503) return resp;
    const retryAfter = Number(resp.headers.get("Retry-After") || "");
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 750 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return await fetch(url);
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
    this.optimizeQueue = [];
    this.optimizeQueueRunning = false;
    this.optimizeQueueSeen = new Set();
  }

  log(msg) {
    Zotero.debug(`[CitationKeySculptor] ${msg}`);
  }

  notify(text, opts = {}) {
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Citation Key Sculptor");
      pw.addDescription(text);
      pw.show();
      pw.startCloseTimer(4000);
    } catch (e) {
      this.log(`progress notification failed: ${e}`);
    }
    if (opts.macOS) {
      this.notifyMacOS(text);
    }
  }

  async notifyMacOS(text) {
    try {
      const win = Zotero.getMainWindow && Zotero.getMainWindow();
      const NotificationCtor = win && win.Notification;
      if (NotificationCtor && NotificationCtor.permission === "granted") {
        const notification = new NotificationCtor("Citation Key Sculptor", {
          body: text,
          requireInteraction: false,
          silent: false,
        });
        if (notification && typeof notification.close === "function") {
          win.setTimeout(() => notification.close(), 8000);
        }
        return true;
      }
    } catch (e) {
      this.log(`native notification failed: ${e}`);
    }
    try {
      await Zotero.Utilities.Internal.subprocess("/usr/bin/osascript", [
        "-e",
        "on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run",
        "Citation Key Sculptor",
        text,
      ]);
      return true;
    } catch (e) {
      this.log(`macOS notification failed: ${e}`);
    }
    return false;
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
              context.menuElem.setAttribute("label", "Correct Metadata from PubMed");
            },
            onCommand: (_event, _context) => {
              Zotero.CitationKeySculptor.correctMetadataFromPubMedForSelection();
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
              context.menuElem.setAttribute("label", "Optimize Metadata and Attachments");
            },
            onCommand: (_event, _context) => {
              Zotero.CitationKeySculptor.optimizeMetadataAndAttachmentsForSelection();
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
              context.menuElem.setAttribute("label", "Repair Dead PDF Links");
            },
            onCommand: (_event, _context) => {
              Zotero.CitationKeySculptor.repairDeadPdfLinksForSelection();
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
          {
            menuType: "menuitem",
            onShowing: (_event, context) => {
              const pane = Zotero.getActiveZoteroPane();
              const sel = pane ? pane.getSelectedItems() : [];
              const hasRegular = sel.some(
                (item) => item.isRegularItem() && !item.isFeedItem
              );
              context.setVisible(!!hasRegular);
              context.menuElem.setAttribute("label", "Attach Archival PDF from Web Page");
            },
            onCommand: (_event, _context) => {
              Zotero.CitationKeySculptor.attachArchivalPdfForSelection();
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
      const resp = await fetchWithRetry(url);
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

  async pmidForTitle(title) {
    const clean = (title || "").trim();
    if (!clean) return "";
    const queries = [
      `"${clean}"[Title]`,
      pubmedTitleSearchTerms(clean),
    ];
    for (const term of queries) {
      const url =
        `${PUBMED_ESEARCH}?db=pubmed&retmode=json&retmax=100&term=` +
        encodeURIComponent(term);
      try {
        const resp = await fetchWithRetry(url);
        if (!resp.ok) continue;
        const data = await resp.json();
        const ids = (data && data.esearchresult && data.esearchresult.idlist) || [];
        for (const id of ids) {
          const pm = await this.pubmedRecord(id);
          if (pm && titlesMatchAfterCaptureCleanup(clean, pm.title)) return id;
        }
      } catch (e) {
        this.log(`PubMed title lookup error for ${clean}: ${e}`);
      }
    }
    return "";
  }

  async pmidForItem(item) {
    const existing = pmidOf(item);
    if (existing) return { pmid: existing, authority: "native-pmid" };

    const url = safeGetField(item, "url").trim();
    const childUrls = [];
    try {
      const attIds = item.getAttachments() || [];
      if (attIds.length) {
        const atts = await Zotero.Items.getAsync(attIds);
        for (const att of atts) {
          const u = safeGetField(att, "url").trim();
          if (u) childUrls.push(u);
        }
      }
    } catch (e) {}

    for (const candidateUrl of [url, ...childUrls]) {
      const pmid = pmidFromUrl(candidateUrl);
      if (pmid) return { pmid, authority: "url-pmid" };
    }

    const nativeDoi = normalizeDoi(safeGetField(item, "DOI"));
    const extractedDoi = nativeDoi || [url, ...childUrls].map(doiFromUrl).find(Boolean) || "";
    if (extractedDoi) {
      const pmid = await this.pmidForDoi(extractedDoi);
      if (pmid) return { pmid, authority: nativeDoi ? "native-doi" : "url-doi", doi: extractedDoi };
    }

    const title = titleWithoutCaptureSuffix(safeGetField(item, "title")).trim();
    const pmid = await this.pmidForTitle(title);
    if (pmid) return { pmid, authority: "title" };
    return { pmid: "", authority: "" };
  }

  textOf(node, selector) {
    const match = node && node.querySelector(selector);
    return match && match.textContent ? match.textContent.trim() : "";
  }

  async pubmedRecord(pmid) {
    const clean = (pmid || "").trim();
    if (!/^\d+$/.test(clean)) return null;
    const url =
      `${PUBMED_EFETCH}?db=pubmed&id=${encodeURIComponent(clean)}` +
      "&rettype=xml&retmode=xml";
    const resp = await fetchWithRetry(url);
    if (!resp.ok) {
      throw new Error(`PubMed efetch failed for ${clean}: HTTP ${resp.status}`);
    }
    const xml = await resp.text();
    const doc = parseXmlDocument(xml);
    const article = doc.querySelector("PubmedArticle");
    if (!article) return null;
    const ids = {};
    const pubmedData = directChild(article, "PubmedData");
    const articleIdList = directChild(pubmedData, "ArticleIdList");
    for (const node of articleIdList ? Array.from(articleIdList.children) : []) {
      if (node.tagName !== "ArticleId") continue;
      const type = (node.getAttribute("IdType") || "").toLowerCase();
      ids[type] = (node.textContent || "").trim();
    }
    const dateNode =
      article.querySelector("Article ArticleDate") ||
      article.querySelector("JournalIssue PubDate");
    const year = this.textOf(dateNode, "Year");
    const month = this.textOf(dateNode, "Month");
    const day = this.textOf(dateNode, "Day");
    const date = [year, month, day].filter(Boolean).join(" ");
    const authors = [];
    for (const author of article.querySelectorAll("AuthorList Author")) {
      const collective = this.textOf(author, "CollectiveName");
      const lastName = this.textOf(author, "LastName");
      const firstName = this.textOf(author, "ForeName");
      if (collective) {
        authors.push({ name: collective });
      } else if (lastName || firstName) {
        authors.push({ lastName, firstName });
      }
    }
    const abstract = Array.from(article.querySelectorAll("Abstract AbstractText"))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n");
    return {
      pmid: clean,
      pmcid: (ids.pmc || ids.pmcid || "").replace(/^pmc-id:\s*/i, "").replace(/;$/, "").toUpperCase(),
      doi: normalizeDoi(ids.doi || ""),
      title: this.textOf(article, "ArticleTitle"),
      journal: this.textOf(article, "Journal > Title"),
      journalAbbrev: this.textOf(article, "Journal ISOAbbreviation") || this.textOf(article, "MedlineTA"),
      issn: this.textOf(article, "Journal ISSN"),
      volume: this.textOf(article, "JournalIssue Volume"),
      issue: this.textOf(article, "JournalIssue Issue"),
      pages: this.textOf(article, "Pagination MedlinePgn"),
      date,
      abstract,
      authors,
    };
  }

  setFieldIfValid(item, field, value) {
    if (!value) return false;
    const fieldID = Zotero.ItemFields.getID(field);
    if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
      return false;
    }
    if ((item.getField(field) || "") === value) return false;
    item.setField(field, value);
    return true;
  }

  async correctMetadataFromPubMed(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem() || item.isFeedItem) {
      return { status: "skipped" };
    }
    await item.loadAllData();
    if (!isPubMedCorrectionCandidate(item)) {
      return { status: "skipped-not-article-like" };
    }
    const title = safeGetField(item, "title").trim();
    const match = await this.pmidForItem(item);
    const pmid = match.pmid;
    if (!pmid) return { status: "no-match" };
    const pm = await this.pubmedRecord(pmid);
    if (!pm || !titlesMatchAfterCaptureCleanup(title, pm.title)) return { status: "no-match" };
    const itemFirstCreator = firstCreatorLastName(item);
    const pubmedLastNames = pm.authors
      .map((author) => normalizedLastName(author.lastName || author.name || ""))
      .filter(Boolean);
    const authorOK =
      !!itemFirstCreator &&
      pubmedLastNames.some((lastName) => lastName === itemFirstCreator);
    const yearOK = yearMatches(safeGetField(item, "date"), pm.date);
    const identifierAuthority = /^(native|url)-(pmid|doi)$/.test(match.authority || "");
    if (!identifierAuthority && !authorOK && !yearOK) {
      this.log(`PubMed correction rejected for ${item.key}: title matched PMID ${pmid}, but author/year corroboration failed`);
      return { status: "no-match" };
    }

    let changed = false;
    const journalTypeID = Zotero.ItemTypes.getID("journalArticle");
    if (item.itemTypeID !== journalTypeID) {
      item.setType(journalTypeID);
      changed = true;
    }

    const authorTypeID = Zotero.CreatorTypes.getID("author");
    const creators = pm.authors.map((author) => {
      if (author.name) {
        return { creatorTypeID: authorTypeID, fieldMode: 1, lastName: author.name };
      }
      return {
        creatorTypeID: authorTypeID,
        firstName: author.firstName || "",
        lastName: author.lastName || "",
      };
    });
    if (creators.length) {
      item.setCreators(creators);
      changed = true;
    }

    changed = this.setFieldIfValid(item, "title", pm.title) || changed;
    changed = this.setFieldIfValid(item, "publicationTitle", titleCaseJournalTitle(pm.journal)) || changed;
    changed = this.setFieldIfValid(item, "journalAbbreviation", pm.journalAbbrev) || changed;
    changed = this.setFieldIfValid(item, "ISSN", pm.issn) || changed;
    changed = this.setFieldIfValid(item, "volume", pm.volume) || changed;
    changed = this.setFieldIfValid(item, "issue", pm.issue) || changed;
    changed = this.setFieldIfValid(item, "pages", pm.pages) || changed;
    changed = this.setFieldIfValid(item, "date", pm.date) || changed;
    changed = this.setFieldIfValid(item, "DOI", pm.doi) || changed;
    changed = this.setFieldIfValid(item, "PMID", pm.pmid) || changed;
    changed = this.setFieldIfValid(item, "PMCID", pm.pmcid) || changed;
    if (isCapturedResolverUrl(safeGetField(item, "url"))) {
      changed = this.setFieldIfValid(item, "url", `https://pubmed.ncbi.nlm.nih.gov/${pm.pmid}/`) || changed;
    }
    if (pm.abstract && !safeGetField(item, "abstractNote").trim()) {
      changed = this.setFieldIfValid(item, "abstractNote", pm.abstract) || changed;
    }
    const cleanedExtra = cleanPubMedExtra(safeGetField(item, "extra"));
    if (cleanedExtra !== safeGetField(item, "extra").trim()) {
      item.setField("extra", cleanedExtra);
      changed = true;
    }
    const ck = citationKeyFor(item);
    if (ck && safeGetField(item, "citationKey") !== ck) {
      item.setField("citationKey", ck);
      changed = true;
    }
    if (changed) {
      await item.saveTx();
      this.log(`Corrected ${item.key} from PubMed PMID ${pmid}`);
      return { status: "corrected", pmid, citationKey: ck };
    }
    return { status: "unchanged", pmid, citationKey: ck };
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

  async pdfAttachmentStatus(item) {
    const attIds = item.getAttachments() || [];
    if (!attIds.length) return { live: [], dead: [] };
    const atts = await Zotero.Items.getAsync(attIds);
    const live = [];
    const dead = [];
    for (const a of atts) {
      if (!a || !a.isFileAttachment || !a.isFileAttachment() || a.attachmentContentType !== "application/pdf") {
        continue;
      }
      let filePath = "";
      let exists = false;
      try {
        filePath = a.getFilePath ? a.getFilePath() : "";
        exists = !!filePath && await IOUtils.exists(filePath);
      } catch (e) {
        exists = false;
      }
      if (exists) live.push(a);
      else dead.push(a);
    }
    return { live, dead };
  }

  async hasPdfAttachment(item) {
    const status = await this.pdfAttachmentStatus(item);
    return status.live.length > 0;
  }

  async trashDeadPdfAttachments(item) {
    const status = await this.pdfAttachmentStatus(item);
    if (!status.dead.length) return 0;
    await Zotero.Items.trashTx(status.dead.map((a) => a.id));
    return status.dead.length;
  }

  async runSmartCapture(item, ck, mode = "source") {
    const helper = PathUtils.join(
      FileUtils.getDir("Home", []).path,
      ".claude",
      "Bin",
      "zotero-smart-capture",
      "zotero-smart-capture"
    );
    const args = [
      mode === "archival" ? "resolve-archival-pdf" : "resolve-pdf",
      "--doi", safeGetField(item, "DOI").trim(),
      "--pmid", pmidOf(item),
      "--pmcid", pmcidOf(item),
      "--citation-key", ck,
      "--title", safeGetField(item, "title"),
      "--year", yearOf(safeGetField(item, "date") || item.getField("date", false, true) || ""),
      "--url", safeGetField(item, "url"),
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
    const destPath = PathUtils.join(baseDir, filename);
    const exists = await IOUtils.exists(destPath);
    if (exists) {
      const tempMd5 = await Zotero.Utilities.Internal.md5Async(tempPath);
      const destMd5 = await Zotero.Utilities.Internal.md5Async(destPath);
      try { await IOUtils.remove(tempPath, { ignoreAbsent: true }); } catch (e) {}
      if (tempMd5 === destMd5) {
        return { path: destPath, filename };
      }
      throw new Error(`Linked-file target already exists with different bytes: ${destPath}`);
    }
    await IOUtils.copy(tempPath, destPath, { noOverwrite: true });
    try { await IOUtils.remove(tempPath, { ignoreAbsent: true }); } catch (e) {}
    return { path: destPath, filename };
  }

  async attachCometPdfToItem(item, mode = "source") {
    await item.loadAllData();
    const pdfStatus = await this.pdfAttachmentStatus(item);
    if (pdfStatus.live.length) {
      return { status: "skipped-has-pdf" };
    }
    if (mode === "archival" && !safeGetField(item, "url").trim() && !normalizeDoi(safeGetField(item, "DOI"))) {
      return { status: "skipped-not-eligible" };
    }
    if (mode !== "archival" && !normalizeDoi(safeGetField(item, "DOI")) && !pmidOf(item) && !pmcidOf(item) && !safeGetField(item, "url").trim() && !safeGetField(item, "title").trim()) {
      return { status: "skipped-not-eligible" };
    }

    const keyStatus = await this.applyKey(item);
    const ck = safeGetField(item, "citationKey") || citationKeyFor(item);
    if (!ck) throw new Error("Could not derive citation key before attaching PDF.");

    const smart = await this.runSmartCapture(item, ck, mode);
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
        title: mode === "archival" ? "Archival PDF (Generated from Web Page)" : "Full Text PDF",
        contentType: "application/pdf",
      });
    } catch (e) {
      try { await IOUtils.remove(smart.path, { ignoreAbsent: true }); } catch (_ignore) {}
      throw e;
    }
    await this.renameAttachments(item, ck);
    const deadLinksRepaired = await this.trashDeadPdfAttachments(item);
    return {
      status: "attached",
      url: smart.url || "",
      captureMode: smart.captureMode || (mode === "archival" ? "markdown-derived" : ""),
      keyStatus,
      deadLinksRepaired,
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

  isSourcePdfCandidate(item) {
    const typeName = Zotero.ItemTypes.getName(item.itemTypeID);
    return typeName === "journalArticle" ||
      !!normalizeDoi(safeGetField(item, "DOI")) ||
      !!pmidOf(item) ||
      !!pmcidOf(item);
  }

  async optimizeBasicItemType(item) {
    const url = safeGetField(item, "url").trim();
    if (!url) return false;
    const hasHardIdentifier = !!normalizeDoi(safeGetField(item, "DOI")) || !!pmidOf(item) || !!pmcidOf(item);
    if (hasHardIdentifier) return false;

    let target = "";
    if (/nature\.com\/articles\/[^/]+\/figures\//i.test(url)) {
      target = "webpage";
    } else if (/wsj\.com|washingtonpost\.com|sfchronicle\.com|economictimes\.indiatimes\.com|kathmandupost\.com/i.test(url)) {
      target = "newspaperArticle";
    }
    if (!target) return false;
    const targetID = Zotero.ItemTypes.getID(target);
    if (targetID && item.itemTypeID !== targetID) {
      item.setType(targetID);
      await item.saveTx();
      return true;
    }
    return false;
  }

  async optimizeMetadataAndAttachment(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem() || item.isFeedItem) {
      return { status: "skipped" };
    }
    await item.loadAllData();
    const beforeHadPdf = await this.hasPdfAttachment(item);
    const beforeDeadPdfLinks = (await this.pdfAttachmentStatus(item)).dead.length;
    let corrected = { status: "skipped-not-article-like" };
    if (isPubMedCorrectionCandidate(item)) {
      try {
        corrected = await this.correctMetadataFromPubMed(item);
      } catch (e) {
        this.log(`Metadata optimization failed for ${item.key}: ${e}`);
        corrected = { status: "failed", error: String(e) };
      }
    }
    await item.loadAllData();
    await this.optimizeBasicItemType(item);
    await item.loadAllData();
    const keyStatus = await this.applyKey(item);
    if (beforeHadPdf || await this.hasPdfAttachment(item)) {
      return { status: "metadata-only", corrected: corrected.status, keyStatus, deadLinks: beforeDeadPdfLinks };
    }

    const url = safeGetField(item, "url").trim();
    const mode = this.isSourcePdfCandidate(item) ? "source" : (url ? "archival" : "");
    if (!mode) {
      return { status: "no-attachment-source", corrected: corrected.status, keyStatus };
    }
    const attached = await this.attachCometPdfToItem(item, mode);
    return { status: attached.status, mode, corrected: corrected.status, keyStatus, deadLinks: beforeDeadPdfLinks, deadLinksRepaired: attached.deadLinksRepaired || 0 };
  }

  enqueueOptimizeItems(items) {
    let queued = 0;
    for (const item of items) {
      if (!item || !item.isRegularItem || !item.isRegularItem() || item.isFeedItem) continue;
      const queueKey = `optimize:${item.libraryID}:${item.id}`;
      if (this.optimizeQueueSeen.has(queueKey)) continue;
      this.optimizeQueueSeen.add(queueKey);
      this.optimizeQueue.push({ id: item.id, libraryID: item.libraryID, key: item.key, queueKey });
      queued++;
    }
    if (!this.optimizeQueueRunning) {
      this.processOptimizeQueue();
    }
    return queued;
  }

  async processOptimizeQueue() {
    if (this.optimizeQueueRunning) return;
    this.optimizeQueueRunning = true;
    let attached = 0, metadataOnly = 0, skipped = 0, notFound = 0, failed = 0, deadLinksRepaired = 0;
    try {
      while (this.optimizeQueue.length) {
        const entry = this.optimizeQueue.shift();
        try {
          const item = await Zotero.Items.getAsync(entry.id);
          const result = await this.optimizeMetadataAndAttachment(item);
          if (result.status === "attached") attached++;
          else if (result.status === "metadata-only" || result.status === "skipped-has-pdf") metadataOnly++;
          else if (result.status === "no-pdf-found") notFound++;
          else if (result.status === "skipped" || result.status === "skipped-not-eligible" || result.status === "no-attachment-source") skipped++;
          else failed++;
          deadLinksRepaired += result.deadLinksRepaired || 0;
        } catch (e) {
          failed++;
          this.log(`Optimize queue error on item ${entry.key || entry.id}: ${e}`);
        } finally {
          this.optimizeQueueSeen.delete(entry.queueKey);
        }
      }
    } finally {
      this.optimizeQueueRunning = false;
      this.notify(
        `Record optimization finished — attached: ${attached}, metadata only: ${metadataOnly}, ` +
        `not found: ${notFound}, skipped: ${skipped}, failed: ${failed}, dead links repaired: ${deadLinksRepaired}.`,
        { macOS: true }
      );
      if (this.optimizeQueue.length) {
        this.processOptimizeQueue();
      }
    }
  }

  enqueuePdfItems(items, mode = "source") {
    let queued = 0;
    for (const item of items) {
      const queueKey = `${mode}:${item.libraryID}:${item.id}`;
      if (this.pdfQueueSeen.has(queueKey)) continue;
      this.pdfQueueSeen.add(queueKey);
      this.pdfQueue.push({ id: item.id, libraryID: item.libraryID, key: item.key, queueKey, mode });
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
    let attached = 0, skipped = 0, notEligible = 0, notFound = 0, failed = 0, deadLinksRepaired = 0;
    try {
      while (this.pdfQueue.length) {
        const entry = this.pdfQueue.shift();
        try {
          const item = await Zotero.Items.getAsync(entry.id);
          if (!item || !item.isRegularItem || !item.isRegularItem() || item.isFeedItem) {
            notEligible++;
            continue;
          }
          const result = await this.attachCometPdfToItem(item, entry.mode || "source");
          if (result.status === "attached") attached++;
          else if (result.status === "skipped-has-pdf") skipped++;
          else if (result.status === "skipped-not-eligible") notEligible++;
          else if (result.status === "no-pdf-found") notFound++;
          else failed++;
          deadLinksRepaired += result.deadLinksRepaired || 0;
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
        `PDF attach finished — attached: ${attached}, already had PDF: ${skipped}, ` +
        `not eligible: ${notEligible}, not found: ${notFound}, failed: ${failed}, dead links repaired: ${deadLinksRepaired}.`,
        { macOS: true }
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
    const pdfs = [];
    for (const a of atts) {
      if (!a || !a.isFileAttachment || !a.isFileAttachment() || a.attachmentContentType !== "application/pdf") {
        continue;
      }
      let exists = false;
      try {
        const filePath = a.getFilePath ? a.getFilePath() : "";
        exists = !!filePath && await IOUtils.exists(filePath);
      } catch (e) {
        exists = false;
      }
      if (exists) pdfs.push(a);
    }
    pdfs.sort((a, b) => a.id - b.id);
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

  async correctMetadataFromPubMedForSelection() {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return;
    const items = pane
      .getSelectedItems()
      .filter((item) => item.isRegularItem() && !item.isFeedItem);
    if (!items.length) {
      this.notify("No regular items selected.");
      return;
    }
    let corrected = 0, unchanged = 0, noMatch = 0, failed = 0;
    for (const item of items) {
      try {
        const result = await this.correctMetadataFromPubMed(item);
        if (result.status === "corrected") corrected++;
        else if (result.status === "unchanged") unchanged++;
        else if (result.status === "no-match") noMatch++;
      } catch (e) {
        failed++;
        this.log(`PubMed metadata correction error on item ${item.id}: ${e}`);
      }
    }
    this.notify(
      `PubMed correction — corrected: ${corrected}, unchanged: ${unchanged}, ` +
      `no match: ${noMatch}, failed: ${failed}.`
    );
  }

  async optimizeMetadataAndAttachmentsForSelection() {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return;
    const items = pane
      .getSelectedItems()
      .filter((item) => item.isRegularItem() && !item.isFeedItem);
    if (!items.length) {
      this.notify("No regular items selected.");
      return;
    }
    const queued = this.enqueueOptimizeItems(items);
    this.notify(
      queued
        ? `Queued ${queued} item${queued === 1 ? "" : "s"} for metadata and attachment optimization. You can keep using Zotero.`
        : "Selected items are already queued for metadata and attachment optimization."
    );
  }

  async repairDeadPdfLinksForSelection() {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return;
    const items = pane
      .getSelectedItems()
      .filter((item) => item.isRegularItem() && !item.isFeedItem);
    if (!items.length) {
      this.notify("No regular items selected.");
      return;
    }
    const queued = this.enqueuePdfItems(items, "source");
    this.notify(
      queued
        ? `Queued ${queued} item${queued === 1 ? "" : "s"} for dead PDF link repair. You can keep using Zotero.`
        : "Selected items are already queued for PDF repair."
    );
  }

  async queuePdfSelection(mode, queuedMessage, duplicateMessage) {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return;
    const items = pane
      .getSelectedItems()
      .filter((item) => item.isRegularItem() && !item.isFeedItem);
    if (!items.length) {
      this.notify("No regular items selected.");
      return;
    }

    const queued = this.enqueuePdfItems(items, mode);
    this.notify(
      queued
        ? queuedMessage(queued)
        : duplicateMessage
    );
  }

  async attachPdfFromCometForSelection() {
    await this.queuePdfSelection(
      "source",
      (queued) => `Queued ${queued} item${queued === 1 ? "" : "s"} for Comet / OSU PDF attach. You can keep using Zotero.`,
      "Selected items are already queued for Comet / OSU PDF attach."
    );
  }

  async attachArchivalPdfForSelection() {
    await this.queuePdfSelection(
      "archival",
      (queued) => `Queued ${queued} item${queued === 1 ? "" : "s"} for archival web-page PDF attach. You can keep using Zotero.`,
      "Selected items are already queued for archival web-page PDF attach."
    );
  }
}

// Singleton must exist the instant loadSubScript returns (bootstrap relies on it).
Zotero.CitationKeySculptor = new CitationKeySculptor();
