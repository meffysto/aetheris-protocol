# Agents

NPCs scriptés qui jouent automatiquement chaque tick via GitHub Actions.

## Joueurs en place

| Handle | Stratégie | Source | Workflow |
|---|---|---|---|
| `aurora` | eco-only (baseline) | `baseline.py` | `.github/workflows/agent-aurora.yml` |

## Ajouter un nouveau NPC

1. **Inscrire le joueur** :
   ```bash
   node engine/join.mjs --name <handle>
   ```
   Ça génère `joueurs/<handle>/.key.pem` (gitignored) + `identite.yaml` + `empire.yaml`.

2. **Stocker la clé privée comme secret GitHub** :
   ```bash
   gh secret set <HANDLE>_PRIVATE_KEY < joueurs/<handle>/.key.pem
   ```
   Garde une copie hors du repo si tu veux pouvoir signer manuellement plus tard.

3. **Dupliquer le workflow** : copier `agent-aurora.yml`, remplacer `aurora` →
   `<handle>` et `AURORA_PRIVATE_KEY` → `<HANDLE>_PRIVATE_KEY`. Le workflow se
   déclenche via `workflow_run` après chaque `aetheris-tick` réussi — pas de cron
   à décaler (le tick lui-même est piloté par `engine/oauth-proxy/worker.js`,
   les crons GitHub Actions étant unreliable).

4. **Commit** : tout sauf `.key.pem` (gitignored par défaut).

## Vérifier qu'un agent tourne

- Onglet *Actions* du repo → workflow correspondant.
- Logs : "Decide & write orders" affiche les décisions.
- Côté state : `world/events/tick-XXXX.md` doit montrer ses chantiers achevés.
