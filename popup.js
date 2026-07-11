"use strict";

// ============================================================================
// popup.js — auto-diagnostiquant
// ----------------------------------------------------------------------------
// Toute erreur au chargement ou au runtime est affichée DANS le popup (bandeau
// rouge #error) au lieu de laisser un panneau blanc muet. Un popup Firefox
// n'affiche pas ses erreurs de console : c'est donc le seul moyen fiable de
// savoir ce qui ne va pas sans passer par le débogueur.
// ============================================================================

// ── Affichage d'erreur visible dès que possible ─────────────────────────────
function afficherErreur(texte) {
  const box = document.getElementById("error");
  if (box) {
    box.style.display = "block";
    box.textContent = "⚠ " + texte;
  }
}

// Capte toute erreur JS non gérée (y compris celles hors de nos try/catch).
window.addEventListener("error", function (e) {
  afficherErreur("Erreur JS : " + e.message + "\n" + (e.filename || "") + ":" + (e.lineno || "?"));
});
window.addEventListener("unhandledrejection", function (e) {
  afficherErreur("Promesse rejetée : " + (e.reason && e.reason.message ? e.reason.message : e.reason));
});

// ── Vérification que l'API extension est présente ───────────────────────────
// Si 'browser' est indéfini, c'est que le fichier n'est pas chargé comme un
// popup d'extension (ou une incompatibilité rare). On le dit clairement.
if (typeof browser === "undefined" || !browser.runtime) {
  afficherErreur("L'API 'browser' est indisponible. Ce fichier n'est pas exécuté dans un contexte d'extension Firefox.");
}

// ── Références DOM ───────────────────────────────────────────────────────────
const elStatus     = document.getElementById("probe-status");
const elUrl        = document.getElementById("current-url");
const elMessage    = document.getElementById("message");
const elSectionSig = document.getElementById("section-signals");
const elSignalList = document.getElementById("signal-list");
const elFrameCount = document.getElementById("frame-count");
const btnRefresh   = document.getElementById("btn-refresh");
const elSectionCk  = document.getElementById("section-cookies");
const elCookieList = document.getElementById("cookie-list");
const elCookieNote = document.getElementById("cookie-note");
const btnExport    = document.getElementById("btn-export");
const elSectionCand = document.getElementById("section-candidates");
const elCandList    = document.getElementById("candidate-list");
const elCandNote    = document.getElementById("candidate-note");
const btnExportCand = document.getElementById("btn-export-candidates");
const elSectionResp = document.getElementById("section-respawns");
const elRespList    = document.getElementById("respawn-list");
const elSectionBlocs = document.getElementById("section-blocs");
const elBlocList    = document.getElementById("bloc-list");
const elSectionCx   = document.getElementById("section-connexions");
const elCxNote      = document.getElementById("connexion-note");
const elCxList      = document.getElementById("connexion-list");
const elJournalInfo = document.getElementById("journal-info");
const elJournalSeal = document.getElementById("journal-seal");
const btnExportJournal = document.getElementById("btn-export-journal");
const elSectionConsent = document.getElementById("section-consent");
const elConsentToggle  = document.getElementById("consent-toggle");
const elConsentLabel   = document.getElementById("consent-label");
const elConsentHint    = document.getElementById("consent-hint");
const elSectionFp      = document.getElementById("section-fpprotect");
const elFpToggle       = document.getElementById("fp-toggle");
const elFpHint         = document.getElementById("fp-hint");

// Plateformes de consentement supportées (hôte -> nom du CMP).
// Le refus automatique n'est proposé que sur ces sites, et reste opt-in.
const PLATEFORMES_CONSENT = { "doctissimo.fr": "Didomi" };

// Hôte de la page courante, mémorisé pour les actions bloquer/débloquer.
let currentPageHost = null;
// Blocs actifs pour le site courant (motifs "host:"/"url:"), pour l'affichage.
let currentBlocs = [];

