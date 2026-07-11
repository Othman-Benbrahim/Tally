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

  // ══════════════════════════════════════════════════════════════════════════
  // EMPOISONNEMENT ANTI-FINGERPRINTING (opt-in par site)
  // --------------------------------------------------------------------------
  // POISON reste false par défaut. Le content script l'active en envoyant un
  // message _obs_cfg si l'utilisateur a activé la protection pour ce site.
  // SÉCURITÉ : on n'honore QUE l'activation. Une page ne peut jamais DÉSACTIVER
  // la protection via un message forgé (on ignore poison:false).
  // La détection (envoyer) reste TOUJOURS active — la protection ne fait que
  // fausser en plus la valeur lue par le traceur, sans casser le site.
  // ══════════════════════════════════════════════════════════════════════════
  let POISON = false;
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d._obs_cfg === true && d.poison === true) POISON = true;
  });

  // Bruit déterministe par session : la MÊME lecture donne le MÊME résultat
  // faussé pendant la session (une empreinte stable-mais-fausse est plus
  // crédible et casse la déduplication du traceur qu'un bruit qui change).
  const SEED = (Math.random() * 4294967296) >>> 0;
  function bruit(i) {
    let x = (SEED ^ (i * 2654435761)) >>> 0;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return (x % 3) - 1; // -1, 0 ou +1
  }
  function clamp(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

  // Natives capturées AVANT tout remplacement (usage interne pour toDataURL).
  const C2D = (typeof CanvasRenderingContext2D !== "undefined") ? CanvasRenderingContext2D.prototype : null;
  const nativeGetImageData = C2D ? C2D.getImageData : null;
  const nativePutImageData = C2D ? C2D.putImageData : null;

  // Perturbe une partie des pixels d'un ImageData (±1 sur le rouge, 1 pixel/4).
  function poisonnerPixels(data) {
    for (let i = 0; i < data.length; i += 16) {
      const n = bruit(i);
      if (n) data[i] = clamp(data[i] + n);
    }
  }

  // --------------------------------------------------------------------------
  // Remplace proto[methode] par une version instrumentée (détection only).
  // --------------------------------------------------------------------------
  function hooker(proto, methode, signal) {
    if (!proto || typeof proto[methode] !== "function") return;
    const original = proto[methode];
    proto[methode] = function () {
      envoyer(signal);
      return original.apply(this, arguments);
    };
  }

  // ── Canvas fingerprinting (détection + empoisonnement) ────────────────────
  if (typeof HTMLCanvasElement !== "undefined") {
    // getImageData : après lecture native, on bruite les pixels renvoyés.
    if (C2D && typeof C2D.getImageData === "function") {
      const orig = C2D.getImageData;
      C2D.getImageData = function () {
        envoyer("canvas.getImageData");
        const img = orig.apply(this, arguments);
        if (POISON && img && img.data) poisonnerPixels(img.data);
        return img;
      };
    }

    // toDataURL / toBlob : on bruite le canvas 2D AVANT sérialisation, via les
    // natives (pour ne pas repasser par notre hook getImageData). Sans effet
    // sur les canvas WebGL (pas de contexte 2D) — ceux-là sont couverts plus bas.
    function hookSerial(methode, signal) {
      if (typeof HTMLCanvasElement.prototype[methode] !== "function") return;
      const original = HTMLCanvasElement.prototype[methode];
      HTMLCanvasElement.prototype[methode] = function () {
        envoyer(signal);
        if (POISON && nativeGetImageData && nativePutImageData && this.width && this.height) {
          try {
            const ctx = this.getContext && this.getContext("2d");
            if (ctx) {
              const img = nativeGetImageData.call(ctx, 0, 0, this.width, this.height);
              poisonnerPixels(img.data);
              nativePutImageData.call(ctx, img, 0, 0);
            }
          } catch (e) { /* canvas non lisible (CORS) ou WebGL : on laisse tel quel */ }
        }
        return original.apply(this, arguments);
      };
    }
    hookSerial("toDataURL", "canvas.toDataURL");
    hookSerial("toBlob", "canvas.toBlob");
  }

  // ── WebGL fingerprinting (détection + mensonge sur le GPU) ─────────────────
  function hookWebGL(proto, signal) {
    if (!proto || typeof proto.getParameter !== "function") return;
    const original = proto.getParameter;
    proto.getParameter = function (pname) {
      // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
      if (pname === 37445 || pname === 37446) {
        envoyer(signal, "modèle GPU");
        if (POISON) {
          // On ne ment que sur ces deux paramètres : le rendu n'est pas affecté.
          return pname === 37445 ? "Google Inc." : "ANGLE (Generic, Generic Renderer)";
        }
      }
      return original.apply(this, arguments);
    };
  }
  hookWebGL(window.WebGLRenderingContext  && WebGLRenderingContext.prototype,  "webgl.getParameter");
  hookWebGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, "webgl2.getParameter");

  // ── Audio fingerprinting (détection + bruit inaudible) ─────────────────────
  if (window.AnalyserNode && typeof AnalyserNode.prototype.getFloatFrequencyData === "function") {
    const orig = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function (arr) {
      envoyer("audio.getFloatFrequencyData");
      const r = orig.apply(this, arguments);
      if (POISON && arr && arr.length) {
        for (let i = 0; i < arr.length; i += 1) arr[i] += bruit(i) * 1e-5;
      }
      return r;
    };
  }
  if (window.AudioBuffer && typeof AudioBuffer.prototype.getChannelData === "function") {
    const orig = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function () {
      envoyer("audio.getChannelData");
      const data = orig.apply(this, arguments);
      if (POISON && data && data.length) {
        // Bruit épars et inaudible (~1e-7) — imperceptible, casse l'empreinte.
        for (let i = 0; i < data.length; i += 100) data[i] += bruit(i) * 1e-7;
      }
      return data;
    };
  }

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
