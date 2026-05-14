# ADR-0011 — Epochs de rules (soft-fork du gameplay)

- **Statut** : Accepted
- **Date** : 2026-05-14
- **Décideurs** : meffysto
- **Tags** : architecture, balance, gameplay, replay-determinism

## Contexte

`engine/rules.yaml` contient toute la calibration du jeu : coûts, durées,
multiplicateurs, bonus planète, etc. C'est l'entrée de `runTick` côté replay
(cf ADR-0005, "pas de backend — pure replay").

Hier (v0.2 → epoch 0.2) on a fait un **hard reset** parce que la
calibration initiale tournait trop vite (mines au plafond en quelques jours).
Un hard reset, c'est : on change `rules.yaml`, on bump `protocol_version` dans
genesis, on jette l'historique on-chain, on relance un serveur. Coût pour
les joueurs : perte totale de progression. Coût pour le projet : aucun
historique cumulé, jamais.

Aujourd'hui une nouvelle calibration "OGame-like" est validée par
simulation (cf `engine/balance-sim.mjs` skilled-econ : 1 an de jeu →
mine niv 23 sur l'epoch 0.2 actuel, mine niv 33 avec la nouvelle
calibration — meilleur étalement temporel). On veut la déployer **sans**
hard reset : garder l'historique on-chain, garder les empires existants,
juste appliquer les nouveaux coûts/durées aux upgrades **futures**.

Bitcoin règle ce genre de problème depuis 2012 avec les **soft forks** :
on définit un bloc d'activation, on annonce la règle, les nœuds qui
roulent la nouvelle règle l'appliquent à partir du bloc, l'historique
antérieur reste valide. On adapte le concept aux ticks de CITADEL.

## Décision

`rules.yaml` passe en **format v2** structuré par **epochs** :

```yaml
version: 2
epochs:
  - activation_tick: 0
    name: "epoch 0.2 — calibration initiale Bitcoin MVP"
    rules:
      duree_utj_par_tick: 6
      batiments: { ... ruleset complet ... }
      vaisseaux: { ... }
      ...
  - activation_tick: 99999
    name: "epoch 0.3 — balance OGame"
    patches:
      "batiments.mine_ferrum.multiplicateur_duree": 1.4
      "batiments.depot.multiplicateur_cout": 1.7
      ...
```

Règles :

1. `epochs[0]` fournit un **ruleset complet** sous `rules:` et a
   forcément `activation_tick: 0`.
2. `epochs[i>0]` peuvent fournir des **patches** (clés dottées) qui
   modifient le ruleset courant en place. Optionnellement ils peuvent
   redéfinir un `rules:` complet (hard-fork volontaire), mais le cas
   normal est patches-only.
3. `activation_tick` est strict croissant.
4. À un tick T, le ruleset effectif est :
   ```
   effectiveRulesAtTick(doc, T) =
     fold(epoch for epoch in doc.epochs if epoch.activation_tick ≤ T,
          applying rules then patches in order)
   ```

L'implémentation vit dans `engine/rules-loader.mjs`. `boot-bitcoin.mjs`
parse le document une fois et appelle `effectiveRulesAtTick(rulesDoc, T)`
à **chaque tick** de la boucle de replay. Le coût (deep-clone +
quelques `set` dottés) est marginal devant `runTick` lui-même.

## Pourquoi c'est replay-safe (= "soft-fork compatible")

L'engine **snapshot** `production_par_utj` au moment où un chantier
s'achève (`engine/tick-core.mjs`, phase production). Conséquence : une
mine bâtie à un tick T₀ < activation_tick conserve son rendement
calculé avec les anciens paramètres, même après le passage de
l'epoch. Seules les upgrades initiées **après** activation_tick
voient les nouveaux coûts/durées.

Ce comportement n'est pas une feature ajoutée pour l'occasion — il
existait déjà depuis le découpage tick-core (ADR-0008). Le système
d'epochs en est juste l'utilisateur naturel. Pas besoin de toucher
`runTick`.

Le replay reste **déterministe** : tant que le YAML on-chain ne change
pas, `effectiveRulesAtTick(doc, T)` est une fonction pure de
`(doc, T)`. Les snapshots IndexedDB (ADR-0007) ne sont jamais
invalidés par l'ajout d'un epoch futur.

## Alternatives considérées

