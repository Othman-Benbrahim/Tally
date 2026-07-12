"use strict";

// ============================================================================
// background.js
// ----------------------------------------------------------------------------
// État par onglet + attribution des cookies + énumération + suppression.
//
// Sources d'attribution des cookies :
//   • HTTP  : en-têtes Set-Cookie captés dans webRequest.onHeadersReceived
//             (observation pure, aucun blocage).
//   • JS    : setter document.cookie intercepté dans hook-page.js, relayé par
//             content-hook.js, avec l'URL du script fautif.
//   • inconnu : cookie présent mais posé avant le chargement de l'extension,
//               ou par un mécanisme non observé (honnête plutôt que deviné).
//
// Aucune donnée ne quitte le navigateur.
// ============================================================================

// tabId -> {
//   url,
//   signals:       Map<signal, { count, frames:Set, detail, firstAt }>,
//   framesSeen:    Set<url>,
//   cookieOrigins: Map<"domaine|nom", { origin:"http"|"js", scriptUrl, at }>,
//   cookieDomains: Set<domaine>   // domaines ayant posé un cookie via HTTP
// }
const perTab = new Map();

function ensureTab(tabId) {
  if (!perTab.has(tabId)) {
    perTab.set(tabId, {
      url: null,
      signals: new Map(),
      framesSeen: new Set(),
      cookieOrigins: new Map(),
      cookieDomains: new Set(),
      connections: new Map(),
      utiqHits: 0
    });
  }
  return perTab.get(tabId);
}

function resetTab(tabId, url) {
  perTab.set(tabId, {
    url: url || null,
    signals: new Map(),
    framesSeen: new Set(),
    cookieOrigins: new Map(),
    cookieDomains: new Set(),
    connections: new Map(),
      utiqHits: 0
  });
}

// Renvoie le hostname d'une URL, ou null.
function hoteDe(url) {
  try { return new URL(url).hostname; } catch (e) { return null; }
}

// Enlève un éventuel point initial du domaine d'un cookie (".exemple.com").
function domaineNu(d) {
  return d && d[0] === "." ? d.slice(1) : d;
}


// ── Catégorisation via le référentiel Disconnect (reference-db.js) ────────────
// On cherche le domaine exact puis ses domaines parents (stats.g.doubleclick.net
// -> doubleclick.net), car la base indexe le domaine racine de l'entité.
function categoriser(domaineCookie) {
  const db = self.REFERENCE_DB || {};
  const d = domaineNu(domaineCookie).toLowerCase();
  const parts = d.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidat = parts.slice(i).join(".");
    const hit = db[candidat];
    if (hit) return { owner: hit[0], category: hit[1] };
  }
  return { owner: null, category: "inconnu" };
}


// ── Couche NOM : Open Cookie Database (cookie-names-db.js) ────────────────────
// Consultée AVANT la couche domaine, car plus précise (elle qualifie le cookie
// lui-même, pas seulement le domaine qui l'héberge).
function lookupNom(name) {
  const db = self.COOKIE_NAMES_DB;
  if (!db || !name) return null;
  if (db.exact[name]) {
    const e = db.exact[name];
    return { category: e[0], platform: e[1], retention: e[2], controller: e[3], description: e[4], match: "exact" };
  }
  for (const w of db.wildcard) {
    if (name.startsWith(w[0])) {
      return { category: w[1], platform: w[2], retention: w[3], controller: w[4], description: w[5], match: "wildcard:" + w[0] };
    }
  }
  return null;
}

// Cascade complète : nom -> domaine -> inconnu.
function categoriserCookie(name, domaineCookie) {
  const parNom = lookupNom(name);
  const parDom = categoriser(domaineCookie);
  if (parNom) {
    return {
      category: parNom.category,
      owner: parNom.platform || parDom.owner || null,
      source: "opencookie",
      catalogued: true,
      description: parNom.description || null,
      retention: parNom.retention || null,
      match: parNom.match
    };
  }
  if (parDom.category !== "inconnu") {
    return {
      category: parDom.category, owner: parDom.owner, source: "disconnect",
      catalogued: false, description: null, retention: null, match: null
    };
  }
  return {
    category: "inconnu", owner: parDom.owner || null, source: null,
    catalogued: false, description: null, retention: null, match: null
  };
}


// ============================================================================
// REGISTRE DE CANDIDATS À CONTRIBUTION
// ----------------------------------------------------------------------------
// Accumule, entre les sessions, les cookies dont le NOM est absent de l'Open
// Cookie Database. Deux filtres avant qu'un candidat soit proposé :
//   1. Fréquence trans-sites : vu sur >= SEUIL_SITES domaines de pages distincts.
//   2. Filtre identifiant unique : les noms ressemblant à des jetons par
//      utilisateur (UUID, hex long) sont rejetés dès la saisie.
// On ne stocke JAMAIS la valeur d'un cookie — seulement nom, domaines, sites.
// ============================================================================

const SEUIL_SITES = 2;
const REGISTRE_MAX = 6000;

const registre = new Map();
let registreSale = false;

function looksLikeUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function normaliserNom(name) {
  if (!name || name.length > 120) return null;
  if (looksLikeUUID(name)) return null;
  if (/^[0-9a-f]{16,}$/i.test(name)) return null;
  if (/^[A-Za-z0-9+/=_-]{28,}$/.test(name) && !/[_.\-]/.test(name.slice(2, -6))) return null;
  const m = name.match(/^([A-Za-z_][A-Za-z0-9_.\-]*?[_.\-])([0-9A-Fa-f]{6,}|[0-9]{5,}|[A-Za-z0-9]{10,})$/);
  if (m && m[1].length >= 2) return { key: m[1] + "*", wildcard: true };
  return { key: name, wildcard: false };
}