// Libellés FR des catégories du référentiel Disconnect.
const CATEGORY_LABEL = {
  advertising:    "publicité",
  analytics:      "analytics",
  social:         "réseau social",
  fingerprinting: "fingerprinting",
  cryptomining:   "minage",
  content:        "contenu",
  email:          "e-mail",
  antifraud:      "anti-fraude",
  consent:        "consentement",
  inconnu:        "non catégorisé"
};

// ── Libellés lisibles ────────────────────────────────────────────────────────
const SIGNAL_LABELS = {
  "canvas.toDataURL":            "Canvas → toDataURL",
  "canvas.toBlob":               "Canvas → toBlob",
  "canvas.getImageData":         "Canvas → getImageData",
  "webgl.getParameter":          "WebGL → paramètre GPU",
  "webgl2.getParameter":         "WebGL2 → paramètre GPU",
  "audio.getFloatFrequencyData": "Audio → fréquences",
  "audio.getChannelData":        "Audio → données canal"
};

const SIGNAL_DESC = {
  "canvas.toDataURL":            "Exportation de pixels canvas — technique d'empreinte courante.",
  "canvas.toBlob":               "Exportation binaire canvas — variante de l'empreinte canvas.",
  "canvas.getImageData":         "Lecture directe des pixels — peut reconstruire une empreinte GPU.",
  "webgl.getParameter":          "Lecture du modèle GPU — identifiant matériel très stable.",
  "webgl2.getParameter":         "Lecture du modèle GPU (WebGL2).",
  "audio.getFloatFrequencyData": "Empreinte basée sur la pile audio de la machine.",
  "audio.getChannelData":        "Lecture audio brute — variante de l'empreinte audio."
};

// ── Rendu ────────────────────────────────────────────────────────────────────
function render(state) {
  if (!state) {
    afficherErreur("Réponse vide du background.");
    return;
  }
  if (state.error) {
    elMessage.style.display = "block";
    elMessage.textContent = state.error;
    return;
  }

  elUrl.textContent = state.url || "—";

  const nb = state.framesSeen || 0;
  if (nb > 0) {
    elStatus.textContent = "sonde active (" + nb + " cadre" + (nb > 1 ? "s" : "") + ")";
    elStatus.className = "ok";
  } else {
    elStatus.textContent = "sonde non confirmée";
    elStatus.className = "failed";
  }
  elFrameCount.textContent = nb + " cadre" + (nb !== 1 ? "s" : "") + " instrumenté" + (nb !== 1 ? "s" : "");

  const signals = state.signals || [];

  if (signals.length === 0) {
    // On garde le message "aucun signal" mais on n'écrase pas la section cookies.
    elMessage.style.display = "block";
    elMessage.textContent = "";
    const noSig = document.createElement("div");
    noSig.className = "no-signal";
    noSig.textContent = "Aucun signal de fingerprinting détecté sur cette page.";
    elMessage.appendChild(noSig);
    elSectionSig.style.display = "none";
  } else {
    elMessage.style.display = "none";
    elSectionSig.style.display = "block";
    elSignalList.innerHTML = "";

    for (const s of signals) {
      const label = SIGNAL_LABELS[s.signal] || s.signal;
      const desc  = SIGNAL_DESC[s.signal]  || "";

      const item = document.createElement("div");
      item.className = "signal-item";

      const nameEl = document.createElement("div");
      nameEl.className = "signal-name";
      nameEl.textContent = label;

      const countEl = document.createElement("div");
      countEl.className = "signal-count";
      countEl.textContent = s.count + " appel" + (s.count !== 1 ? "s" : "");

      const detailEl = document.createElement("div");
      detailEl.className = "signal-detail";
      detailEl.textContent = s.detail ? ("↳ " + s.detail) : desc;

      item.appendChild(nameEl);
      item.appendChild(countEl);
      item.appendChild(detailEl);

      const frames = s.frames || [];
      if (frames.length > 0) {
        const framesEl = document.createElement("div");
        framesEl.className = "signal-frames";
        framesEl.textContent = frames.length === 1
          ? ("cadre : " + frames[0])
          : (frames.length + " cadres : " + frames.slice(0, 2).join(", ") + (frames.length > 2 ? "…" : ""));
        item.appendChild(framesEl);
      }

      elSignalList.appendChild(item);
    }
  }

  // ── Section cookies ────────────────────────────────────────────────────
  renderCookies(state.cookies || []);

  // ── Sections respawns / blocs / connexions ─────────────────────────────
  currentPageHost = state.pageHost || null;
  currentBlocs = state.blocs || [];
  renderRespawns(state.respawns || []);
  renderBlocs(state.blocs || []);
  renderConnexions(state.connexions || []);
  renderConsent();
  renderFpProtect();
}


