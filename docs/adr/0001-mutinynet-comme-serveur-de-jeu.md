# ADR-0001 — Mutinynet comme serveur de jeu

- **Statut** : Accepted
- **Date** : 2026-02 (rétroactif, fork bitcoin/mvp)
- **Décideurs** : meffysto
- **Tags** : architecture, reseau

## Contexte

Le projet Aetheris d'origine stockait son état dans un dépôt Git, avec une
GitHub Action qui résolvait chaque tick toutes les 15 minutes. Limites
identifiées :

- Single point of failure (le runner GH).
- Censurable (un repo peut être pris down).
- Identité Ed25519 applicative — un attaquant qui compromet le runner peut
  fabriquer des signatures sans qu'aucun joueur ne le sache.
- Pas d'incitation économique à participer : un agent qui veut jouer doit
  obtenir un GH push token.

Pour sortir du MVP « démo Git », il fallait un substrat qui soit (1) sans
coordination centrale, (2) résistant à la censure, (3) avec une identité
cryptographique native que les joueurs portent déjà.

## Décision

L'état du jeu est dérivé d'inscriptions Bitcoin sur **Mutinynet** (signet
public maintenu par Mutiny Wallet). Chaque ordre est une inscription Taproot
(commit + reveal). Le bloc genesis (`3 084 991`) ancre le tick 0. Le tick
courant est `floor((tip - bloc_genesis) / blocs_par_tick)` — entièrement
dérivé du tip Bitcoin, aucune horloge serveur.

## Conséquences

### Positives
- Plus de serveur à attaquer ; tant que Mutinynet tourne, le jeu tourne.
- Le coût d'envoi d'un ordre (sats de fees) limite naturellement le spam.
- Identité unifiée joueur/wallet via Schnorr Taproot (cf ADR-0003).
- N'importe qui peut auditer l'état : `node engine/tick.mjs --from-block 3084991`.
- Les agents IA jouent sans permission : signer une TX Bitcoin, c'est tout.

### Négatives / à surveiller
- Mutinynet n'est pas garanti à long terme (signet expérimental). Si l'opérateur
  arrête, l'état est perdu (sauf migration → Bitcoin mainnet ou autre signet).
- La latence d'inclusion d'une inscription dépend des mineurs Mutinynet : pas
  d'engagement de service. Cas dégradé : un ordre peut rater son tick cible.
- Toute donnée inscrite est publique pour toujours. Les fuites de gameplay
  (compositions de flotte, ressources) sont permanentes — d'où ADR-0004.
- Le replay full-chain croît linéairement avec le nombre de blocs depuis le
  genesis. Mitigation prévue : snapshots checkpoints (cf v0.2 #3).

## Alternatives considérées

### A. Garder Git + GH Action (status quo Aetheris)
Écarté. Centralisé, censurable, pas d'identité native.

### B. Nostr seul comme transport
Écarté pour l'état canonique : les relais Nostr peuvent expirer/oublier ;
pas de garantie de chaîne immuable. Nostr est réservé aux messages privés
hors-bande (cf `engine/nostr-dm.mjs`).

### C. Bitcoin mainnet directement
Écarté pour le MVP : coût des inscriptions trop élevé pour itérer. Mutinynet
permet la même crypto pour zéro budget réel. Migration mainnet envisageable
plus tard pour une vraie partie.

## Liens

- Scanner : `engine/scan-bitcoin.mjs`
- Boot : `engine/boot-bitcoin.mjs`
- README pitch : §"Architecture"
