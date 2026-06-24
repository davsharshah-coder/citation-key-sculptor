// ============================================================================
// Citation Key Sculptor — bootstrap.js
// Zotero 7/8/9 bootstrapped-plugin lifecycle plumbing ONLY.
// Mirrors the PMCID Fetcher pattern: load lib.js into the privileged sandbox
// (which injects `Zotero`), then forward every lifecycle callback to the
// singleton that lib.js attaches at Zotero.CitationKeySculptor.
//
// `Zotero` is a module-level global supplied by Zotero when it evaluates this
// file. `Services` is available in the bootstrap scope.
// ============================================================================

/* eslint-disable no-unused-vars */

function install(_data, _reason) {}

function uninstall(_data, _reason) {}

async function startup({ resourceURI, rootURI = resourceURI.spec }, _reason) {
  // loadSubScript evaluates lib.js with { Zotero } injected into its scope.
  // lib.js ends with `Zotero.CitationKeySculptor = new CitationKeySculptor();`
  // so the singleton exists the moment this call returns.
  // Zotero 9 (Gecko 140) removed the legacy `OS` (osfile) global. Pass the modern
  // file APIs into lib.js's scope so its filesystem calls bind: IOUtils/PathUtils are
  // privileged-sandbox globals; FileUtils is imported here for the home directory.
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  Services.scriptloader.loadSubScript(`${rootURI}lib.js`, { Zotero, IOUtils, PathUtils, FileUtils });
  Zotero.CitationKeySculptor.startup({ rootURI });
  const win = Zotero.getMainWindow();
  if (win) {
    Zotero.CitationKeySculptor.onMainWindowLoad({ window: win });
  }
}

function shutdown(_data, _reason) {
  Zotero.CitationKeySculptor?.shutdown();
  // Drop the singleton so a re-enable starts clean.
  if (typeof Zotero !== "undefined" && Zotero.CitationKeySculptor) {
    Zotero.CitationKeySculptor = undefined;
  }
}

function onMainWindowLoad({ window }) {
  Zotero.CitationKeySculptor?.onMainWindowLoad({ window });
}

function onMainWindowUnload({ window }) {
  Zotero.CitationKeySculptor?.onMainWindowUnload({ window });
}