function noterCandidat(name, domaineCookie, pageHost) {
  if (!name) return;
  if (lookupNom(name)) return;
  const norm = normaliserNom(name);
  if (!norm) return;
  if (candidatsIgnores.has(norm.key)) return;   // définitivement écarté par l'utilisateur

  const dom = categoriser(domaineCookie);
  let e = registre.get(norm.key);
  if (!e) {
    if (registre.size >= REGISTRE_MAX) elaguerRegistre();
    e = {
      wildcard: norm.wildcard, sites: new Set(), domains: new Set(),
      entity: dom.owner || null, category: dom.category,
      exemples: new Set(), firstSeen: Date.now()
    };
    registre.set(norm.key, e);
  }
  if (pageHost) e.sites.add(pageHost);
  const dNu = domaineNu(domaineCookie);
  if (dNu) e.domains.add(dNu);
  if (norm.wildcard && e.exemples.size < 5) e.exemples.add(name);
  if (!e.entity && dom.owner) e.entity = dom.owner;
  registreSale = true;
}

function elaguerRegistre() {
  for (const [k, e] of registre) {
    if (e.sites.size < SEUIL_SITES) registre.delete(k);
    if (registre.size < REGISTRE_MAX) break;
  }
}

function serialiserRegistre() {
  const obj = {};
  for (const [k, e] of registre) {
    obj[k] = {
      w: e.wildcard ? 1 : 0, s: Array.from(e.sites), d: Array.from(e.domains),
      e: e.entity, c: e.category, x: Array.from(e.exemples), f: e.firstSeen
    };
  }
  return obj;
}

function rehydraterRegistre(obj) {
  registre.clear();
  for (const k in obj) {
    const o = obj[k];
    registre.set(k, {
      wildcard: !!o.w, sites: new Set(o.s || []), domains: new Set(o.d || []),
      entity: o.e || null, category: o.c || "inconnu",
      exemples: new Set(o.x || []), firstSeen: o.f || Date.now()
    });
  }
}

async function chargerRegistre() {
  try {
    const r = await browser.storage.local.get("registreCandidats");
    if (r && r.registreCandidats) rehydraterRegistre(r.registreCandidats);
  } catch (e) {}
}

async function flushRegistre() {
  if (!registreSale) return;
  registreSale = false;
  try {
    await browser.storage.local.set({ registreCandidats: serialiserRegistre() });
  } catch (e) { registreSale = true; }
}

setInterval(flushRegistre, 20000);

function candidatsFiltres() {
  const out = [];
  for (const [k, e] of registre) {
    if (e.sites.size < SEUIL_SITES) continue;
    out.push({
      key: k, wildcard: e.wildcard, sitesCount: e.sites.size,
      domains: Array.from(e.domains).slice(0, 5), entity: e.entity,
      category: e.category, exemples: Array.from(e.exemples), firstSeen: e.firstSeen
    });
  }
  out.sort(function (a, b) { return b.sitesCount - a.sitesCount; });
  return out;
}

chargerRegistre();


// ============================================================================
// BRIQUE 3 — RESPAWN & BLOCAGE  |  BRIQUE 4 — CONNEXIONS TIERCES
// ----------------------------------------------------------------------------
// deletedLedger : cookies que TU as supprimés (clé domaineNu|nom -> deletedAt).
//                 Sert à repérer une réapparition (respawn).
// respawnEvents : cookies revenus après suppression, avec le "réanimateur"
//                 (script JS ou domaine HTTP) et le site où c'est arrivé.
// blocklist     : par site, ensemble de motifs à bloquer (scripts/domaines).
//                 C'est l'extincteur : sans lui, détecter le respawn ne sert à rien.
// Tout persiste dans storage.local. Jamais aucune valeur de cookie.
// ============================================================================

const deletedLedger = new Map();   // "domaineNu|nom" -> { name, domain, at }
const respawnEvents = new Map();   // "domaineNu|nom" -> { name, domain, pageHost, count, firstAt, lastAt, revivers:Set, reviverType }
const blocklist     = new Map();   // siteHost -> Set(motif)   motif = "url:<prefixe>" | "host:<domaine>"
let persistSale = false;

function marquerPersist() { persistSale = true; }

function serialiserMap(m, fn) {
  const o = {};
  for (const [k, v] of m) o[k] = fn(v);
  return o;
}

async function chargerEtatPersistant() {
  try {
    const r = await browser.storage.local.get(["deletedLedger", "respawnEvents", "blocklist", "candidatsIgnores", "blocUtiq", "utiqSites"]);
    if (r.deletedLedger) {
      for (const k in r.deletedLedger) deletedLedger.set(k, r.deletedLedger[k]);
    }
    if (r.respawnEvents) {
      for (const k in r.respawnEvents) {
        const o = r.respawnEvents[k];
        respawnEvents.set(k, {
          name: o.name, domain: o.domain, pageHost: o.pageHost,
          count: o.count, firstAt: o.firstAt, lastAt: o.lastAt,
          revivers: new Set(o.revivers || []), reviverType: o.reviverType
        });
      }
    }
    if (r.blocklist) {
      for (const k in r.blocklist) blocklist.set(k, new Set(r.blocklist[k]));
    }
    if (Array.isArray(r.candidatsIgnores)) {
      r.candidatsIgnores.forEach(function (k) { candidatsIgnores.add(k); });
    }
    // Défaut : protection Utiq activée si jamais réglée.
    blocUtiq = (r.blocUtiq === undefined) ? true : !!r.blocUtiq;
    if (Array.isArray(r.utiqSites)) {
      r.utiqSites.forEach(function (s) { utiqSites.add(s); });
    }
  } catch (e) {}
}

