"use strict";

// ============================================================================
// consent-didomi.js — content script (monde isolé), sur TOUS les sites
// ----------------------------------------------------------------------------
// Si l'utilisateur a activé le refus automatique de consentement Didomi
// (réglage global consentAutoRejectGlobal), injecte le pilote Didomi dans la page.
//
// Le pilote (consent-didomi-page.js) ne fait ABSOLUMENT RIEN sur un site qui
// n'utilise pas Didomi : il se contente d'enregistrer des callbacks dans les
// files d'attente du SDK Didomi, lesquelles ne sont jamais consommées si le SDK
// n'est pas présent. L'injection universelle est donc sans effet ni risque
// ailleurs que sur les sites Didomi.
//
// Opt-in strict : sans activation explicite, ce script ne fait rien.
// ============================================================================

(function () {
  browser.storage.local.get("consentAutoRejectGlobal").then(function (r) {
    if (!r || r.consentAutoRejectGlobal !== true) return;

    var s = document.createElement("script");
    s.src = browser.runtime.getURL("consent-didomi-page.js");
    s.addEventListener("load", function () { s.remove(); });
    (document.head || document.documentElement).appendChild(s);
  }).catch(function () {});
})();
