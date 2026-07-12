"use strict";

// ============================================================================
// consent-didomi-page.js — pilote de REFUS de consentement (monde de la page)
// ----------------------------------------------------------------------------
// Pilote l'API officielle des CMP pour REFUSER tout consentement, sans jamais
// fabriquer de cookie synthétique ni bloquer le CMP au niveau réseau. Le CMP
// génère lui-même un consentement valide -> aucun cookie malformé, refus réel.
//
// Couvre quatre CMP (nom de fichier historique, contenu généralisé) :
//   • Didomi    — setUserDisagreeToAll(), via didomiOnReady / notice.shown
//   • OneTrust  — OneTrust.RejectAll(), via OptanonWrapper + IsAlertBoxClosed
//   • Cookiebot — submitCustomConsent(false,false,false), via CookiebotOnDialogDisplay
//   • CookieYes — performBannerAction("reject"), quand la bannière est affichée
//   • tarteaucitron — userInterface.respondAll(false), quand la bannière est affichée
//
// Règles communes :
//   - On REFUSE, jamais on ne feint d'accepter.
//   - On n'agit que si aucun choix n'a déjà été fait (respect du choix manuel).
//   - Tout est en try/catch : si une API change ou est absente, on ne casse rien.
//   - Ne fait ABSOLUMENT RIEN sur un site sans CMP connu.
//
// Injecté sur toutes les pages uniquement si l'utilisateur a activé l'option.
// ============================================================================

(function () {

  var fait = { didomi: false, onetrust: false, cookiebot: false, cookieyes: false, tarteaucitron: false };

  // ── DIDOMI ────────────────────────────────────────────────────────────────
  function didomiRefuse(Didomi) {
    try {
      var api = Didomi || window.Didomi;
      if (!api || typeof api.setUserDisagreeToAll !== "function") return;
      if (typeof api.shouldConsentBeCollected === "function" && !api.shouldConsentBeCollected()) return;
      api.setUserDisagreeToAll();
      fait.didomi = true;
    } catch (e) {}
  }
  window.didomiEventListeners = window.didomiEventListeners || [];
  window.didomiEventListeners.push({ event: "notice.shown", listener: function () { didomiRefuse(null); } });
  window.didomiOnReady = window.didomiOnReady || [];
  window.didomiOnReady.push(function (Didomi) { didomiRefuse(Didomi); });

  // ── ONETRUST ────────────────────────────────────────────────────────────────
  // OneTrust appelle window.OptanonWrapper au chargement et à chaque changement.
  // On chaîne l'éventuel wrapper du site, et on refuse une fois si aucun choix
  // valide n'a été fait. NB : le site peut redéfinir OptanonWrapper après nous —
  // c'est pourquoi le sondage plus bas appelle aussi RejectAll directement.
  function onetrustRefuse() {
    try {
      if (fait.onetrust) return;
      if (typeof OneTrust === "undefined" || typeof OneTrust.RejectAll !== "function") return;
      var clos = (typeof OneTrust.IsAlertBoxClosed === "function") ? OneTrust.IsAlertBoxClosed() : false;
      if (clos) return; // un choix a déjà été fait
      fait.onetrust = true;
      OneTrust.RejectAll();
    } catch (e) {}
  }
  var wrapperPrecedent = window.OptanonWrapper;
  window.OptanonWrapper = function () {
    try { if (typeof wrapperPrecedent === "function") wrapperPrecedent.apply(this, arguments); } catch (e) {}
    onetrustRefuse();
  };

  // ── COOKIEBOT ─────────────────────────────────────────────────────────────
  function cookiebotRefuse() {
    try {
      if (fait.cookiebot) return;
      var cb = window.Cookiebot || window.CookieConsent;
      if (!cb || typeof cb.submitCustomConsent !== "function") return;
      if (cb.hasResponse) return; // un choix a déjà été fait
      fait.cookiebot = true;
      // Refuse préférences, statistiques, marketing (nécessaires toujours actifs).
      cb.submitCustomConsent(false, false, false);
    } catch (e) {}
  }
  window.addEventListener("CookiebotOnDialogDisplay", cookiebotRefuse);
  window.addEventListener("CookiebotOnLoad", cookiebotRefuse);
  window.addEventListener("CookiebotOnConsentReady", cookiebotRefuse);

  // ── COOKIEYES ───────────────────────────────────────────────────────────────
  // CookieYes expose performBannerAction("reject"). On ne refuse que si la
  // bannière est réellement affichée (aucun choix encore fait), pour respecter
  // un choix manuel déjà exprimé.
  function cookieyesBanniereVisible() {
    var el = document.querySelector(
      ".cky-consent-bar, .cky-modal, .cky-consent-container, [data-cky-tag='notice'], [class*='cky-consent']"
    );
    if (!el) return false;
    var st = window.getComputedStyle(el);
    return !!st && st.display !== "none" && st.visibility !== "hidden";
  }
  function cookieyesRefuse() {
    try {
      if (fait.cookieyes) return;
      if (typeof window.performBannerAction !== "function") return;
      if (!cookieyesBanniereVisible()) return; // pas de bannière => déjà décidé
      fait.cookieyes = true;
      window.performBannerAction("reject");
    } catch (e) {}
  }

  // ── TARTEAUCITRON ────────────────────────────────────────────────────────────
  // Open-source. respondAll(false) refuse tous les services. On ne refuse que si
  // la grande bannière est affichée (aucun choix encore fait).
  function tarteaucitronBanniereVisible() {
    var el = document.getElementById("tarteaucitronAlertBig");
    if (!el) return false;
    var st = window.getComputedStyle(el);
    return !!st && st.display !== "none" && st.visibility !== "hidden";
  }
  function tarteaucitronRefuse() {
    try {
      if (fait.tarteaucitron) return;
      var t = window.tarteaucitron;
      if (!t || !t.userInterface || typeof t.userInterface.respondAll !== "function") return;
      if (!tarteaucitronBanniereVisible()) return; // pas de bannière => déjà décidé
      fait.tarteaucitron = true;
      t.userInterface.respondAll(false);
    } catch (e) {}
  }
  window.addEventListener("tac.root_available", tarteaucitronRefuse);

  // ── Filet de sécurité ──────────────────────────────────────────────────────
  // Couvre les injections tardives et le cas où le site redéfinit OptanonWrapper
  // après nous. On sonde brièvement la présence des CMP, puis on s'arrête.
  var essais = 0;
  var sonde = setInterval(function () {
    essais++;
    onetrustRefuse();
    cookiebotRefuse();
    cookieyesRefuse();
    tarteaucitronRefuse();
    if (essais >= 40 || (fait.onetrust && fait.cookiebot && fait.cookieyes && fait.tarteaucitron)) clearInterval(sonde);
  }, 500); // ~20 s max

})();
