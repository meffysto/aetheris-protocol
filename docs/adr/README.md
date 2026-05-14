# Architecture Decision Records

> Format léger inspiré de [MADR](https://adr.github.io/madr/). Une décision
> structurante par fichier, numéroté. Une ADR n'est pas mise à jour : si la
> décision change, on en écrit une nouvelle qui dit « Supersedes ADR-NNNN ».

## Comment ajouter une ADR

```bash
cp docs/adr/0000-template.md docs/adr/NNNN-titre-en-kebab.md
# Édite. Statut : Proposed.
# Pousse. Discute. Une fois actée → Statut : Accepted.
```

## Index

| # | Titre | Statut | Tags |
|---|---|---|---|
| [0001](0001-mutinynet-comme-serveur-de-jeu.md) | Mutinynet comme serveur de jeu | Accepted | architecture, reseau |
| [0002](0002-yaml-canonique-maison.md) | YAML canonique maison (parser/serializer iso) | Accepted | architecture, tooling |
| [0003](0003-identite-bip86-schnorr.md) | Identité joueur = pubkey Schnorr Taproot (BIP-86) | Accepted | identite, securite |
| [0004](0004-commit-reveal-option-b.md) | Commit-reveal "option B" (reveal à l'impact) | Accepted | gameplay, securite |
| [0005](0005-pas-de-backend-pure-replay.md) | Pas de backend. État dérivé par replay client. | Accepted | architecture |

## En cours d'écriture / backlog

- ADR-0006 — Multi-device via `device_link` (inscription d'une seconde pubkey).
- ADR-0007 — Snapshots checkpoints en IndexedDB (cf v0.2 #3).
- ADR-0008 — Modularisation `tick-core` en phases (cf v0.2 #2).
- ADR-0009 — Console client : éclatement du monofichier (cf v0.2 #1).
