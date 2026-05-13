# Agents

NPCs scriptés qui jouent automatiquement sur Mutinynet via Bitcoin
inscriptions — comme n'importe quel joueur humain (commit + reveal taproot,
op_type=0x02). Pas de privilège engine, pas de chemin court : leur identité
est leur pubkey Schnorr.

## Joueurs en place

| Handle  | Stratégie (défaut) | Source                       | Workflow                    |
| ------- | ------------------ | ---------------------------- | --------------------------- |
| `aurora`| `eco`              | `aurora-autonomous.mjs`      | `.github/workflows/agent-aurora.yml` |

`agents/baseline.py` reste pour référence (la stratégie `eco` dans
`agents/strategies/eco.mjs` mirror sa logique).

## Stratégies pluggables

Chaque agent lit `joueurs/<player>/agent.yaml` au démarrage **et à chaque
cycle**. Modifier ce fichier (+ commit/push) suffit pour changer la stratégie
au prochain tour, sans restart.

```yaml
# joueurs/aurora/agent.yaml
strategie: eco                 # voir agents/strategies/*.mjs
priorites_batiments: [...]     # optionnel — défauts dans la stratégie
priorites_recherche: [...]     # idem
```

Stratégies fournies :

| Nom     | Fichier                          | Comportement                            |
| ------- | -------------------------------- | --------------------------------------- |
| `eco`   | `agents/strategies/eco.mjs`      | Prod d'abord, R&D en complément. Défaut. |
| `turtle`| `agents/strategies/turtle.mjs`   | Biais labo + défense, R&D systématique.  |

Ajouter une stratégie = écrire `agents/strategies/<nom>.mjs` exportant
`name` (string) et `decide({ empire, config, ctx }) → ordres[]`. Le loader
(`agents/strategies/index.mjs`) la trouve automatiquement.

## Bootstrap d'un agent (one-shot)

```bash
# 1. Génère un wallet taproot Mutinynet pour l'agent
node agents/aurora-init.mjs --player aurora
#    → joueurs/aurora/.btc-key.json (chmod 600, gitignored)
#    → affiche l'adresse à fonder

# 2. Fonde l'adresse via https://faucet.mutinynet.com (≥ 5000 sats recommandé)

# 3. Inscrit le join Bitcoin (identité on-chain de l'agent)
node agents/aurora-init.mjs --player aurora --join

# 4. Sauvegarde la clé comme secret GitHub pour le workflow
gh secret set AURORA_BTC_KEY < joueurs/aurora/.btc-key.json
```

## Lancer la boucle autonome

En local (long-running) :

```bash
node agents/aurora-autonomous.mjs --player aurora
# AETH_NETWORK=mutinynet AURORA_POLL_SEC=60 AETH_FEE_RATE=1
```

Variables d'env utiles :

| Variable                          | Défaut       | Effet |
| --------------------------------- | ------------ | ----- |
| `AETH_NETWORK`                    | `mutinynet`  | Réseau Esplora cible |
| `AETH_FEE_RATE`                   | `1`          | sat/vB pour commit/reveal |
| `AURORA_POLL_SEC`                 | `60`         | Pause entre cycles (s) |
| `AURORA_DRY_RUN`                  | —            | `=1` → décide mais n'inscrit rien |
| `AURORA_MAX_ITER`                 | `10000`      | Cap cumulé de cycles |
| `AURORA_MAX_SATS_SPENT`           | `50000`      | Cap cumulé fees (sats) |
| `AURORA_MAX_CONSECUTIVE_ERRORS`   | `5`          | Bail au-delà |
| `AURORA_KILL`                     | —            | `=1` → kill switch d'urgence |

Sur GitHub Actions, le workflow `agent-aurora.yml` exécute UN cycle après
chaque tick (`workflow_run` après `aetheris-tick`).

## Kill switch (3 niveaux, vérifié 2× par cycle)

```bash
# 1. Fichier sentinel (le plus simple, fonctionne local + CI)
node agents/aurora-killswitch.mjs on            # arme
node agents/aurora-killswitch.mjs status        # vérifie
node agents/aurora-killswitch.mjs off           # désarme
#    Commit + push `agents/.killswitch-aurora` → CI s'arrête aussi.

# 2. Env var (idéal pour un run local immédiat)
AURORA_KILL=1 node agents/aurora-autonomous.mjs

# 3. Signal POSIX (SIGINT / SIGTERM)
#    Ctrl-C ou `kill -TERM <pid>` → sortie au prochain cycle (pas instantanée
#    pour ne jamais couper une inscription mid-broadcast).
```

L'agent vérifie le kill switch **avant ET après chaque cycle**, et toutes les
secondes pendant le sleep — réaction max ≈ POLL_SEC pendant un cycle, sinon
< 1s.

## Caps de sécurité

L'agent stocke ses compteurs dans `.cache/aurora-<player>-state.json` :

- `iterations` — sortie quand ≥ `AURORA_MAX_ITER`
- `satsSpent`  — sortie quand ≥ `AURORA_MAX_SATS_SPENT`
- `errStreak`  — bail quand ≥ `AURORA_MAX_CONSECUTIVE_ERRORS`

Reset manuel : `rm .cache/aurora-aurora-state.json`.

## Ajouter un autre NPC

Identique : `--player <nom>` partout. Workflow : duplique `agent-aurora.yml`,
remplace `aurora` → `<nom>` et `AURORA_BTC_KEY` → `<NOM>_BTC_KEY`.

## Vérifier qu'un agent tourne

- GitHub Actions tab → workflow correspondant.
- Logs : `Run one autonomous cycle` affiche les décisions et les txid.
- Côté chain : `https://mutinynet.com/address/<adresse_agent>` montre les
  inscriptions commit/reveal de chaque tick.
- Côté état : la console reconnaît l'agent comme un joueur normal.