// ── Protection anti-fingerprinting (empoisonnement, opt-in par site) ────────
function renderFpProtect() {
  // Proposée sur tout site http(s) réel (pas les pages internes).
  if (!currentPageHost) { elSectionFp.style.display = "none"; return; }
  elSectionFp.style.display = "block";

  var host = currentPageHost.replace(/^www\./, "");

  browser.storage.local.get("fpPoison").then(function (r) {
    var map = (r && r.fpPoison) || {};
    elFpToggle.checked = !!map[host];
  }).catch(function () {});

  elFpToggle.onchange = function () {
    browser.storage.local.get("fpPoison").then(function (r) {
      var map = (r && r.fpPoison) || {};
      map[host] = elFpToggle.checked;
      return browser.storage.local.set({ fpPoison: map });
    }).then(function () {
      elFpHint.textContent = elFpToggle.checked
        ? "Activé — recharge la page. Les valeurs d'empreinte seront faussées."
        : "Désactivé — recharge la page.";
    }).catch(function (e) {
      afficherErreur("Réglage impossible : " + (e && e.message ? e.message : e));
    });
  };
}


// ── Consentement (refus automatique via l'API du CMP, opt-in, par site) ─────
function plateformeConsent(host) {
  if (!host) return null;
  for (const k in PLATEFORMES_CONSENT) {
    if (host === k || host.endsWith("." + k)) return { key: k, cmp: PLATEFORMES_CONSENT[k] };
  }
  return null;
}

function renderConsent() {
  const p = plateformeConsent(currentPageHost);
  if (!p) { elSectionConsent.style.display = "none"; return; }

  elSectionConsent.style.display = "block";
  elConsentLabel.textContent = "Refuser automatiquement le consentement (" + p.cmp + ") sur " + p.key;

  browser.storage.local.get("consentAutoReject").then(function (r) {
    const map = (r && r.consentAutoReject) || {};
    elConsentToggle.checked = !!map[p.key];
  }).catch(function () {});

  elConsentToggle.onchange = function () {
    browser.storage.local.get("consentAutoReject").then(function (r) {
      const map = (r && r.consentAutoReject) || {};
      map[p.key] = elConsentToggle.checked;
      return browser.storage.local.set({ consentAutoReject: map });
    }).then(function () {
      elConsentHint.textContent = elConsentToggle.checked
        ? "Activé — recharge la page pour l'appliquer (refus réel via " + p.cmp + ")."
        : "Désactivé — recharge la page.";
    }).catch(function (e) {
      afficherErreur("Réglage impossible : " + (e && e.message ? e.message : e));
    });
  };
}