### A. Hard reset (status quo avant cette ADR)
Bump `protocol_version`, jette tout. Simple à coder, brutal pour les
joueurs. Rejeté : on a déjà fait ça hier, on ne veut pas recommencer.

### B. Duplication complète du ruleset par epoch
Chaque epoch redéfinit `rules:` from scratch. Avantage : pas de
sémantique de "patch". Inconvénient : ~400 lignes copiées par
changement, n'importe quel diff devient illisible. Rejeté.

### C. Conditions dans le code de `runTick`
`if (T >= ACTIVATION_TICK_03) cout *= 1.45 else cout *= 1.5;`
Le code de l'engine devient un musée de l'historique. Rejeté.

### D. Patches dottés (retenu)
Petites diffs lisibles, fold-able à n'importe quel tick, validation
explicite (segments inexistants → erreur). Le seul piège : un patch
peut écraser une **valeur**, mais pas changer la **sémantique** d'un
champ — cf "Limites".

## Limites & garde-fous

- **VALEURS, pas SÉMANTIQUES.** Un patch peut changer
  `multiplicateur_cout: 1.5 → 1.45`. Il ne peut pas remplacer la
  formule de production, ajouter un nouveau type de ressource, ou
  changer la façon dont les bâtiments sont représentés. Tout
  changement structurel reste un hard reset.
- **Pas de retrait de bâtiment / vaisseau / techno** dans un patch :
  ça casserait les empires qui en possèdent déjà.
- **Validation au load** : `parseRulesDoc` lève si l'ordre des epochs
  n'est pas strict croissant, si epoch[0].activation_tick ≠ 0, ou
  si un patch cible une clé qui n'existe pas.
- **`protocol_version` reste inchangée** dans `genesis.yaml`. Le wire
  format des inscriptions ne change pas. Un nouvel epoch ne nécessite
  pas de redémarrage de serveur ni de re-scan.
- **Préavis joueurs** : par convention, un nouvel epoch est commit/push
  avec `activation_tick = tick_courant + 96` (24h IRL à 15 min/tick).
  Les joueurs voient leur épine dorsale de progression intacte, savent
  que leurs nouvelles upgrades commandées après l'activation coûteront
  les nouveaux prix.
- **`production_par_utj` snapshotté** : c'est l'invariant qui rend tout
  ça sûr. Toute évolution future de `runTick` qui supprimerait ce
  snapshot (= recalcul dynamique) casserait le contrat soft-fork.
  Un test (`tests/epochs.test.mjs`) verrouille ce comportement.
- **Activation toujours dans le futur.** Ajouter un epoch avec
  `activation_tick ≤ tickCourant` (= rétroactif) invalide implicitement
  les snapshots IndexedDB (ADR-0007) : l'état persisté a été calculé
  sous l'ancien ruleset, le replay continuera sous le nouveau, et les
  bâtiments construits entre l'activation rétroactive et le tick du
  snapshot ne refléteront pas les nouvelles règles. Si on doit faire
  ça, il faut bumper `REPLAY_SNAPSHOT_VERSION` dans `boot-bitcoin.mjs`
  pour forcer un full replay. La convention "activation = courant + 96"
  l'évite naturellement.

## Conséquences

- **Aucun hard reset prévisible à court terme.** L'epoch 0.3 est
  embarqué dans `rules.yaml` avec `activation_tick: 99999` (=
  désactivé) ; on baisse cette valeur quand on est prêt à activer.
- **Simulateur de balance** (`engine/balance-sim.mjs`) supporte
  `--activation-tick=N` pour évaluer un epoch comme s'il était actif
  dès le tick 0.
- **UI client** : à terme, afficher un bandeau "Epoch 0.3 entre en
  vigueur dans Xh" entre commit et activation. Pas implémenté à cette
  ADR — backlog.
- **Test suite** : `tests/epochs.test.mjs` couvre parsing, validation,
  ordre des patches, immutabilité du doc source, et l'invariant de
  snapshot de production à travers une transition.

## Voir aussi

- ADR-0002 — YAML maison (parser supporte les clés quotées qu'on
  utilise pour les chemins dottés des patches).
- ADR-0005 — pure replay (pas de backend ; les rules sont un input
  pur de `runTick`).
- ADR-0007 — snapshots IndexedDB (invalidés par version, pas par
  changement de rules).
- ADR-0008 — modularisation tick-core (snapshot `production_par_utj`
  à la complétion est documenté ici).
