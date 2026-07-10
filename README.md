# Observatoire

Extension Firefox — **observatoire local de vie privée**. Elle n'est pas un bouclier de plus : elle *observe*, *mesure*, *documente* et permet d'agir au cas par cas, sans jamais envoyer la moindre donnée hors du navigateur.

Là où un bloqueur classique (uBlock…) filtre par listes globales, Observatoire fait ce que personne d'autre ne fait proprement : catégoriser chaque cookie individuellement, distinguer qui l'a posé, détecter les cookies qui *reviennent* après suppression et bloquer précisément leur réanimateur, le tout consigné dans un journal infalsifiable.

Il **coexiste** avec uBlock plutôt que de le concurrencer.

---

## Principes de conception

- **100 % local.** Aucune requête réseau, aucune télémétrie, aucune synchronisation. Tout vit dans le navigateur.
- **Jamais de valeur de cookie.** L'outil manipule des noms, des domaines, des catégories, des dates — jamais le contenu d'un cookie. L'instrument qui documente la surveillance ne doit pas en devenir une source.
- **Sourcé, pas deviné.** La catégorisation vient de bases publiques vérifiables. Ce que l'outil déduit est étiqueté comme *inférence*, jamais présenté comme un verdict.
- **Pas de faux scores.** On affiche des faits comptables (N domaines, N respawns), pas un « niveau d'exposition : 73/100 » inventé.
- **Observer sans casser.** Le socle est passif ; le blocage est unitaire, choisi, réversible.

---

## Architecture des fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | Déclaration de l'extension (MV2, permissions). |
| `hook-page.js` | S'exécute dans le **monde de la page**. Instrumente les API de fingerprinting (canvas, WebGL, audio) et le setter `document.cookie`. |
| `content-hook.js` | Injecte `hook-page.js` et relaie ses messages au fond. |
| `background.js` | Cœur logique : observation, catégorisation, registre, respawn, blocage, journal. |
| `reference-db.js` | Référentiel **domaine → entité + catégorie** (source : Disconnect, GPL-3.0). ~4 400 domaines. |
| `cookie-names-db.js` | Référentiel **nom de cookie → catégorie** (source : Open Cookie Database). ~2 250 entrées, exactes + wildcard. |
| `popup.html` / `popup.js` | Interface : panneau accessible via l'icône de la barre d'outils. |

Flux général :

```
hook-page.js ──postMessage──▶ content-hook.js ──sendMessage──▶ background.js ──sendMessage──▶ popup.js
   (monde page)                  (content script)                 (page de fond)                 (interface)
```

---

## Ce que fait l'extension (par brique)

### 1. Détection de fingerprinting
Repère les scripts qui lisent des signaux d'empreinte : `canvas.toDataURL`, `getImageData`, modèle GPU via WebGL (`UNMASKED_*`), lecture audio. Un signal **n'est pas une preuve** de pistage (ces API ont des usages légitimes) : l'interface le présente comme un signal à pondérer.

### 2. Cookies : catégorisation et suppression au cas par cas
Chaque cookie de la page est affiché avec :
- son **origine** : `HTTP` (en-tête serveur), `JS` (+ script fautif via `document.cookie`), ou `préexistant` ;
- sa **partie** : 1re ou tierce ;
- sa **catégorie** et son **entité**, par une cascade **nom → domaine → inconnu** ;
- sa **durée** de vie et une **inférence** clairement étiquetée ;
- un bouton **Supprimer** unitaire (préserve la session : on retire le traceur sans déconnecter).

### 3. Respawn + blocage
Quand un cookie que **tu** as supprimé est reposé, il apparaît dans **⚠ Respawns** avec son *réanimateur* nommé (script JS précis ou domaine HTTP). Le bouton **Bloquer** met ce réanimateur en liste noire **pour ce site** : au prochain chargement il est annulé, le cookie ne revient plus. Débloquable à tout moment.

### 4. Connexions tierces
Liste tous les domaines tiers qu'une page contacte, avec catégorie, entité, nombre d'appels et statut (`⛔` bloqué par toi, `✕` échoué/filtré). Vue « au-delà des cookies ».

### 5. Journal d'intégrité (SHA-256)
Chaque événement (suppression, respawn, blocage, déblocage, candidat ignoré) est scellé au précédent par un hachage SHA-256. Modifier une entrée passée casse la chaîne — détecté par la vérification (`✓ chaîne intègre` / `✕ altérée`). Exportable en JSON.