// ── Respawns détectés ───────────────────────────────────────────────────────
function renderRespawns(respawns) {
  if (!respawns || respawns.length === 0) { elSectionResp.style.display = "none"; return; }
  elSectionResp.style.display = "block";
  elRespList.innerHTML = "";

  for (const r of respawns) {
    const item = document.createElement("div");
    item.className = "respawn-item";

    const nameEl = document.createElement("div");
    nameEl.className = "respawn-name";
    nameEl.textContent = r.name + "  (revenu ×" + r.count + ")";

    // Le réanimateur = premier reviver connu ("js:url" ou "http:domaine").
    const reviver = (r.revivers && r.revivers[0]) || null;
    let pattern = null, libelle = "réanimateur inconnu";
    if (reviver) {
      const sep = reviver.indexOf(":");
      const type = reviver.slice(0, sep);
      const ref = reviver.slice(sep + 1);
      if (type === "js" && ref && ref !== "null") { pattern = "url:" + ref; libelle = "script : " + ref; }
      else if (type === "http" && ref) { pattern = "host:" + ref; libelle = "domaine : " + ref; }
      else libelle = type + " (réf. non identifiée)";
    }

    const btn = document.createElement("button");
    btn.className = "btn-block";
    if (pattern) {
      btn.textContent = "Bloquer";
      btn.addEventListener("click", function () { bloquerSource(pattern, item, btn); });
    } else {
      btn.textContent = "—";
      btn.disabled = true;
      btn.title = "Réanimateur non identifié : rien à bloquer précisément.";
    }

    const metaEl = document.createElement("div");
    metaEl.className = "respawn-meta";
    metaEl.textContent = "sur " + (r.domain || "?") + " · " + libelle;

    item.appendChild(nameEl);
    item.appendChild(btn);
    item.appendChild(metaEl);
    elRespList.appendChild(item);
  }
}

function bloquerSource(pattern, itemEl, btnEl) {
  if (!currentPageHost) { afficherErreur("Site courant inconnu : blocage impossible."); return; }
  btnEl.disabled = true; btnEl.textContent = "…";
  browser.runtime.sendMessage({ kind: "block-source", site: currentPageHost, pattern: pattern })
    .then(function (res) {
      if (res && res.ok) { btnEl.textContent = "Bloqué ✓"; itemEl.style.opacity = ".6"; refresh(); }
      else { btnEl.disabled = false; btnEl.textContent = "Réessayer"; }
    })
    .catch(function (e) { btnEl.disabled = false; btnEl.textContent = "Réessayer"; afficherErreur("Blocage : " + e.message); });
}


// ── Sources bloquées (avec déblocage) ───────────────────────────────────────
function renderBlocs(blocs) {
  if (!blocs || blocs.length === 0) { elSectionBlocs.style.display = "none"; return; }
  elSectionBlocs.style.display = "block";
  elBlocList.innerHTML = "";

  for (const motif of blocs) {
    const item = document.createElement("div");
    item.className = "bloc-item";

    const pat = document.createElement("div");
    pat.className = "bloc-pattern";
    pat.textContent = motif.replace(/^url:/, "script: ").replace(/^host:/, "domaine: ");

    const btn = document.createElement("button");
    btn.className = "btn-unblock";
    btn.textContent = "Débloquer";
    btn.addEventListener("click", function () {
      btn.disabled = true;
      browser.runtime.sendMessage({ kind: "unblock-source", site: currentPageHost, pattern: motif })
        .then(function () { refresh(); })
        .catch(function () { btn.disabled = false; });
    });

    item.appendChild(pat);
    item.appendChild(btn);
    elBlocList.appendChild(item);
  }
}


