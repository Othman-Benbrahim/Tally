"use strict";

// ============================================================================
// consent-didomi-page.js — s'exécute dans le MONDE DE LA PAGE
// ----------------------------------------------------------------------------
// Pilote l'API officielle de Didomi pour REFUSER tout consentement, au lieu de
// fabriquer un cookie synthétique (fragile et cassable). C'est Didomi qui
// génère alors un consentement valide -> aucun cookie malformé, refus réel.
//
// On n'appelle JAMAIS setUserAgreeToAll : on refuse, on ne feint jamais
// d'accepter. On n'agit que si un consentement est réellement à collecter
// (shouldConsentBeCollected), pour respecter un choix déjà fait par l'utilisateur.
//
// Injecté uniquement si l'utilisateur a activé l'option pour ce site (opt-in).
// ============================================================================

(function () {

  function refuserSiNecessaire(Didomi) {
    try {
      var api = Didomi || (typeof window.Didomi !== "undefined" ? window.Didomi : null);
      if (!api || typeof api.setUserDisagreeToAll !== "function") return;
      // shouldConsentBeCollected() est vrai quand la bannière doit s'afficher
      // (consentement neuf ou expiré). Faux si l'utilisateur a déjà choisi.
      if (typeof api.shouldConsentBeCollected === "function" && !api.shouldConsentBeCollected()) return;
      api.setUserDisagreeToAll();
    } catch (e) { /* si l'API change ou est absente : on ne casse rien */ }
  }

  // 1) Le plus tôt possible : dès que la bannière est montrée.
  //    (à enregistrer HORS de didomiOnReady pour ne pas manquer notice.shown)
  window.didomiEventListeners = window.didomiEventListeners || [];
  window.didomiEventListeners.push({
    event: "notice.shown",
    listener: function () { refuserSiNecessaire(null); }
  });

  // 2) Voie robuste : quand le SDK est prêt (fonctionne même si on a été injecté
  //    après notice.shown, car les callbacks poussés sont exécutés à l'init —
  //    ou immédiatement si le SDK est déjà prêt).
  window.didomiOnReady = window.didomiOnReady || [];
  window.didomiOnReady.push(function (Didomi) { refuserSiNecessaire(Didomi); });

})();
