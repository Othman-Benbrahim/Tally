"use strict";

// ============================================================================
// consent-didomi.js — content script (monde isolé), sur doctissimo uniquement
// ----------------------------------------------------------------------------
// Vérifie si l'utilisateur a activé le refus automatique de consentement pour
// ce site (réglage stocké dans storage.local). Si oui, injecte le pilote Didomi
// (consent-didomi-page.js) dans le monde de la page.
//
// Opt-in strict : sans activation explicite, ce script ne fait absolument rien.
// ============================================================================

(function () {
  var host = location.hostname.replace(/^www\./, "");

  browser.storage.local.get("consentAutoReject").then(function (r) {
    var map = (r && r.consentAutoReject) || {};
    // Actif si une clé de plateforme activée correspond à l'hôte courant.
    var actif = Object.keys(map).some(function (k) {
      return map[k] && (host === k || host.endsWith("." + k));
    });
    if (!actif) return;

    var s = document.createElement("script");
    s.src = browser.runtime.getURL("consent-didomi-page.js");
    s.addEventListener("load", function () { s.remove(); });
    (document.head || document.documentElement).appendChild(s);
  }).catch(function () {});
})();