// ── Connexions tierces ──────────────────────────────────────────────────────
function renderConnexions(cx) {
  if (!cx || cx.length === 0) { elSectionCx.style.display = "none"; return; }
  elSectionCx.style.display = "block";

  // Un domaine est "bloqué sur ce site" s'il est dans la blocklist du site,
  // même si le chargement courant l'a déjà laissé passer (le blocage vaut pour
  // le prochain chargement).
  function estBloque(c) {
    return c.blockedByUs > 0 || currentBlocs.indexOf("host:" + c.host) !== -1;
  }

  const bloquees = cx.filter(estBloque).length;
  const echouees = cx.filter(function (c) { return c.failed > 0 && c.completed === 0; }).length;
  elCxNote.textContent =
    cx.length + " domaine" + (cx.length > 1 ? "s" : "") + " tiers contacté" + (cx.length > 1 ? "s" : "") +
    (bloquees ? " · " + bloquees + " bloqué(s) par toi" : "") +
    (echouees ? " · " + echouees + " échoué(s)/filtré(s)" : "");

  elCxList.innerHTML = "";
  for (const c of cx.slice(0, 15)) {
    const bloque = estBloque(c);

    const item = document.createElement("div");
    item.className = "connexion-item";

    const hostEl = document.createElement("div");
    hostEl.className = "connexion-host";
    hostEl.textContent = c.host;

    const statEl = document.createElement("div");
    statEl.className = "connexion-stat";
    statEl.textContent = c.count + "×" + (bloque ? " ⛔" : "") +
                         (!bloque && c.failed && !c.completed ? " ✕" : "");

    const metaEl = document.createElement("div");
    metaEl.className = "connexion-meta";
    const bits = [];
    if (c.category && c.category !== "inconnu") bits.push(CATEGORY_LABEL[c.category] || c.category);
    if (c.owner) bits.push(c.owner);
    if (c.types && c.types.length) bits.push(c.types.slice(0, 3).join(", "));
    metaEl.textContent = bits.join(" · ");

    item.appendChild(hostEl);
    item.appendChild(statEl);
    item.appendChild(metaEl);

    // Bouton de blocage : SEULEMENT sur les connexions réellement complétées
    // et pas déjà bloquées. On n'affiche rien sur les ✕ (déjà filtrées, ambigües).
    if (bloque) {
      const flag = document.createElement("div");
      flag.className = "connexion-actions blocked";
      flag.textContent = "⛔ bloqué sur ce site (débloquer via « Sources bloquées »)";
      item.appendChild(flag);
    } else if (c.completed > 0) {
      const actions = document.createElement("div");
      actions.className = "connexion-actions";
      const btn = document.createElement("button");
      btn.className = "btn-block-cx";
      btn.textContent = "Bloquer ce domaine";
      btn.title = "Blocage LARGE : coupe TOUT vers " + c.host + " sur ce site " +
                  "(y compris CDN, polices, scripts utiles). Effectif au prochain " +
                  "chargement. Réversible.";
      btn.addEventListener("click", function () {
        bloquerSource("host:" + c.host, item, btn);
      });
      actions.appendChild(btn);
      item.appendChild(actions);
    } else {
      // Uniquement échoué/filtré (completed === 0) : blocage PRÉVENTIF.
      // Le domaine ne passe pas actuellement (sans doute filtré par un autre
      // bloqueur), mais on peut le mettre en liste noire pour ce site afin
      // qu'il reste coupé même si cette protection disparaît.
      const actions = document.createElement("div");
      actions.className = "connexion-actions";
      const btn = document.createElement("button");
      btn.className = "btn-block-cx-prev";
      btn.textContent = "Bloquer préventivement";
      btn.title = "Ce domaine ne passe pas actuellement (échoué/filtré, sans doute " +
                  "par un autre bloqueur comme uBlock). Le mettre en liste noire pour " +
                  "ce site le coupera même si cette protection disparaît. Réversible.";
      btn.addEventListener("click", function () {
        bloquerSource("host:" + c.host, item, btn);
      });
      actions.appendChild(btn);
      item.appendChild(actions);
    }

    elCxList.appendChild(item);
  }
}


// ── Étiquettes des badges ──────────────────────────────────────────────────
const ORIGIN_LABEL = { http: "HTTP", js: "JS", inconnu: "préexistant" };
const PARTY_LABEL   = { tierce: "tierce partie", premiere: "1re partie", inconnu: "—" };

