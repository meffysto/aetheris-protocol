# Rules epochs (soft-fork de la balance)

Architecture complète : `docs/adr/0011-rules-epochs-soft-fork.md`.
Ce fichier est le **runbook opérationnel** pour activer un nouvel epoch.

## Quand l'utiliser

L'utilisateur veut **changer la balance** (coûts, durées, multiplicateurs)
sans hard reset. Exemples : "rééquilibre les mines", "passe en calibration
0.4", "ralentir l'infrastructure".

À NE PAS utiliser pour : ajouter un bâtiment / vaisseau / recherche,
changer une formule de production, modifier le wire format. Ça reste
un hard reset (bump `protocol_version` dans `genesis.yaml`).

## Étapes

### 1. Itérer sur la calibration avec `balance-sim`

Travaille dans `engine/rules-proposed.yaml` (v1 plat, pas d'epochs) ou
directement avec `--activation-tick=0` sur le rules.yaml de prod.

```bash
# baseline (epoch courant only)
node engine/balance-sim.mjs skilled-econ --ticks=35040 --activation-tick=99999

# nouvelle calibration appliquée dès tick 0
node engine/balance-sim.mjs skilled-econ --ticks=35040 --activation-tick=0
```

35040 ticks = 1 an IRL à 15 min/tick. Vise un palier de mine qui
double sur 1 an et reste atteignable à 2 ans (mf 23 → 33 sur l'epoch
0.3, par exemple).

### 2. Calculer `activation_tick`

```bash
TIP=$(curl -s https://mutinynet.com/api/blocks/tip/height)
GENESIS=$(grep bloc_genesis genesis/genesis.yaml | awk '{print $2}')
BPT=30  # cf genesis.parametres.blocs_par_tick
TICK_COURANT=$(( (TIP - GENESIS) / BPT ))
ACTIVATION=$(( TICK_COURANT + 96 ))   # +96 = +24h IRL de préavis
echo "activation_tick: $ACTIVATION"
```

Convention : **toujours +96 ticks minimum** (24h). Donne le temps aux
joueurs de voir le bandeau et de planifier leurs derniers chantiers
sous l'ancienne grille.

### 3. Éditer `engine/rules.yaml`

Append à la fin de `epochs:` :

```yaml
  - activation_tick: <valeur calculée>
    name: "epoch X.Y — <description courte>"
    patches:
      "batiments.mine_ferrum.multiplicateur_cout": 1.42
      "batiments.depot.multiplicateur_cout": 1.65
      # ...
```

Règles du loader (`engine/rules-loader.mjs`) :

- **Clés dottées entre guillemets doubles** (`"a.b.c"`) — sinon le
  parser yaml-mini les coupe au point.
- **Valeurs scalaires uniquement** (number, string, bool). Un objet
  marche mais c'est suspect — un changement de structure ≠ patch.
- **Chaque segment du chemin doit exister** dans le ruleset courant.
  Patch sur `"batiments.foo.bar"` où `foo` n'existe pas → erreur au
  load, le boot crashe joueur-side.
- **`activation_tick` strict croissant** vs l'epoch précédent.

### 4. Valider

```bash
# tests : 84+ doivent passer
node --test tests/*.test.mjs

# sanity : vérifier la transition au bon tick
node -e '
import("./engine/rules-loader.mjs").then(async ({parseRulesDoc, effectiveRulesAtTick}) => {
  const fs = await import("node:fs");
  const doc = parseRulesDoc(fs.readFileSync("engine/rules.yaml", "utf8"));
  const A = <activation_tick>;
  console.log("T="+(A-1)+":", effectiveRulesAtTick(doc, A-1).batiments.mine_ferrum);
  console.log("T="+A+":",    effectiveRulesAtTick(doc, A).batiments.mine_ferrum);
});
'
```

### 5. Commit + push 3 cibles

```bash
git add engine/rules.yaml
git commit -m "feat(rules): epoch X.Y activé @ tick <N>"
git push origin bitcoin/mvp
git push codeberg bitcoin/mvp
git push codeberg bitcoin/mvp:pages   # ← prod joueurs, ne pas oublier
```

## Garde-fous

| Interdit | Pourquoi | Sortie de secours |
|---|---|---|
| `activation_tick` ≤ tick courant | Snapshots IndexedDB pré-calculés sous l'ancien ruleset deviennent incohérents | Bumper `REPLAY_SNAPSHOT_VERSION` dans `engine/boot-bitcoin.mjs` pour forcer full replay |
| Patch sur clé inexistante | Crash au boot client | Vérifier au load avec la commande sanity de l'étape 4 |
| `activation_tick` non strict croissant | Loader rejette le YAML | Renuméroter |
| Retirer un bâtiment / vaisseau / techno via patch | Empires qui en possèdent cassent | Hard reset (= bump `protocol_version`) |
| Changer une formule de production | Pas patchable, c'est dans le code de `tick-core.mjs` | Modifier le code + hard reset |

## Vérifications post-activation

Une fois le `activation_tick` franchi :

- Les bâtiments existants gardent leur `production_par_utj` snapshottée
  (vérifié par `tests/epochs.test.mjs`). Aucun joueur ne perd de prod.
- Les **chantiers en cours** au moment de l'activation utilisent le
  coût/durée du tick où l'ordre a été inscrit (déjà figé dans
  `file_chantier[i].fin_utj`). Seuls les nouveaux ordres voient la
  nouvelle grille.
- Snapshot v1 reste valide tant qu'on ne touche pas au wire format.

## Référence rapide

- Architecture : `docs/adr/0011-rules-epochs-soft-fork.md`
- Loader : `engine/rules-loader.mjs` (`parseRulesDoc`, `effectiveRulesAtTick`)
- Tests : `tests/epochs.test.mjs` (8 tests dont l'invariant prod-snapshottée)
- Snapshot replay : `docs/adr/0007-snapshots-replay-indexeddb.md`