async function flushEtatPersistant() {
  if (!persistSale) return;
  persistSale = false;
  try {
    await browser.storage.local.set({
      deletedLedger: serialiserMap(deletedLedger, function (v) { return v; }),
      respawnEvents: serialiserMap(respawnEvents, function (v) {
        return {
          name: v.name, domain: v.domain, pageHost: v.pageHost,
          count: v.count, firstAt: v.firstAt, lastAt: v.lastAt,
          revivers: Array.from(v.revivers), reviverType: v.reviverType
        };
      }),
      blocklist: serialiserMap(blocklist, function (s) { return Array.from(s); }),
      candidatsIgnores: Array.from(candidatsIgnores),
      blocUtiq: blocUtiq,
      utiqSites: Array.from(utiqSites)
    });
  } catch (e) { persistSale = true; }
}

setInterval(flushEtatPersistant, 20000);
chargerEtatPersistant();


// Compare deux hôtes de façon approximative (2 derniers labels ~ eTLD+1).
// Sans liste de suffixes publics, c'est imparfait pour .co.uk mais suffisant
// pour distinguer tierce vs première partie en observation.
function memeSiteApprox(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = a.split("."), pb = b.split(".");
  const ra = pa.slice(-2).join("."), rb = pb.slice(-2).join(".");
  return ra === rb;
}

// Enregistre une suppression de cookie (appelé depuis supprimerCookie).
function noterSuppression(name, domain) {
  const cle = domaineNu(domain) + "|" + name;
  deletedLedger.set(cle, { name: name, domain: domaineNu(domain), at: Date.now() });
  marquerPersist();
  journaliser("cookie-supprime", { name: name, domain: domaineNu(domain) });
}

// Vérifie si un cookie qu'on vient de voir posé correspond à une suppression
// antérieure -> respawn. reviver = { type:"js"|"http", ref:<script|domaine> }.
function verifierRespawn(name, cookieDomain, pageHost, reviver) {
  const cle = domaineNu(cookieDomain) + "|" + name;
  const del = deletedLedger.get(cle);
  if (!del) return;
  if (Date.now() <= del.at) return;   // posé avant/à la suppression : pas un respawn

  let e = respawnEvents.get(cle);
  if (!e) {
    e = {
      name: name, domain: domaineNu(cookieDomain), pageHost: pageHost || null,
      count: 0, firstAt: Date.now(), lastAt: 0,
      revivers: new Set(), reviverType: reviver ? reviver.type : null
    };
    respawnEvents.set(cle, e);
    journaliser("respawn-detecte", {
      name: name, domain: domaineNu(cookieDomain), pageHost: pageHost || null,
      reviver: reviver ? (reviver.type + ":" + (reviver.ref || "?")) : null
    });
  }
  e.count += 1;
  e.lastAt = Date.now();
  if (pageHost) e.pageHost = pageHost;
  if (reviver && reviver.ref) {
    e.revivers.add(reviver.type + ":" + reviver.ref);
    e.reviverType = reviver.type;
  }
  marquerPersist();
}

// Un motif de blocage correspond-il à cette URL ?
function motifCorrespond(motif, url, host) {
  if (motif.indexOf("url:") === 0) return url.indexOf(motif.slice(4)) === 0;
  if (motif.indexOf("host:") === 0) {
    const h = motif.slice(5);
    return host === h || host.endsWith("." + h);
  }
  return false;
}


// ============================================================================
// PISTAGE RÉSEAU — Utiq / TrustPid (blocage intégré, activable)
// ----------------------------------------------------------------------------
// Utiq (ex-TrustPid) est un traceur opéré par les opérateurs télécom : un
// identifiant persistant établi au niveau réseau. Contrairement à un domaine
// tiers quelconque, c'est un acteur NOMMÉ, sans fonction légitime — le bloquer
// ne casse aucun site. On le traite comme une règle intégrée, pas comme une
// liste globale de type uBlock.
//
// Trois vecteurs couverts :
//   1. Domaines Utiq directs (utiq.com, utiqcontent.com, trustpid.com, …).
//   2. Le script chargeur, où qu'il soit hébergé (…/utiqLoader.js), y compris
//      en first-party (ex. tmi.orange.fr/utiqLoader.js).
//   3. CNAME cloaking : un sous-domaine first-party qui pointe (CNAME) vers
//      l'infra Utiq. Démasqué via browser.dns, uniquement pour les sous-domaines
//      du site visité (là où le cloaking se cache) — pour ne pas tout résoudre.
// ============================================================================

const UTIQ_DOMAINES = [
  "utiq.com", "utiq.fr", "utiq.de", "utiq.es", "utiq.it",
  "utiqcontent.com", "trustpid.com"
];
let blocUtiq = true;                 // activé par défaut (aucun risque de casse)
const utiqCloaked = new Set();       // hôtes first-party démasqués (CNAME -> Utiq)
const cnameVus = new Set();          // cache des hôtes déjà résolus
const utiqSites = new Set();         // sites (hôtes de page) où Utiq a été détecté

function hostEstUtiq(h) {
  if (!h) return false;
  h = h.toLowerCase();
  return UTIQ_DOMAINES.some(function (d) { return h === d || h.endsWith("." + d); });
}
function urlEstLoaderUtiq(u) {
  return /utiqloader\.js/i.test(u || "");
}

// Démasquage CNAME hors-bande : ne bloque pas la requête courante, mais si
// l'hôte pointe vers Utiq, les requêtes SUIVANTES vers cet hôte seront bloquées.
function verifierCnameUtiq(host) {
  if (cnameVus.has(host)) return;
  cnameVus.add(host);
  if (!browser.dns || !browser.dns.resolve) return;
  browser.dns.resolve(host, ["canonical_name"]).then(function (res) {
    const cn = res && res.canonicalName ? res.canonicalName.toLowerCase() : "";
    if (cn && hostEstUtiq(cn)) {
      utiqCloaked.add(host);
      journaliser("utiq-cname-demasque", { host: host, canonical: cn });
    }
  }).catch(function () {});
}