// ── Rendu de la liste des cookies ──────────────────────────────────────────
function renderCookies(cookies) {
  if (!cookies || cookies.length === 0) {
    elSectionCk.style.display = "none";
    return;
  }

  elSectionCk.style.display = "block";
  elCookieList.innerHTML = "";

  const nbTierces = cookies.filter(function (c) { return c.party === "tierce"; }).length;
  elCookieNote.textContent =
    cookies.length + " cookie" + (cookies.length > 1 ? "s" : "") +
    (nbTierces > 0 ? " · " + nbTierces + " en tierce partie" : "");

  for (const c of cookies) {
    const item = document.createElement("div");
    item.className = "cookie-item";

    // Nom
    const nameEl = document.createElement("div");
    nameEl.className = "cookie-name";
    nameEl.textContent = c.name;

    // Bouton supprimer
    const btn = document.createElement("button");
    btn.className = "btn-delete";
    btn.textContent = "Supprimer";
    btn.addEventListener("click", function () {
      supprimerCookie(c, item, btn);
    });

    // Domaine + durée
    const domEl = document.createElement("div");
    domEl.className = "cookie-domain";
    domEl.textContent = c.domain + (c.path && c.path !== "/" ? c.path : "");
    if (c.duration) {
      const dur = document.createElement("span");
      dur.className = "cookie-duration" + (c.durationLong ? " longue" : "");
      dur.textContent = "  · " + c.duration;
      domEl.appendChild(dur);
    }

    // Entité propriétaire (si connue)
    let ownerEl = null;
    if (c.owner) {
      ownerEl = document.createElement("div");
      ownerEl.className = "cookie-owner";
      ownerEl.textContent = "entité : " + c.owner;
    }

    // Badges : origine, partie, catégorie
    const badges = document.createElement("div");
    badges.className = "badges";

    const bOrigin = document.createElement("span");
    bOrigin.className = "badge " + c.origin;
    bOrigin.textContent = ORIGIN_LABEL[c.origin] || c.origin;
    badges.appendChild(bOrigin);

    const bParty = document.createElement("span");
    bParty.className = "badge " + c.party;
    bParty.textContent = PARTY_LABEL[c.party] || c.party;
    badges.appendChild(bParty);

    if (c.category) {
      const bCat = document.createElement("span");
      bCat.className = "badge cat-" + c.category;
      bCat.textContent = CATEGORY_LABEL[c.category] || c.category;
      badges.appendChild(bCat);
    }

    // Inférence (clairement étiquetée)
    const inferEl = document.createElement("div");
    inferEl.className = "cookie-inference";
    inferEl.textContent = "⟹ " + (c.inference || "—");

    item.appendChild(nameEl);
    item.appendChild(btn);
    item.appendChild(domEl);
    if (ownerEl) item.appendChild(ownerEl);

    // Script fautif, si le cookie a été posé en JS et qu'on l'a identifié.
    if (c.origin === "js" && c.scriptUrl) {
      const scr = document.createElement("div");
      scr.className = "cookie-script";
      scr.textContent = "↳ posé par " + c.scriptUrl;
      item.appendChild(scr);
    }

    item.appendChild(inferEl);
    item.appendChild(badges);
    elCookieList.appendChild(item);
  }
}


// ── Suppression d'un cookie ────────────────────────────────────────────────
function supprimerCookie(cookie, itemEl, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = "…";

  browser.runtime.sendMessage({ kind: "delete-cookie", cookie: cookie })
    .then(function (res) {
      if (res && res.ok) {
        // Retrait visuel immédiat. Le respawn éventuel sera détecté à la
        // brique suivante ; pour l'instant, on constate la suppression.
        itemEl.style.opacity = ".4";
        btnEl.textContent = "Supprimé";
      } else {
        btnEl.disabled = false;
        btnEl.textContent = "Réessayer";
        afficherErreur("Suppression échouée : " + (res && res.error ? res.error : "raison inconnue"));
      }
    })
    .catch(function (err) {
      btnEl.disabled = false;
      btnEl.textContent = "Réessayer";
      afficherErreur("Suppression impossible : " + (err && err.message ? err.message : err));
    });
}

