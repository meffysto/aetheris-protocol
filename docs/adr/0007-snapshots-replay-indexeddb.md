# ADR-0007 — Snapshots de replay en IndexedDB

- **Statut** : Accepted
- **Date** : 2026-05-14
- **Décideurs** : meffysto
- **Tags** : architecture, tooling, performance

## Contexte

`bootBitcoin` reconstruit l'état du jeu en (a) scannant Bitcoin Mutinynet
depuis le bloc genesis jusqu'au tip, puis (b) rejouant `runTick` tick par
tick. Le coût (b) est O(T) où T = nombre de ticks depuis le genesis.

Aujourd'hui T est petit (centaines de ticks), donc le replay est rapide
(quelques secondes). Mais T croît linéairement dans le temps, sans plafond.
À horizon 1 an (~1 750 000 blocs Mutinynet à 30 s/bloc, soit ~10 000 ticks
à 175 blocs/tick — ou des dizaines de milliers selon le réglage
`blocs_par_tick`), le boot froid devient prohibitif (dizaines de secondes
à plusieurs minutes selon le hardware).

Le scan, lui, dispose déjà d'un cache incrémental (`SCAN_CACHE_KEY = 'scan-v3'`)
qui évite de re-fetch les blocs déjà parsés. Mais le replay refait tout le
travail à chaque boot, même quand l'état au tick précédent est connu.

## Décision

Écrire un snapshot de l'état complet (`manifest`, `empires`, `galaxie`,
`identites`, accumulateurs de rapports) dans IndexedDB toutes les
`SNAPSHOT_EVERY_TICKS = 200` ticks pendant le replay, ET à la fin du replay
(toujours awaité).

Au boot suivant, charger le snapshot le plus récent ; si sa version et son
`blocGenesis` correspondent et que son `tick ≤ tickCourant`, restaurer
l'état et reprendre le replay à `snapshot.tick + 1`. Sinon : full replay
(fallback transparent).

Versionner avec `REPLAY_SNAPSHOT_VERSION` (clé `replay-snapshot-v1`). Bumper
la version casse intentionnellement tous les snapshots existants — à faire
chaque fois que la sémantique de `runTick` change de manière non
rétrocompatible.

## Conséquences

### Positives
- Boot tiède en O(ticks_depuis_snapshot) au lieu de O(T_total). Plafonné
  à 200 ticks de replay max, indépendamment de l'âge du serveur.
- Resilience aux crashes d'onglet : un snapshot intermédiaire est écrit
  toutes les 200 ticks, donc on perd au pire 200 ticks de travail.
- Fallback transparent : un snapshot manquant, corrompu, d'une version
  obsolète ou d'un autre `blocGenesis` est silencieusement ignoré. Aucun
  régression de comportement par rapport au full-replay.
- Tests couvrent les 3 chemins (réutilisation, mauvais genesis, mauvaise
  version) dans `tests/snapshot-bootbitcoin.test.mjs`.

### Négatives / à surveiller
- **Taille de stockage IDB** : chaque snapshot duplique l'état. Pour 100
  joueurs avec 9 planètes chacune, estimation ~5 MB. Acceptable mais à
  monitorer si la base de joueurs explose. Mitigation future : compresser
  via `fflate` (déjà importé).
- **Validation faible** : on fait confiance au snapshot tant que version
  + blocGenesis matchent. Si un bug de `runTick` produit un état corrompu
  qui est ensuite snapshotté, les boots suivants partent du mauvais
  état jusqu'à un bump de version. Mitigation : ajouter une recompute du
  `hash_etat` post-restore comparée à un témoin (à faire si le besoin se
  manifeste).
- **Fire-and-forget intermédiaire** : les snapshots toutes les 200 ticks
  sont non-awaités pour ne pas ralentir la boucle. En cas de quota
  exceeded, on n'apprend l'erreur qu'au snapshot final. Acceptable pour
  l'usage actuel.

## Alternatives considérées

### A. Snapshot unique en fin de boot seulement
Simple mais perd toute resilience : un crash mi-replay relance tout depuis
zéro. Pour les replays longs, c'est coûteux.

### B. Snapshot tous les ticks (continu)
Sécurité maximale mais I/O IDB excessive (200× plus d'écritures pour rien
de plus dans 99 % des cas). Écarté.

### C. Snapshots multiples versionnés (rolling window de 3)
Permettrait de revenir à un snapshot antérieur si le plus récent est
corrompu. Compromis intéressant mais complexité supplémentaire pour un
bénéfice marginal au stade actuel. Reportable.

### D. Inscrire les snapshots on-chain
Ferait remonter le snapshot dans la couche de vérité (n'importe qui
pourrait le prendre). Mais énorme (~5 MB) et chaque maj rend les
précédents obsolètes : pollue la chaîne pour zéro gain de trust (le
replay reste la source canonique).

## Liens

- Code : `engine/boot-bitcoin.mjs:21-29` (constantes), `boot-bitcoin.mjs:213-273` (logique restore + write)
- Tests : `tests/snapshot-bootbitcoin.test.mjs`
- ADRs liées : ADR-0001 (Mutinynet), ADR-0005 (pas de backend, replay client)