// Décision de blocage Utiq pour une requête. Renvoie true si la requête doit
// être annulée.
function bloquerRequeteUtiq(details, reqHost, pageHost) {
  const estUtiq = hostEstUtiq(reqHost) || utiqCloaked.has(reqHost) || urlEstLoaderUtiq(details.url);

  if (estUtiq) {
    // DÉTECTION (indépendante du blocage) : on mémorise que ce site utilise
    // Utiq, pour l'afficher — y compris d'emblée aux visites suivantes.
    if (pageHost && !utiqSites.has(pageHost)) {
      utiqSites.add(pageHost);
      marquerPersist();
      journaliser("utiq-site-detecte", { site: pageHost, via: reqHost });
    }
    // BLOCAGE (seulement si activé).
    if (blocUtiq) {
      const rec = ensureTab(details.tabId);
      rec.utiqHits = (rec.utiqHits || 0) + 1;
      return true;
    }
    return false;
  }

  // Démasquage CNAME, uniquement pour un sous-domaine du site visité (le vecteur
  // de cloaking) — pas pour tous les tiers. Alimente aussi la détection.
  if (pageHost && reqHost !== pageHost && memeSiteApprox(reqHost, pageHost)) {
    verifierCnameUtiq(reqHost);
  }
  return false;
}


// ============================================================================
// BRIQUE 5 — JOURNAL CHAÎNÉ SHA-256 (local, infalsifiable en interne)
// ----------------------------------------------------------------------------
// Chaque événement (suppression, respawn, blocage, déblocage, candidat ignoré)
// est scellé au précédent par un hachage SHA-256. Modifier une entrée passée
// casse toute la chaîne à partir d'elle -> détectable par verifierJournal().
//
// LIMITE HONNÊTE : la chaîne prouve la cohérence interne, PAS la date réelle.
// Pour un horodatage opposable, il faudrait ancrer périodiquement la tête de
// chaîne dans une source publique (commit git, OpenTimestamps). Non fait ici.
//
// Aucune valeur de cookie n'est jamais journalisée.
// ============================================================================

const GENESIS = "0".repeat(64);
let journal = [];
let journalHead = GENESIS;
let appendLock = Promise.resolve();

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function payloadEntree(seq, at, type, data, prevHash) {
  return seq + "|" + at + "|" + type + "|" + JSON.stringify(data) + "|" + prevHash;
}

// Ajoute une entrée. Sérialisé via appendLock pour que prevHash reste cohérent
// même si plusieurs événements arrivent quasi simultanément.
function journaliser(type, data) {
  appendLock = appendLock.then(async function () {
    const seq = journal.length;
    const at = Date.now();
    const prevHash = journalHead;
    const hash = await sha256Hex(payloadEntree(seq, at, type, data, prevHash));
    journal.push({ seq: seq, at: at, type: type, data: data, prevHash: prevHash, hash: hash });
    journalHead = hash;
    try {
      await browser.storage.local.set({ journal: journal, journalHead: journalHead });
    } catch (e) {}
  }).catch(function () {});
  return appendLock;
}

async function chargerJournal() {
  try {
    const r = await browser.storage.local.get(["journal", "journalHead"]);
    if (Array.isArray(r.journal)) journal = r.journal;
    if (r.journalHead) journalHead = r.journalHead;
    else if (journal.length) journalHead = journal[journal.length - 1].hash;
  } catch (e) {}
}

// Recalcule toute la chaîne et signale la première entrée altérée, s'il y en a.
async function verifierJournal() {
  let prev = GENESIS;
  for (let i = 0; i < journal.length; i++) {
    const e = journal[i];
    const h = await sha256Hex(payloadEntree(e.seq, e.at, e.type, e.data, prev));
    if (e.prevHash !== prev || e.hash !== h) return { ok: false, brokenAt: i, count: journal.length };
    prev = e.hash;
  }
  return { ok: true, count: journal.length, head: journalHead };
}

chargerJournal();


// ── Liste d'ignorés (candidats définitivement écartés) ───────────────────────
// Un candidat "ignoré" ne réapparaîtra plus dans le registre (voir noterCandidat).
const candidatsIgnores = new Set();


// ── Durée de vie observée du cookie ──────────────────────────────────────────
function dureeCookie(c) {
  if (c.session) return { label: "session", jours: 0, longue: false };
  if (!c.expirationDate) return { label: "?", jours: null, longue: false };
  const jours = Math.round((c.expirationDate * 1000 - Date.now()) / 86400000);
  let label;
  if (jours < 1)        label = "< 1 j";
  else if (jours < 60)  label = jours + " j";
  else if (jours < 365) label = Math.round(jours / 30) + " mois";
  else                  label = (jours / 365).toFixed(1) + " ans";
  return { label: label, jours: jours, longue: jours >= 365 };
}


