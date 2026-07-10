"use strict";

// ============================================================================
// hook-page.js — s'exécute dans le MONDE DE LA PAGE (main world)
// ----------------------------------------------------------------------------
// Ce fichier est injecté par content-hook.js via un élément <script> pointant
// vers sa ressource moz-extension://. Il tourne donc dans le même contexte
// JavaScript que les scripts de la page, ce qui lui permet de remplacer les
// méthodes natives sans aucun problème de cross-monde ou de Xray wrapper.
//
// Communication vers le content script : window.postMessage (même fenêtre).
// Le content script filtre les messages par l'indicateur { _obs: true }.
//
// PRINCIPE : on remplace les méthodes sur les prototypes AVANT que tout script
// de la page n'ait eu le temps de s'exécuter (le content script injecte ce
// fichier à document_start). Même si la page fait une copie locale de la
// fonction native APRÈS notre remplacement, l'appel via la chaîne de prototypes
// passera toujours par notre version.
// ============================================================================

(function () {

  // Dé-duplication par signal : on n'envoie qu'un seul message par type par
  // chargement de cadre. Les boucles d'animation légitimes peuvent appeler
  // getImageData ou getParameter des milliers de fois — inutile d'inonder.
  const vu = new Set();

  function envoyer(signal, detail) {
    if (vu.has(signal)) return;
    vu.add(signal);
    window.postMessage({
      _obs:    true,
      signal:  signal,
      detail:  detail || null,
      frameUrl: location.href,
      at:      Date.now()
    }, "*");
  }

  // --------------------------------------------------------------------------
  // Remplace proto[methode] par une version instrumentée.
  // On conserve la référence à l'original AVANT le remplacement pour pouvoir
  // déléguer sans modifier le comportement de la page.
  // --------------------------------------------------------------------------
  function hooker(proto, methode, signal) {
    if (!proto || typeof proto[methode] !== "function") return;
    const original = proto[methode];
    proto[methode] = function () {
      envoyer(signal);
      return original.apply(this, arguments);
    };
  }

  // ── Canvas fingerprinting ─────────────────────────────────────────────────
  // Technique la plus répandue : dessiner du texte hors-écran et lire les
  // pixels — le rendu varie selon le GPU, les pilotes et les polices installées.
  hooker(HTMLCanvasElement.prototype,      "toDataURL",   "canvas.toDataURL");
  hooker(HTMLCanvasElement.prototype,      "toBlob",      "canvas.toBlob");
  hooker(CanvasRenderingContext2D.prototype, "getImageData", "canvas.getImageData");

  // ── WebGL fingerprinting ──────────────────────────────────────────────────
  // getParameter est appelé constamment par tout rendu WebGL légitime.
  // On ne signale QUE les constantes UNMASKED_* (37445 et 37446) qui exposent
  // le modèle de GPU — l'identifiant le plus stable et le plus exploité.
  function hookWebGL(proto, signal) {
    if (!proto || typeof proto.getParameter !== "function") return;
    const original = proto.getParameter;
    proto.getParameter = function (pname) {
      // 37445 = UNMASKED_VENDOR_WEBGL
      // 37446 = UNMASKED_RENDERER_WEBGL
      if (pname === 37445 || pname === 37446) {
        envoyer(signal, "modèle GPU");
      }
      return original.apply(this, arguments);
    };
  }
  hookWebGL(window.WebGLRenderingContext  && WebGLRenderingContext.prototype,  "webgl.getParameter");
  hookWebGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, "webgl2.getParameter");

  // ── Audio fingerprinting ──────────────────────────────────────────────────
  // Un contexte audio hors-ligne produit une sortie qui varie selon la pile
  // audio de la machine. Signal à pondérer : les lecteurs légitimes l'utilisent
  // aussi.
  hooker(window.AnalyserNode  && AnalyserNode.prototype,  "getFloatFrequencyData", "audio.getFloatFrequencyData");
  hooker(window.AudioBuffer   && AudioBuffer.prototype,   "getChannelData",        "audio.getChannelData");

  // ── Attribution des cookies posés en JavaScript ───────────────────────────
  // On remplace le SETTER de document.cookie. Quand un script fait
  //   document.cookie = "nom=valeur; ..."
  // notre setter s'exécute, identifie le nom du cookie et le script fautif
  // (via la pile d'appels), signale l'événement, PUIS délègue au setter natif
  // pour ne rien casser. On ne transmet jamais la VALEUR du cookie — seulement
  // son nom et l'origine — pour ne pas exfiltrer de données sensibles.

  // Extrait la première URL de script de la pile qui n'est pas notre propre
  // hook. Format Firefox : "fonction@https://site/script.js:12:34".
  function scriptDepuisPile(pile) {
    if (!pile) return null;
    const lignes = pile.split("\n");
    for (const ligne of lignes) {
      const m = ligne.match(/@(.*?):\d+:\d+\s*$/);
      if (m && m[1] && m[1].indexOf("moz-extension://") === -1) {
        return m[1];
      }
    }
    return null;
  }

  try {
    // Le couple get/set de document.cookie est défini sur Document.prototype
    // (ou HTMLDocument.prototype selon les versions). On cherche les deux.
    let cible = Document.prototype;
    let desc = Object.getOwnPropertyDescriptor(cible, "cookie");
    if (!desc && window.HTMLDocument) {
      cible = HTMLDocument.prototype;
      desc = Object.getOwnPropertyDescriptor(cible, "cookie");
    }

    if (desc && desc.configurable && typeof desc.set === "function") {
      const setNatif = desc.set;
      const getNatif = desc.get;

      Object.defineProperty(cible, "cookie", {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          return getNatif.call(this);
        },
        set: function (valeur) {
          try {
            // "nom=valeur; path=/; domain=..."  ->  on ne garde que le nom.
            const nom = String(valeur).split("=")[0].trim();
            const script = scriptDepuisPile((new Error()).stack);
            window.postMessage({
              _obs:     true,
              type:     "cookie-set",
              name:     nom,
              scriptUrl: script,
              frameUrl: location.href,
              at:       Date.now()
            }, "*");
          } catch (e) { /* on n'empêche jamais l'écriture du cookie */ }
          return setNatif.call(this, valeur);
        }
      });
    }
  } catch (e) { /* accesseur non configurable sur ce site : on renonce à ce hook */ }

  // ── Confirmation d'installation ───────────────────────────────────────────
  // Si ce message n'arrive pas, le content script sait que l'injection a
  // échoué (CSP bloquante) — information utile et honnête.
  window.postMessage({
    _obs:     true,
    signal:   "__probe-ok__",
    frameUrl: location.href,
    at:       Date.now()
  }, "*");

})();
