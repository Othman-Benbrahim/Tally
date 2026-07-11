"use strict";

// ============================================================================
// content-hook.js — content script (monde isolé du content script)
// ----------------------------------------------------------------------------
// Deux rôles :
//
//   1. Injecter hook-page.js dans le monde de la page via un élément <script>
//      pointant vers la ressource moz-extension://. L'injection a lieu à
//      document_start, avant tout script de la page.
//
//   2. Écouter les messages postMessage envoyés par hook-page.js et les
//      relayer au background via runtime.sendMessage.
//
// Pourquoi postMessage et non exportFunction ?
//   exportFunction fait tourner notre code dans le monde du content script,
//   mais original.apply(this, arguments) échoue silencieusement quand this
//   vient du monde de la page (cross-monde Xray). La solution fiable est
//   d'exécuter TOUT le code de hook dans le monde de la page, et de n'utiliser
//   le content script que comme relais de messages.
// ============================================================================

// ── 1. Injection de hook-page.js dans le monde de la page ────────────────────
(function injecterHook() {
  const script = document.createElement("script");

  // browser.runtime.getURL produit l'URL moz-extension:// de la ressource.
  // Cette ressource doit être déclarée dans web_accessible_resources du manifest
  // pour que la page puisse la charger.
  script.src = browser.runtime.getURL("hook-page.js");

  // On retire l'élément après chargement pour rester discret dans le DOM.
  script.addEventListener("load", function () {
    script.remove();
  });

  // On préfère <head> mais on se rabat sur <html> si le head n'existe pas encore
  // (possible à document_start sur des pages très inhabituelles).
  (document.head || document.documentElement).appendChild(script);
})();


// ── 1bis. Activation de l'empoisonnement anti-fingerprinting (opt-in) ─────────
// Lecture (asynchrone) du réglage par site. Si la protection est activée pour
// cet hôte, on demande à hook-page.js de fausser les valeurs lues. La détection
// reste active dans tous les cas ; seule la falsification est conditionnelle.
(function activerProtectionFp() {
  var host = location.hostname.replace(/^www\./, "");
  browser.storage.local.get("fpPoison").then(function (r) {
    var map = (r && r.fpPoison) || {};
    var actif = Object.keys(map).some(function (k) {
      return map[k] && (host === k || host.endsWith("." + k));
    });
    if (actif) {
      // On n'envoie QUE l'activation. hook-page.js ignore toute désactivation
      // par message : une page ne peut pas désactiver la protection.
      window.postMessage({ _obs_cfg: true, poison: true }, location.origin);
    }
  }).catch(function () {});
})();


// ── 2. Réception des messages de hook-page.js ─────────────────────────────────
window.addEventListener("message", function (event) {

  // On n'accepte que les messages de la même fenêtre (pas d'iframes parentes
  // ou d'autres onglets).
  if (event.source !== window) return;

  // On filtre par notre marqueur interne { _obs: true }.
  // Note : une page malveillante pourrait imiter ce format, mais elle ne peut
  // qu'injecter de faux signaux de fingerprinting — aucune action dangereuse
  // n'est déclenchée par ces messages, donc le risque est nul.
  if (!event.data || event.data._obs !== true) return;

  const msg = event.data;

  // ── Confirmation d'installation de la sonde ──────────────────────────────
  if (msg.signal === "__probe-ok__") {
    browser.runtime.sendMessage({
      kind:     "probe-installed",
      frameUrl: msg.frameUrl,
      topLevel: (window === window.top),
      at:       msg.at
    }).catch(function () {
      // Le background peut ne pas être prêt dans les tout premiers instants.
    });
    return;
  }

  // ── Cookie posé en JavaScript (document.cookie = ...) ────────────────────
  if (msg.type === "cookie-set") {
    browser.runtime.sendMessage({
      kind:      "cookie-set",
      name:      msg.name,
      scriptUrl: msg.scriptUrl || null,
      frameUrl:  msg.frameUrl,
      topLevel:  (window === window.top),
      at:        msg.at
    }).catch(function () {});
    return;
  }

  // ── Signal de fingerprinting détecté ────────────────────────────────────
  browser.runtime.sendMessage({
    kind:     "fingerprint-signal",
    signal:   msg.signal,
    detail:   msg.detail || null,
    frameUrl: msg.frameUrl,
    topLevel: (window === window.top),
    at:       msg.at
  }).catch(function () {});

});
