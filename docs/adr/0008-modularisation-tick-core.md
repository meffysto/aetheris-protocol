# ADR-0008 — Modularisation progressive de `tick-core.mjs`

- **Statut** : Accepted (partiel — extraction des helpers purs ; phases de `runTick` à faire dans un prochain milestone)
- **Date** : 2026-05-14
- **Décideurs** : meffysto
- **Tags** : architecture, tooling

## Contexte

`engine/tick-core.mjs` faisait 1702 lignes. Le fichier mélangeait :

1. Un parser/serializer YAML maison (~140 lignes, cf ADR-0002).
2. Un RNG xoshiro128** + sérialisation canonique pour hashes (~50 lignes).
3. Le mapping bloc Bitcoin ↔ tick (~12 lignes).
4. `runTick()` lui-même (~1300 lignes), structuré en phases numérotées
   (Phase 0 expiration, Phase 0.5 énergie, Phase 1 production, Phase 2
   chantiers/recherches, Phase 2.5 reveals, Phase 3 validation,
   Phase 3.5 marché, Phase 3.6 sceaux, Phase 3.7 forfaits, Phase 4
   mouvements, …).
5. Des helpers de rendu Markdown pour les rapports (~160 lignes).

Conséquences observées :

- Diff Git énorme à chaque feature.
- Recharge IDE lente.
- Difficile de discuter d'une phase isolée sans rouvrir l'ensemble.
- Tests existants sont riches (73 cas) — un refactor doit les garder verts.

## Décision

Procéder par **étapes successives**, chacune commitable et testable :

**Étape 1 — Extraction des helpers purs (cette ADR, fait).**

Découper en modules dédiés :

- `engine/yaml-mini.mjs` : `yparse`, `ystringify` + sous-fonctions de parse.
- `engine/rng.mjs` : `rngFromSeed`, `canonicalJSON`, `sha256Hex`.
- `engine/time.mjs` : `tickFromBlockHeight`, `blockHeightForTick`.
- `engine/reports.mjs` : `renderIntelReport`, `renderAlerteEspionnage`,
  `renderBattleReport`, `renderEmpireMd`.

`tick-core.mjs` ré-exporte ces symboles publics pour préserver la
compatibilité avec les imports existants (boot, sealed-protocol,
balance-sim).

**Étape 2 — Extraction des phases (backlog).**

Sortir chaque phase de `runTick` dans son propre module `engine/tick/N-phase.mjs`
avec une signature pure `(state, deps) → effects`. `runTick` devient un
orchestrateur ~50 lignes.

Le défi : nombreuses closures locales dans `runTick` (helper `vitesseEffective`,
tables temporaires comme `incomingByPlanet`, état muté en place sur `manifest`).
Chaque extraction demande de soit threader la closure, soit la promouvoir en
helper pur indépendant. C'est plus de surgery — on le fait quand on touche
à une phase pour une autre raison.

## Conséquences

### Positives (étape 1)
- `tick-core.mjs` passe de 1702 → 1377 lignes (-19 %).
- 4 nouveaux modules, chacun < 200 lignes, focalisés et testables isolément.
- Pas de breaking change : la surface d'export publique de tick-core est identique
  (vérifié par les 76 tests verts post-extraction).
- `yparse`/`ystringify` réutilisables hors moteur (ex: client web pourrait s'en
  servir directement plutôt que de passer par tick-core).
- Les helpers de rendu (`reports.mjs`) deviennent réutilisables côté console
  pour formater des rapports localement sans rejouer un tick.

### Négatives / à surveiller
- 4 fichiers à ouvrir au lieu d'1 pour naviguer la couche helper.
- Le re-export depuis tick-core ajoute un niveau d'indirection — un nouveau
  développeur qui cherche d'où vient `yparse` doit suivre la chaîne. Mitigation :
  CONTEXT.md et le commentaire en tête de `tick-core.mjs` listent le découpage.
- L'étape 2 (extraction des phases internes) reste à faire. Le risque de
  régression est plus élevé qu'à l'étape 1 — à faire phase par phase, avec
  un commit par extraction.

## Alternatives considérées

### A. Tout extraire d'un coup (helpers + phases)
Refactor de plusieurs heures avec risque de cassure subtile. Préférable de
shipper l'étape 1 stable et faire l'étape 2 quand on a une motivation
concrète (toucher une phase pour un fix gameplay, par ex.).

### B. Ne rien extraire (statu quo)
Le fichier devient ingérable à mesure qu'on ajoute des règles. Inacceptable
pour sortir du MVP.

### C. Mono-package "tick.engine" qui re-exporte tout depuis un index
Surcouche inutile au stade actuel. À considérer si l'engine devient
publishable séparément du jeu (NPM package).

## Liens

- Code : `engine/tick-core.mjs`, `engine/yaml-mini.mjs`, `engine/rng.mjs`,
  `engine/time.mjs`, `engine/reports.mjs`
- Tests : couverture inchangée, `tests/*.test.mjs`
- ADRs liées : ADR-0002 (YAML maison), ADR-0005 (replay client)
