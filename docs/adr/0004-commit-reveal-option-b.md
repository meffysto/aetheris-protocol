# ADR-0004 — Commit-reveal "option B" (reveal à l'impact)

- **Statut** : Accepted
- **Date** : 2026-03 (rétroactif)
- **Décideurs** : meffysto
- **Tags** : gameplay, securite

## Contexte

Tout ce qui est inscrit sur Bitcoin est public, pour toujours. Si un joueur
inscrit un ordre d'attaque en clair au tick T-1, la cible voit l'inscription
~30 s plus tard et peut évacuer sa flotte avant l'impact. Le jeu devient un
ping-pong défensif où l'asymétrie d'information n'existe plus.

Or un MMO 4X militaire repose sur le brouillard tactique : on doit pouvoir
préparer un coup sans le révéler. Sans ça, plus de surprise, plus de feinte,
plus de stratégie.

Plusieurs schémas de commit-reveal sont possibles. Lequel choisir ?

## Décision

**Option B : reveal à l'impact**. Au tick `T_depart`, le joueur inscrit un
sealed (`op_type=0x03`) avec :

- `planete_origine` (visible publiquement — un défenseur sait qu'**une**
  flotte va partir, mais pas où)
- `kind: militaire` (catégorie large, pas le type précis)
- `hash = sha256(canonicalJSON(secret))`

Au tick `T_impact` — calculé déterministiquement par la physique du vol —
le joueur inscrit un reveal (`op_type=0x04`) avec le secret complet (cible,
composition, vitesse, nonce). Le moteur vérifie :

1. Hash matche.
2. `secret.depuis === sealed.planete_origine`.
3. `tick_impact === tick_depart + ceil(distance / vMin × 100 / UTJ_PAR_TICK)`.

Combat résolu immédiatement au tick_impact si tout matche.

## Conséquences

### Positives
- Le défenseur n'apprend NI la cible NI la composition avant l'impact.
- Pas de timing leak : `T_impact` n'est pas déclaré au sealing, il dérive
  de la flotte révélée. Un attaquant ne peut pas mentir sur sa vitesse
  pour induire en erreur sans rater son tick (la vérif physique pète).
- Le défenseur doit garder sa flotte par défaut (paranoïa coûteuse) ou
  parier sur ce qui se prépare. Restaure la profondeur stratégique.

### Négatives / à surveiller
- **Bluff gratuit** (v1) : un sceau jamais révélé expire au bout de
  `SEALED_MAX_PATIENCE_TICKS` (~10 jours mutinynet) sans coût pour
  l'attaquant. À durcir en v2 avec une caution ressource bloquée au sealing
  et brûlée si pas de reveal.
- **Espionnage et colonisation restent en clair** (v1). Espionnage parce
  que la quantité d'info révélée par le sceau y est déjà faible (juste
  l'origine). Colonisation parce que la cible doit être vérifiable
  publiquement (case libre).
- **Sealed pending stocké hors-chaîne** : `manifest.sealedPending[txid]`
  est recalculé à chaque replay. Pas de fuite, mais un client nouveau doit
  rejouer tout pour le reconstruire (mitigation : snapshots, cf v0.2 #3).

## Alternatives considérées

### A. Option A "reveal au lancement"
Le joueur inscrit le secret AVANT que la flotte parte. Cible et composition
sont publiques pendant le vol → la cible évacue. Inutile.

### B. Option C "hash-only à perpétuité"
Le moteur ne demande jamais le secret ; seul le hash sert d'engagement, et
les flottes sont simulées en aveugle. Trop opaque côté UX (impossible
d'afficher des rapports de bataille fidèles) et casse le déterminisme
public.

### D. Pas de sceau, mais latence d'inclusion comme protection
Compter sur le délai entre inscription et confirmation Bitcoin. Trop
faible (~30 s sur Mutinynet) et asymétrique selon la fee payée — un joueur
riche en sats contournerait.

## Liens

- Code : `engine/sealed-protocol.mjs`
- Doc : `engine/PROTOCOL.md` §4.2-4.3
- Tests : `tests/sealed.test.mjs`, `tests/sealed-wire.test.mjs`, `tests/sealed-bootbitcoin.test.mjs`
- Constante : `SEALED_MAX_PATIENCE_TICKS = 1000` (10 jours Mutinynet)