// ── Interrogation du background ──────────────────────────────────────────────
function refresh() {
  // Cache un éventuel bandeau d'erreur précédent.
  const box = document.getElementById("error");
  if (box) { box.style.display = "none"; box.textContent = ""; }

  elMessage.style.display = "block";
  elMessage.textContent = "Chargement…";
  elSectionSig.style.display = "none";
  elSignalList.innerHTML = "";
  elStatus.textContent = "—";
  elStatus.className = "";

  browser.runtime.sendMessage({ kind: "get-tab-state" })
    .then(function (state) {
      render(state);
    })
    .catch(function (err) {
      afficherErreur("Communication background impossible : " + (err && err.message ? err.message : err));
    });

  chargerCandidats();
  chargerJournal();
}


// ── Journal d'intégrité ─────────────────────────────────────────────────────
function chargerJournal() {
  browser.runtime.sendMessage({ kind: "get-journal" })
    .then(function (res) {
      if (!res) return;
      const n = res.count || 0;
      elJournalInfo.textContent = n + " entrée" + (n !== 1 ? "s" : "");
      if (!res.verify) { elJournalSeal.textContent = "—"; elJournalSeal.className = ""; return; }
      if (res.verify.ok) {
        elJournalSeal.textContent = "✓ chaîne intègre";
        elJournalSeal.className = "ok";
      } else {
        elJournalSeal.textContent = "✕ altérée @ #" + res.verify.brokenAt;
        elJournalSeal.className = "broken";
      }
    })
    .catch(function () {});
}

function exporterJournal() {
  btnExportJournal.disabled = true;
  browser.runtime.sendMessage({ kind: "export-journal" })
    .then(function (res) {
      if (!res || !res.json) { btnExportJournal.disabled = false; return; }
      const stamp = new Date().toISOString().slice(0, 10);
      const blob = new Blob([res.json], { type: "application/json;charset=utf-8" });
      const urlBlob = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = urlBlob;
      a.download = "observatoire_journal_" + stamp + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(urlBlob); }, 2000);
      btnExportJournal.disabled = false;
    })
    .catch(function () { btnExportJournal.disabled = false; });
}


// ── Section candidats à contribution (globale, cumulée entre sessions) ──────
function chargerCandidats() {
  browser.runtime.sendMessage({ kind: "get-candidates" })
    .then(function (res) {
      const cands = (res && res.candidates) || [];
      const seuil = (res && res.seuil) || 2;

      if (cands.length === 0) {
        elSectionCand.style.display = "none";
        return;
      }
      elSectionCand.style.display = "block";
      elCandNote.textContent =
        cands.length + " candidat" + (cands.length > 1 ? "s" : "") +
        " (cookies non catalogués, vus sur ≥ " + seuil + " sites)";

      elCandList.innerHTML = "";
      // On affiche les 8 plus fréquents ; l'export contient tout.
      for (const c of cands.slice(0, 8)) {
        const item = document.createElement("div");
        item.className = "candidate-item";

        const nameEl = document.createElement("div");
        nameEl.className = "candidate-name";
        nameEl.textContent = c.key;

        const freqEl = document.createElement("div");
        freqEl.className = "candidate-freq";
        freqEl.textContent = c.sitesCount + " sites";

        const metaEl = document.createElement("div");
        metaEl.className = "candidate-meta";
        const bits = [];
        if (c.wildcard) bits.push("wildcard");
        if (c.entity) bits.push("entité : " + c.entity);
        if (c.domains && c.domains.length) bits.push(c.domains[0]);
        metaEl.textContent = bits.join(" · ");

        // Actions : Oublier (retire du registre) / Ignorer (écarte définitivement).
        const actions = document.createElement("div");
        actions.className = "candidate-actions";

        const btnOublier = document.createElement("button");
        btnOublier.className = "btn-cand";
        btnOublier.textContent = "Oublier";
        btnOublier.title = "Retire ce candidat du registre (il pourra revenir).";
        btnOublier.addEventListener("click", function () {
          browser.runtime.sendMessage({ kind: "forget-candidate", key: c.key })
            .then(function () { item.remove(); }).catch(function () {});
        });

        const btnIgnorer = document.createElement("button");
        btnIgnorer.className = "btn-cand ignore";
        btnIgnorer.textContent = "Ignorer";
        btnIgnorer.title = "Écarte définitivement ce candidat (ne reviendra plus).";
        btnIgnorer.addEventListener("click", function () {
          browser.runtime.sendMessage({ kind: "ignore-candidate", key: c.key })
            .then(function () { item.remove(); }).catch(function () {});
        });

        actions.appendChild(btnOublier);
        actions.appendChild(btnIgnorer);

        item.appendChild(nameEl);
        item.appendChild(freqEl);
        item.appendChild(metaEl);
        item.appendChild(actions);
        elCandList.appendChild(item);
      }
    })
    .catch(function () { elSectionCand.style.display = "none"; });
}


