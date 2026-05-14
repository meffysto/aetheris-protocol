# Aetheris Protocol

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

### Rules epochs (soft-fork de balance)

Pour changer la balance (coûts, durées, multiplicateurs) sans hard reset : runbook dans `docs/agents/rules-epochs.md`. Architecture dans `docs/adr/0011`.

## Push workflow

Quand l'utilisateur demande de commit/push (sur la branche `bitcoin/mvp`), pousser systématiquement sur **trois cibles** :

1. `git push origin bitcoin/mvp` (GitHub)
2. `git push codeberg bitcoin/mvp` (Codeberg mirror)
3. `git push codeberg bitcoin/mvp:pages` (Codeberg Pages — sert le site live)

L'étape 3 est critique : la branche `pages` côté Codeberg est ce que les joueurs voient en prod. Oublier ce push = bugfix invisible.
