# ADR-0009 — Découpage de la console : HTML / CSS / JS

- **Statut** : Accepted (étape 1 — séparation des 3 langages ; étape 2 — split modulaire du JS à faire)
- **Date** : 2026-05-14
- **Décideurs** : meffysto
- **Tags** : architecture, tooling, dx

## Contexte

`console-live-bitcoin.html` est l'interface principale du jeu côté joueur.
Pour préserver la simplicité de déploiement (« `git push codeberg pages` et
c'est en ligne », ADR-0005), tout était empilé dans un seul fichier HTML :

- 2 153 lignes de `<style>` inline
- 4 850 lignes de `<script>` inline (l'app logic)
- 379 lignes de markup HTML
- 52 lignes de `<script type="module">` (dynamic imports des modules engine)

Total : **315 KB** dans un seul fichier.

Conséquences observées :
- Diff Git devient illisible pour la moindre modification UI.
- Conflit de merge quasi-garanti si deux personnes touchent la console.
- Refactor manuel impossible sans crainte de tout casser.
- Pas de cache navigateur efficace : changer un selecteur CSS invalide
  également les 215 KB de JS.
- Les outils (linter, formatter, LSP) considèrent le tout comme un seul
  blob HTML.

## Décision

Séparer en **trois fichiers** :

- `console-live-bitcoin.html` — coquille de 21 KB (head, importmap, markup
  body, dynamic imports des modules engine, références `<link>` et
  `<script src>`).
- `client/styles.css` — 2 151 lignes de CSS extraites du `<style>` inline.
- `client/app.js` — 4 847 lignes de JS extraites du `<script>` inline.

Le `<script type="module">` (dynamic imports → `window.aetherisBitcoin`)
reste **inline** dans la HTML — c'est lui qui charge les modules engine
et émet `aetheris-bitcoin-ready` que `app.js` attend. Le déplacer
demanderait des ajustements de path (ESM relatif) sans bénéfice immédiat.

Pas de bundler, pas de build step : `git push codeberg pages` continue à
suffire. Le serveur statique sert 3 fichiers au lieu d'1.

## Conséquences

### Positives (étape 1)
- HTML passe de 315 KB → 21 KB (-93 %).
- Diff Git lisible : `git log -p client/styles.css` ne mélange plus avec
  les changements de JS ou de markup.
- Cache navigateur efficace : un fix CSS ne re-télécharge pas l'app JS.
- LSP/linter : chaque fichier est analysé natifvement par les outils
  appropriés (CSS, JS).
- Onboarding d'un contributeur : il peut chercher un sélecteur sans
  scroller dans du HTML.
- Aucune dépendance ajoutée (pas de bundler, pas de framework).

### Négatives / à surveiller
- 3 fichiers à servir au lieu d'1 → 3 round-trips HTTP au cold load. Sur
  Codeberg Pages avec HTTP/1.1 c'est un léger surcoût. Mitigation : on
  pourra activer HTTP/2 ou regrouper en build step si la perf devient
  un problème.
- `client/app.js` reste un monolithe de 214 KB. L'étape 2 (split par
  vue : `client/render/galaxy.mjs`, `client/render/batiments.mjs`, etc.)
  demande de comprendre l'enchevêtrement des fonctions `render*`,
  `state.*` partagé, et la file d'ordres. À faire quand on touche une
  vue spécifique pour une autre raison.
- L'ordre de chargement entre le `<script type="module">` (deferred par
  défaut) et le `<script src>` (synchrone) compte : `app.js` attend
  l'event `aetheris-bitcoin-ready` via `waitForBitcoinModule()` avant
  d'accéder à `window.aetherisBitcoin`. Comportement préservé du
  monofichier.

## Alternatives considérées

### A. Garder le monofichier
Statu quo. Inacceptable à mesure que la base UI grandit.

### B. Tout en modules ES natifs (`<script type="module">`)
Possible, mais demande de convertir tous les `function` top-level en
exports + imports croisés. Travail significatif pour passer à une
architecture modulaire claire — c'est l'étape 2.

### C. Bundler (Vite, esbuild)
Apporte HMR, code splitting, minification. Mais introduit un build
step → invalide la promesse « tout est servable depuis git ». À
considérer si on cible une vraie release production avec optimisations.

### D. Frameworks UI (Svelte, Solid, React)
Hors scope. La console est déjà fonctionnelle et performante en vanilla.
Le coût de migration ne se justifie pas tant qu'on n'a pas une équipe
qui se plaint de productivité.

## Liens

- HTML coquille : `console-live-bitcoin.html` (21 KB)
- CSS : `client/styles.css` (82 KB, 2151 lignes)
- JS : `client/app.js` (214 KB, 4847 lignes)
- ADRs liées : ADR-0005 (pas de backend / replay client), ADR-0008
  (modularisation engine)