// ── Inférence de comportement ────────────────────────────────────────────────
// IMPORTANT : c'est une INFÉRENCE, pas un verdict. Elle est dérivée de la
// catégorie sourcée (Disconnect) et de signaux observables (partie, durée).
// Elle ne prétend jamais lire l'intention réelle du cookie.
function inferer(party, category, duree) {
  let base;
  switch (category) {
    case "advertising":   base = "Traceur publicitaire"; break;
    case "analytics":     base = "Mesure d'audience"; break;
    case "social":        base = "Traceur réseau social"; break;
    case "fingerprinting":base = "Entité de fingerprinting"; break;
    case "cryptomining":  base = "Minage crypto"; break;
    case "email":         base = "Traceur e-mail"; break;
    case "content":       base = "Contenu tiers"; break;
    case "antifraud":     base = "Anti-fraude"; break;
    case "consent":       base = "Gestion du consentement"; break;
    default:
      base = (party === "tierce") ? "Tierce partie non catégorisée" : "Première partie";
  }
  const persist = (duree && duree.longue) ? " · persistance longue" : "";
  const src     = (category !== "inconnu") ? " (réf. Disconnect)" : "";
  return base + persist + src;
}


// ── Capture des cookies posés par en-tête HTTP Set-Cookie ────────────────────
// onHeadersReceived est purement observationnel ici : on lit les en-têtes de
// réponse sans jamais les modifier ni bloquer la requête.
browser.webRequest.onHeadersReceived.addListener(
  function (details) {
    if (details.tabId < 0 || !details.responseHeaders) return;

    const setCookies = details.responseHeaders.filter(function (h) {
      return h.name.toLowerCase() === "set-cookie";
    });
    if (setCookies.length === 0) return;

    const rec = ensureTab(details.tabId);
    const domaine = hoteDe(details.url);
    if (!domaine) return;

    // Hôte de la page (site visité) pour la fréquence trans-sites du registre.
    const pageHost = hoteDe(tabUrls.get(details.tabId) || (rec && rec.url));

    for (const h of setCookies) {
      // La valeur d'un en-tête Set-Cookie peut contenir plusieurs cookies
      // séparés par des retours à la ligne (Firefox les regroupe parfois).
      const morceaux = String(h.value).split("\n");
      for (const brut of morceaux) {
        const nom = brut.split("=")[0].trim();
        if (!nom) continue;
        const cle = domaine + "|" + nom;
        if (!rec.cookieOrigins.has(cle)) {
          rec.cookieOrigins.set(cle, { origin: "http", scriptUrl: null, at: Date.now() });
        }
        noterCandidat(nom, domaine, pageHost);
        verifierRespawn(nom, domaine, pageHost, { type: "http", ref: domaine });
      }
      rec.cookieDomains.add(domaine);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);


// ── Connexions tierces (brique 4) + application du blocage (brique 3) ─────────
// onBeforeRequest est ici BLOQUANT : il observe chaque requête ET annule celles
// qui correspondent à un motif bloqué pour le site courant. On voit la requête
// même si uBlock l'annule aussi (les listeners bloquants sont tous appelés).
browser.webRequest.onBeforeRequest.addListener(
  function (details) {
    if (details.tabId < 0) return {};
    const reqHost = hoteDe(details.url);
    if (!reqHost) return {};

    // Hôte de la page à l'origine de la requête.
    const pageHost = hoteDe(details.documentUrl) || hoteDe(details.originUrl)
                   || hoteDe(tabUrls.get(details.tabId));

    // 0) Pistage réseau Utiq (règle intégrée, prioritaire).
    if (bloquerRequeteUtiq(details, reqHost, pageHost)) {
      return { cancel: true };
    }

    // 1) Application du blocage pour ce site.
    if (pageHost && blocklist.has(pageHost)) {
      for (const motif of blocklist.get(pageHost)) {
        if (motifCorrespond(motif, details.url, reqHost)) {
          const rec0 = ensureTab(details.tabId);
          const cx0 = rec0.connections.get(reqHost);
          if (cx0) cx0.blockedByUs += 1;
          return { cancel: true };
        }
      }
    }

    // 2) Observation des connexions tierces uniquement.
    if (pageHost && !memeSiteApprox(reqHost, pageHost)) {
      const rec = ensureTab(details.tabId);
      let cx = rec.connections.get(reqHost);
      if (!cx) {
        const cat = categoriser(reqHost);
        cx = { types: new Set(), count: 0, completed: 0, failed: 0, blockedByUs: 0,
               category: cat.category, owner: cat.owner };
        rec.connections.set(reqHost, cx);
      }
      cx.count += 1;
      cx.types.add(details.type);
    }
    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

// Issues des requêtes (complétées / échouées ou bloquées par un tiers).
browser.webRequest.onCompleted.addListener(function (details) {
  if (details.tabId < 0) return;
  const rec = perTab.get(details.tabId);
  if (!rec) return;
  const h = hoteDe(details.url);
  const cx = h && rec.connections.get(h);
  if (cx) cx.completed += 1;
}, { urls: ["<all_urls>"] });

browser.webRequest.onErrorOccurred.addListener(function (details) {
  if (details.tabId < 0) return;
  const rec = perTab.get(details.tabId);
  if (!rec) return;
  const h = hoteDe(details.url);
  const cx = h && rec.connections.get(h);
  if (cx) cx.failed += 1;   // échec réseau OU annulation par un autre bloqueur (ex. uBlock)
}, { urls: ["<all_urls>"] });


// ── Écouteur de messages unique ──────────────────────────────────────────────
browser.runtime.onMessage.addListener(function (msg, sender) {

  // ── Requêtes venant du popup (pas de sender.tab) ─────────────────────────
  if (msg.kind === "get-tab-state") {
    return construireEtatOnglet();
  }
  if (msg.kind === "get-candidates") {
    return Promise.resolve({ candidates: candidatsFiltres(), seuil: SEUIL_SITES });
  }
  if (msg.kind === "export-candidates") {
    return Promise.resolve({ csv: construireCsvCandidats(candidatsFiltres()) });
  }
  if (msg.kind === "reset-candidates") {
    registre.clear();
    registreSale = true;
    return flushRegistre().then(function () { return { ok: true }; });
  }
  if (msg.kind === "set-utiq") {
    blocUtiq = !!msg.value;
    marquerPersist();
    journaliser("utiq-protection", { active: blocUtiq });
    return Promise.resolve({ ok: true, blocUtiq: blocUtiq });
  }
  if (msg.kind === "delete-cookie") {
    return supprimerCookie(msg.cookie);
  }
  if (msg.kind === "block-source") {
    if (msg.site && msg.pattern) {
      if (!blocklist.has(msg.site)) blocklist.set(msg.site, new Set());
      blocklist.get(msg.site).add(msg.pattern);
      marquerPersist();
      journaliser("source-bloquee", { site: msg.site, pattern: msg.pattern });
    }
    return Promise.resolve({ ok: true });
  }
  if (msg.kind === "unblock-source") {
    if (msg.site && msg.pattern && blocklist.has(msg.site)) {
      blocklist.get(msg.site).delete(msg.pattern);
      if (blocklist.get(msg.site).size === 0) blocklist.delete(msg.site);
      marquerPersist();
      journaliser("source-debloquee", { site: msg.site, pattern: msg.pattern });
    }
    return Promise.resolve({ ok: true });
  }
  if (msg.kind === "forget-candidate") {
    registre.delete(msg.key);
    registreSale = true;
    return Promise.resolve({ ok: true });
  }
  if (msg.kind === "ignore-candidate") {
    candidatsIgnores.add(msg.key);
    registre.delete(msg.key);
    registreSale = true;
    marquerPersist();
    journaliser("candidat-ignore", { key: msg.key });
    return Promise.resolve({ ok: true });
  }
  if (msg.kind === "get-journal") {
    return verifierJournal().then(function (v) {
      return { count: journal.length, head: journalHead, verify: v };
    });
  }
  if (msg.kind === "export-journal") {
    return Promise.resolve({
      json: JSON.stringify({ head: journalHead, entries: journal }, null, 2)
    });
  }
  if (msg.kind === "export-md") {
    return construireEtatOnglet().then(function (state) {
      return { md: construireMarkdown(state), url: state.url };
    });
  }

  // ── Messages venant des content scripts (sender.tab présent) ─────────────
  if (!sender || !sender.tab) return;
  const tabId = sender.tab.id;
  const rec = ensureTab(tabId);
  rec.url = sender.tab.url || rec.url;

  if (msg.kind === "probe-installed") {
    rec.framesSeen.add(msg.frameUrl);
    return;
  }

  if (msg.kind === "fingerprint-signal") {
    let s = rec.signals.get(msg.signal);
    if (!s) {
      s = { count: 0, frames: new Set(), detail: msg.detail, firstAt: msg.at };
      rec.signals.set(msg.signal, s);
    }
    s.count += 1;
    s.frames.add(msg.frameUrl);
    return;
  }

  if (msg.kind === "cookie-set") {
    // Cookie posé via document.cookie : domaine = hôte du cadre émetteur.
    const domaine = hoteDe(sender.url) || hoteDe(sender.tab.url);
    if (domaine && msg.name) {
      const cle = domaine + "|" + msg.name;
      // Le JS a priorité d'attribution : s'il a posé le cookie, on note le
      // script, même si un en-tête HTTP l'avait déjà enregistré.
      rec.cookieOrigins.set(cle, {
        origin: "js",
        scriptUrl: msg.scriptUrl || null,
        at: msg.at || Date.now()
      });
      const pageHost = hoteDe(sender.tab.url) || hoteDe(tabUrls.get(sender.tab.id));
      noterCandidat(msg.name, domaine, pageHost);
      verifierRespawn(msg.name, domaine, pageHost, { type: "js", ref: msg.scriptUrl || null });
    }
    return;
  }
});


// ── Construction de l'état complet de l'onglet actif ─────────────────────────
async function construireEtatOnglet() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return { error: "Aucun onglet actif." };

  const rec = perTab.get(tab.id);
  const hotePage = hoteDe(tab.url);

  // ── Signaux de fingerprinting ──────────────────────────────────────────
  const signals = [];
  if (rec) {
    for (const [signal, s] of rec.signals) {
      signals.push({
        signal: signal,
        detail: s.detail || null,
        count: s.count,
        frames: Array.from(s.frames),
        firstAt: s.firstAt
      });
    }
  }

  // ── Cookies : on interroge le domaine de la page + tous les domaines
  //    tiers ayant posé un cookie via HTTP pendant la navigation. ──────────
  const domaines = new Set();
  if (hotePage) domaines.add(hotePage);
  if (rec) for (const d of rec.cookieDomains) domaines.add(d);

  const requetes = Array.from(domaines).map(function (d) {
    return browser.cookies.getAll({ domain: d }).catch(function () { return []; });
  });
  const paquets = await Promise.all(requetes);

  // Déduplication par (domaine|nom|chemin).
  const vus = new Set();
  const cookies = [];
  for (const paquet of paquets) {
    for (const c of paquet) {
      const cleUnique = c.domain + "|" + c.name + "|" + c.path;
      if (vus.has(cleUnique)) continue;
      vus.add(cleUnique);

      // Attribution : on cherche l'origine observée pour ce cookie.
      const dNu = domaineNu(c.domain);
      let origine = "inconnu";
      let scriptUrl = null;
      if (rec) {
        const infos =
          rec.cookieOrigins.get(c.domain + "|" + c.name) ||
          rec.cookieOrigins.get(dNu + "|" + c.name);
        if (infos) {
          origine = infos.origin;      // "http" ou "js"
          scriptUrl = infos.scriptUrl; // URL du script si JS
        }
      }

      // Première ou tierce partie, par rapport à la page visitée.
      let partie = "inconnu";
      if (hotePage) {
        partie = (dNu === hotePage || hotePage.endsWith("." + dNu)) ? "premiere" : "tierce";
      }

      // Cascade complète (nom -> domaine) + durée observée + inférence.
      const cat   = categoriserCookie(c.name, c.domain);
      const duree = dureeCookie(c);
      const infer = inferer(partie, cat.category, duree);

      // Alimente le registre de candidats (le filtre "déjà catalogué" et le
      // filtre identifiant unique sont appliqués dans noterCandidat).
      noterCandidat(c.name, c.domain, hotePage);

      cookies.push({
        name: c.name,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        session: c.session,
        storeId: c.storeId,
        origin: origine,
        scriptUrl: scriptUrl,
        party: partie,
        owner: cat.owner,
        category: cat.category,
        source: cat.source,          // "opencookie" | "disconnect" | null
        catalogued: cat.catalogued,  // présent dans l'Open Cookie Database ?
        description: cat.description,
        duration: duree.label,
        durationLong: duree.longue,
        inference: infer
      });
    }
  }

  // Tri : tierces parties d'abord (les plus intéressantes), puis par domaine.
  cookies.sort(function (a, b) {
    if (a.party !== b.party) return a.party === "tierce" ? -1 : 1;
    return a.domain.localeCompare(b.domain);
  });

  // ── Connexions tierces (brique 4) ──────────────────────────────────────
  const connexions = [];
  if (rec && rec.connections) {
    for (const [host, cx] of rec.connections) {
      connexions.push({
        host: host, count: cx.count,
        types: Array.from(cx.types),
        completed: cx.completed, failed: cx.failed, blockedByUs: cx.blockedByUs,
        category: cx.category, owner: cx.owner
      });
    }
    connexions.sort(function (a, b) { return b.count - a.count; });
  }

  // ── Respawns (brique 3) liés à cette page ──────────────────────────────
  const respawns = [];
  for (const [cle, e] of respawnEvents) {
    if (hotePage && e.pageHost && !memeSiteApprox(e.pageHost, hotePage)) continue;
    respawns.push({
      name: e.name, domain: e.domain, pageHost: e.pageHost,
      count: e.count, lastAt: e.lastAt, reviverType: e.reviverType,
      revivers: Array.from(e.revivers)
    });
  }
  respawns.sort(function (a, b) { return b.lastAt - a.lastAt; });

  // ── Sources bloquées pour ce site ──────────────────────────────────────
  const blocs = (hotePage && blocklist.has(hotePage))
    ? Array.from(blocklist.get(hotePage)) : [];

  return {
    url: (rec && rec.url) || tab.url,
    pageHost: hotePage,
    framesSeen: rec ? rec.framesSeen.size : 0,
    signals: signals,
    cookies: cookies,
    connexions: connexions,
    respawns: respawns,
    blocs: blocs,
    utiqHits: rec ? (rec.utiqHits || 0) : 0,
    blocUtiq: blocUtiq,
    utiqSite: !!(hotePage && utiqSites.has(hotePage))
  };
}


// ── Construction du rapport Markdown (format Obsidian) ───────────────────────
// Frontmatter YAML + tables. Les listes 'categories' et 'entites' servent au
// mappage trans-sites dans le graphe Obsidian : deux pages partageant une
// entité ou une catégorie se relient. La ligne de hashtags renforce ce liage.
function construireMarkdown(state) {
  const cookies = state.cookies || [];
  const signals = state.signals || [];
  const url = state.url || "";
  let hote = "";
  try { hote = new URL(url).hostname; } catch (e) { hote = url; }
  const dateISO = new Date().toISOString();

  const tierces  = cookies.filter(function (c) { return c.party === "tierce"; });
  const premieres = cookies.filter(function (c) { return c.party !== "tierce"; });

  // Agrégats pour le frontmatter.
  const categories = Array.from(new Set(cookies
    .map(function (c) { return c.category; })
    .filter(function (x) { return x && x !== "inconnu"; })));
  const entites = Array.from(new Set(cookies
    .map(function (c) { return c.owner; })
    .filter(Boolean)));
  const fpSignals = signals.map(function (s) { return s.signal; });

  // Échappe le caractère | pour ne pas casser les tables Markdown.
  function esc(v) { return String(v == null ? "" : v).replace(/\|/g, "\\|"); }

  // Une ligne de table pour un cookie.
  function ligne(c) {
    return "| " + [
      esc(c.name),
      esc(c.domain),
      esc(c.owner || "—"),
      esc(c.category),
      esc(c.origin),
      esc(c.duration),
      esc(c.inference)
    ].join(" | ") + " |";
  }

  const enteteTable =
    "| Cookie | Domaine | Entité | Catégorie | Origine | Durée | Inférence |\n" +
    "|---|---|---|---|---|---|---|";

  // Hashtags Obsidian sûrs (catégories seulement — mots simples).
  const hashtags = categories.map(function (c) { return "#cookies/" + c; }).join(" ");

  let md = "";
  md += "---\n";
  md += "type: observation-cookies\n";
  md += "url: " + url + "\n";
  md += "domaine: " + hote + "\n";
  md += "date: " + dateISO + "\n";
  md += "cookies_total: " + cookies.length + "\n";
  md += "cookies_tierces: " + tierces.length + "\n";
  md += "categories: [" + categories.join(", ") + "]\n";
  md += "entites: [" + entites.map(function (e) { return '"' + e.replace(/"/g, "") + '"'; }).join(", ") + "]\n";
  md += "fingerprint: [" + fpSignals.join(", ") + "]\n";
  md += "source_referentiel: Disconnect services.json (GPL-3.0)\n";
  md += "---\n\n";

  md += "# Observation — " + hote + "\n\n";
  if (hashtags) md += hashtags + "\n\n";

  // Empreinte
  md += "## Empreinte (fingerprinting)\n\n";
  if (signals.length === 0) {
    md += "_Aucun signal détecté._\n\n";
  } else {
    for (const s of signals) {
      md += "- `" + s.signal + "`" + (s.detail ? " (" + s.detail + ")" : "") +
            " — " + s.count + " appel(s)\n";
    }
    md += "\n";
  }

  // Cookies tierces parties (les plus significatifs)
  md += "## Cookies — tierces parties (" + tierces.length + ")\n\n";
  if (tierces.length === 0) {
    md += "_Aucun._\n\n";
  } else {
    md += enteteTable + "\n";
    for (const c of tierces) md += ligne(c) + "\n";
    md += "\n";
  }

  // Cookies première partie
  md += "## Cookies — première partie (" + premieres.length + ")\n\n";
  if (premieres.length === 0) {
    md += "_Aucun._\n\n";
  } else {
    md += enteteTable + "\n";
    for (const c of premieres) md += ligne(c) + "\n";
    md += "\n";
  }

  md += "---\n";
  md += "_Catégorisation : référentiel Disconnect (source publique vérifiable). ";
  md += "Colonne « Inférence » : déduction dérivée de la catégorie et des signaux ";
  md += "observés, **pas** un verdict sur l'intention réelle du cookie. ";
  md += "Observations dynamiques locales, non exportées ailleurs que dans ce fichier._\n";

  return md;
}


// ── Export des candidats au format Open Cookie Database (prêt pour PR) ────────
// Colonnes exactes de open-cookie-database.csv. On pré-remplit ce qui est
// observable (nom, domaine, wildcard, plateforme déduite) et on laisse VIDES
// les champs de jugement humain (catégorie, description, contrôleur) : c'est
// l'humain qui les complète avant de soumettre la pull request.
function uuidV4() {
  // Génère un UUID v4 (identifiant de ligne attendu par la base).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function csvEchappe(v) {
  v = String(v == null ? "" : v);
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function construireCsvCandidats(candidats) {
  const cols = [
    "ID", "Platform", "Category", "Cookie / Data Key name", "Domain",
    "Description", "Retention period", "Data Controller",
    "User Privacy & GDPR Rights Portals", "Wildcard match"
  ];
  const lignes = [cols.join(",")];

  for (const c of candidats) {
    // Nom : pour un wildcard on retire l'étoile finale (la base stocke le préfixe).
    const nom = c.wildcard ? c.key.replace(/\*$/, "") : c.key;
    const domaine = (c.domains && c.domains[0]) ? c.domains[0] : "";
    const plateforme = c.entity || "";   // déduit de Disconnect — À VÉRIFIER par l'humain
    const ligne = [
      uuidV4(),          // ID
      plateforme,        // Platform (indice observé, à confirmer)
      "",                // Category  -> jugement humain
      nom,               // Cookie / Data Key name
      domaine,           // Domain (domaine représentatif observé)
      "",                // Description -> jugement humain
      "",                // Retention period -> à renseigner
      plateforme,        // Data Controller (indice, à confirmer)
      "",                // GDPR Rights Portals
      c.wildcard ? "1" : "0"
    ].map(csvEchappe);
    lignes.push(ligne.join(","));
  }
  return lignes.join("\n") + "\n";
}


// ── Suppression d'un cookie précis ───────────────────────────────────────────
async function supprimerCookie(c) {
  if (!c || !c.name || !c.domain) return { ok: false, error: "Cookie invalide." };
  const proto = c.secure ? "https://" : "http://";
  const hote = domaineNu(c.domain);
  const url = proto + hote + (c.path || "/");
  try {
    const res = await browser.cookies.remove({
      url: url,
      name: c.name,
      storeId: c.storeId
    });
    if (res) noterSuppression(c.name, c.domain);   // pour détecter un futur respawn
    return { ok: !!res };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}


// ── Cycle de vie des onglets ─────────────────────────────────────────────────

// Hôte de page par onglet, pour attribuer chaque cookie observé au site visité
// (nécessaire au filtre de fréquence trans-sites du registre de candidats).
const tabUrls = new Map();
browser.tabs.query({}).then(function (ts) {
  ts.forEach(function (t) { if (t.url) tabUrls.set(t.id, t.url); });
}).catch(function () {});

browser.tabs.onRemoved.addListener(function (tabId) {
  perTab.delete(tabId);
  tabUrls.delete(tabId);
});

browser.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.url) tabUrls.set(tabId, changeInfo.url);
  // On repart de zéro au chargement d'une nouvelle page, pour que l'état
  // reflète la page courante et non l'historique de l'onglet.
  if (changeInfo.status === "loading" && changeInfo.url) {
    resetTab(tabId, changeInfo.url);
  }
});


// ── Inspection manuelle depuis la console de fond ────────────────────────────
function inspecter() {
  browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    const tab = tabs[0];
    if (!tab) { console.log("Aucun onglet actif."); return; }
    const rec = perTab.get(tab.id);
    if (!rec) { console.log("Aucun état pour cet onglet."); return; }
    console.log("── Onglet " + tab.id + " : " + rec.url + " ──");
    console.log("Cadres instrumentés : " + rec.framesSeen.size);
    console.log("Origines de cookies observées : " + rec.cookieOrigins.size);
    console.log("Signaux de fingerprinting : " + rec.signals.size);
    console.log("Registre candidats (clés) : " + registre.size +
                " | proposables (>=" + SEUIL_SITES + " sites) : " + candidatsFiltres().length);
  });
}

console.log("[Observatoire] background prêt (cookies + fingerprint). Tape inspecter().");
