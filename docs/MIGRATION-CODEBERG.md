# Migration vers Codeberg (Forgejo)

Plan de bascule du runtime Aetheris depuis GitHub vers Codeberg, déclenché
par le shadow-ban silencieux du compte `meffysto` sur GitHub (mai 2026).

## Pourquoi Codeberg

- **Forgejo Actions** : compatible à ~95% avec les workflows GitHub Actions
- **Pas de shadow-ban automatique** pour les projets atypiques (asso à but non lucratif)
- **Scheduler interne fiable** → suppression du contournement Cloudflare Worker
- **Gratuit, public**, pas de quotas Actions visibles
- **API Gitea** documentée (REST), proche de l'API GitHub mais pas identique

## État de la migration

| Composant | Statut | Notes |
|---|---|---|
| `.forgejo/workflows/tick.yml` | ✅ porté | runs-on: docker, scheduler interne |
| `.forgejo/workflows/agent-aurora.yml` | ✅ porté | workflow_run identique |
| `.forgejo/workflows/validate-orders.yml` | ❌ à porter | dépend de `gh` CLI → réécriture en `tea` ou curl Gitea API |
| `.forgejo/workflows/validate-join.yml` | ❌ à porter | idem |
| `console-live.html` | ❌ à porter | abstraction du host (github.com vs codeberg.org) |
| `join.html` | ❌ à porter | idem |
| `engine/oauth-proxy/worker.js` | ❌ à adapter | Codeberg supporte OAuth2 via `/login/oauth/authorize` ; pas de device flow → bascule sur Authorization Code Flow with PKCE |
| `engine/validate-orders.mjs` | ⚠ à vérifier | utilise `GITHUB_REPOSITORY`, `PR_BASE_SHA`, `PR_HEAD_SHA` → Forgejo expose les mêmes vars (compat aliases) |
| `engine/validate-join.mjs` | ⚠ à vérifier | idem |
| README.md, doc | ❌ à mettre à jour | URLs github.com → codeberg.org |

## Procédure de bascule

### Phase 1 — Setup compte Codeberg (toi, ~15 min)

1. Créer un compte sur https://codeberg.org/user/sign_up
   - Username suggéré : `meffysto` (ou alias si pris)
   - Email distinct de celui de meffysto@github (recommandé pour ne pas
     hériter d'éventuels signaux)
2. Activer 2FA (TOTP)
3. **Activer Forgejo Actions** : Settings → Repositories → Actions enabled
4. Créer le repo `aetheris-protocol` (vide, pas d'init)

### Phase 2 — Push initial (toi, ~5 min)

```bash
# Sur cette branche migration/codeberg
git remote add codeberg https://codeberg.org/<username>/aetheris-protocol.git
git push codeberg migration/codeberg:main
```

À ce stade, Codeberg a :
- Tout le code (incluant `.forgejo/workflows/`)
- Les ordres committés des joueurs
- L'historique Git complet

### Phase 3 — Configuration secrets Codeberg

Sur Codeberg, repo Settings → Actions → Secrets :

- `AURORA_PRIVATE_KEY` : copier depuis le secret GitHub (ou refaire depuis
  `joueurs/aurora/.key.pem` local)

Pas besoin de `BOT_PAT` côté Codeberg pour l'instant : le `GITHUB_TOKEN`
implicite (alias Forgejo) couvre les commits du tick et de l'agent.

### Phase 4 — Test du tick (~30 min après push)

- Onglet *Actions* du repo Codeberg → vérifier que `aetheris-tick` se
  déclenche au prochain `*/15`
- Si OK : un commit `tick N` apparaît sur main
- `agent-aurora` doit s'enchaîner via `workflow_run`

### Phase 5 — Port console-live (moi, ~2h)

Refactor de `fetchText()` et `ghFetch()` pour supporter deux backends :

```js
const cfg = {
  host: 'codeberg.org',          // ou 'github.com'
  api: 'https://codeberg.org/api/v1',  // ou 'https://api.github.com'
  repo: 'meffysto/aetheris-protocol',
  // ...
};
```

Mapping des endpoints :

| Action | GitHub API | Gitea/Codeberg API |
|---|---|---|
| Read raw file | `/repos/{r}/contents/{p}` (Accept: raw) | `/repos/{r}/raw/{p}?ref=` |
| Get user | `/user` | `/user` (identique) |
| Fork repo | `/repos/{r}/forks` | `/repos/{r}/forks` |
| Create branch ref | `/repos/{r}/git/refs` | `/repos/{r}/branches` (shape différent) |
| Update file | `/repos/{r}/contents/{p}` (PUT) | `/repos/{r}/contents/{p}` (PUT, params différents) |
| Open PR | `/repos/{r}/pulls` | `/repos/{r}/pulls` (mostly compat) |

### Phase 6 — Port OAuth (moi, ~3h)

Codeberg ne supporte pas le device flow GitHub. Bascule sur **Authorization
Code Flow with PKCE** (RFC 7636) :

1. Enregistrer une OAuth Application Codeberg (Settings utilisateur → Applications)
2. Console-live ouvre un popup vers `https://codeberg.org/login/oauth/authorize?...&code_challenge=...`
3. Codeberg redirige vers le callback (Cloudflare Worker ou page statique)
4. Worker échange `code` + `code_verifier` contre access_token

Plus complexe que device flow mais standard et bien documenté.

### Phase 7 — Port validation workflows (moi, ~2h)

Réécrire `validate-orders.yml` et `validate-join.yml` :
- Remplacer `gh pr list/comment/merge` par appels curl à l'API Gitea
- Token : `${{ secrets.GITHUB_TOKEN }}` (alias Forgejo automatique)

### Phase 8 — Cutover (toi, ~10 min)

Une fois Codeberg fonctionnel et les joueurs prévenus :

1. Archiver le repo GitHub (Settings → Archive)
2. Mettre à jour le README pour pointer vers Codeberg
3. Communiquer aux joueurs : nouveau remote, nouveau PAT à générer
4. Décommissionner le Cloudflare Worker (plus de tick driver utile)

## Plan B : rester sur GitHub

Si GitHub Support débloque `meffysto` avant Phase 5, on peut :
- Garder cette branche `migration/codeberg` en standby (résilience future)
- Continuer normalement sur GitHub avec les ajustements de pattern déjà
  faits (commits variés, etc.)
- Optionnellement maintenir Codeberg comme miroir read-only via une Action

## Risques connus

- **Codeberg fair-use** : pas de quota explicite mais usage abusif (tick toutes
  les 1 min, par ex.) peut générer un avertissement. 15 min/tick reste raisonnable.
- **Migration des joueurs** : chaque joueur doit régénérer un PAT côté Codeberg
  pour pouvoir push depuis console-live. Friction temporaire.
- **URLs cassées** : tous les liens `github.com/meffysto/aetheris-protocol/...`
  dans la wild deviennent obsolètes. Acceptable pour un projet en alpha.