// ── Export des candidats au format PR (CSV Open Cookie Database) ─────────────
function exporterCandidats() {
  btnExportCand.disabled = true;
  const libelle = btnExportCand.textContent;
  btnExportCand.textContent = "…";

  browser.runtime.sendMessage({ kind: "export-candidates" })
    .then(function (res) {
      if (!res || !res.csv) {
        afficherErreur("Export candidats : réponse vide.");
        btnExportCand.disabled = false;
        btnExportCand.textContent = libelle;
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
      const urlBlob = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = urlBlob;
      a.download = "candidats_open-cookie-database_" + stamp + ".csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(urlBlob); }, 2000);

      btnExportCand.textContent = "Exporté ✓";
      setTimeout(function () {
        btnExportCand.disabled = false;
        btnExportCand.textContent = libelle;
      }, 1500);
    })
    .catch(function (err) {
      afficherErreur("Export candidats impossible : " + (err && err.message ? err.message : err));
      btnExportCand.disabled = false;
      btnExportCand.textContent = libelle;
    });
}

// ── Export Markdown ────────────────────────────────────────────────────────
function exporterMd() {
  btnExport.disabled = true;
  const libelleInitial = btnExport.textContent;
  btnExport.textContent = "…";

  browser.runtime.sendMessage({ kind: "export-md" })
    .then(function (res) {
      if (!res || !res.md) {
        afficherErreur("Export impossible : réponse vide.");
        btnExport.disabled = false;
        btnExport.textContent = libelleInitial;
        return;
      }

      // Nom de fichier : observatoire_<domaine>_<date>.md
      let hote = "page";
      try { hote = new URL(res.url).hostname.replace(/[^a-z0-9.-]/gi, "_"); } catch (e) {}
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const nomFichier = "observatoire_" + hote + "_" + stamp + ".md";

      // Téléchargement via Blob + ancre (aucune permission requise).
      const blob = new Blob([res.md], { type: "text/markdown;charset=utf-8" });
      const urlBlob = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = urlBlob;
      a.download = nomFichier;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Libère l'URL objet après un court délai (le téléchargement est lancé).
      setTimeout(function () { URL.revokeObjectURL(urlBlob); }, 2000);

      btnExport.textContent = "Exporté ✓";
      setTimeout(function () {
        btnExport.disabled = false;
        btnExport.textContent = libelleInitial;
      }, 1500);
    })
    .catch(function (err) {
      afficherErreur("Export impossible : " + (err && err.message ? err.message : err));
      btnExport.disabled = false;
      btnExport.textContent = libelleInitial;
    });
}


// ── Initialisation ────────────────────────────────────────────────────────────
if (btnRefresh) btnRefresh.addEventListener("click", refresh);
if (btnExport)  btnExport.addEventListener("click", exporterMd);
if (btnExportCand) btnExportCand.addEventListener("click", exporterCandidats);
if (btnExportJournal) btnExportJournal.addEventListener("click", exporterJournal);
refresh();