### Contribution ascendante
Les cookies **non catalogués** vus sur **≥ 2 sites distincts** (et qui ne ressemblent pas à un identifiant unique) deviennent des **candidats**. Deux filtres protègent le commun : fréquence trans-sites et rejet des jetons par-utilisateur. Le bouton **Exporter candidats** produit un `.csv` au **format exact de l'Open Cookie Database**, champs de jugement humain laissés vides — prêt à compléter puis coller dans une *pull request*. Actions par candidat : **Oublier** (retire du registre) / **Ignorer** (écarte définitivement).

### Export Markdown (Obsidian)
Le bouton **Exporter .md** génère un rapport de page avec frontmatter (`categories`, `entites`, `fingerprint`) : dans un graphe Obsidian, deux pages partageant une entité se relient → cartographie trans-sites de ton exposition.

---

## Installation (module temporaire)

1. Placer tous les fichiers dans un même dossier.
2. Firefox → `about:debugging` → **Ce Firefox** → **Charger un module complémentaire temporaire** → sélectionner `manifest.json`.
3. L'icône apparaît dans la barre d'outils. Un module temporaire se recharge à chaque redémarrage de Firefox.

Pour déboguer le fond : `about:debugging` → l'extension → **Inspecter** → console (`inspecter()` affiche l'état de l'onglet actif).

---

## Sources & licences

- **Disconnect Tracking Protection** (`services.json`) — GPL-3.0. https://github.com/disconnectme/disconnect-tracking-protection
- **Open Cookie Database** — https://github.com/jkwakman/Open-Cookie-Database

Les bases sont **embarquées** (compactées), pas interrogées via une API : aucune fuite réseau, fonctionnement hors-ligne, gratuit et permanent. Pour les rafraîchir, re-télécharger les sources et régénérer les deux fichiers `*-db.js`.

Extension distribuée sous **GPL-3.0**.

---

## Confidentialité

- Aucune donnée ne quitte le navigateur.
- Aucune **valeur** de cookie n'est lue, stockée ou exportée — uniquement noms, domaines, catégories, dates.
- Le registre de candidats et le journal (`storage.local`) restent strictement locaux.
- Les exports (`.md`, `.csv`, `.json`) sont déclenchés **manuellement** par toi.

---

## Limites honnêtes

- **Fingerprinting :** un signal indique une lecture possible d'empreinte, pas une intention de pistage. Faux positifs attendus (jeux, graphiques).
- **Catégorie au niveau du domaine/nom, pas de l'intention.** On qualifie l'emplacement et le nom du cookie, jamais ce qu'il *fait vraiment*.
- **Attribution JS** limitée aux cookies posés **après** le chargement de l'extension (recharger la page pour la remplir).
- **Respawn** déclenché par *ta* suppression. Le blocage empêche le futur, pas le passé : re-supprimer après blocage si le cookie est encore là. Bloquer un **domaine** peut casser un site ; bloquer un **script** précis est plus chirurgical.
- **Connexions :** on voit chaque requête même si uBlock l'annule aussi, mais un `✕` peut venir d'uBlock, du réseau ou du serveur — impossible d'attribuer. Seul `⛔ bloqué par toi` est certain. La distinction 1re/3e partie utilise une heuristique à 2 labels (imparfaite pour `.co.uk`).
- **Journal :** la chaîne prouve la **cohérence interne**, pas la **date réelle**. Pour un horodatage opposable, il faudrait ancrer la tête de chaîne dans une source publique (commit git, OpenTimestamps) — non implémenté.
- **Heuristiques de wildcard** (regroupement `prefix_*`) imparfaites : les exemples réels sont affichés pour vérification avant contribution.
- **MV2 :** l'extension utilise Manifest V2 (background persistant, `webRequest` fiable), toujours supporté par Firefox.

---

## Feuille de route

- **Synthèse de consentement (« patte blanche »)** — écrire un cookie de consentement synthétique « tout refusé » pour éviter la ré-affichage des bannières, au lieu de simplement bloquer. **Délibérément non embarqué ici** : c'est spécifique à chaque plateforme (TCF, Cookiebot, OneTrust, Didomi), et un cookie mal formé pourrait perturber un site. À construire comme module isolé et opt-in, plateforme par plateforme, et toujours pour *refuser* — jamais pour feindre d'accepter.
- **Ancrage temporel externe** du journal (voir limites).
- **Rafraîchissement automatique** des référentiels embarqués.

---

*Observatoire — un instrument de mesure, pas un bouclier. Il documente la surveillance sans jamais y participer.*
