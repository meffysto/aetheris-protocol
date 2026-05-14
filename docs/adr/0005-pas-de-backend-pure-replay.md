# ADR-0005 — Pas de backend. État dérivé par replay client.

- **Statut** : Accepted
- **Date** : 2026-02 (rétroactif)
- **Décideurs** : meffysto
- **Tags** : architecture

## Contexte

Une fois qu'on a décidé que Bitcoin transporte les ordres (ADR-0001) et que
l'identité est la pubkey Schnorr (ADR-0003), la question reste : qui calcule
l'état canonique ? Trois mondes possibles :

1. **Serveur central** qui scanne Bitcoin et expose une API REST de l'état.
2. **Serveur opt-in** : plusieurs nodes calculent indépendamment et un client
   choisit lequel croire.
3. **Pas de serveur** : chaque client (navigateur, CLI, bot) rejoue lui-même
   les inscriptions et calcule l'état localement.

Le mode 1 réintroduit le SPOF qu'on vient de retirer. Le mode 2 marche pour
Ethereum/Bitcoin (consensus émergent) mais demande un protocole de
réconciliation et de discovery — overkill pour le scale actuel. Le mode 3
fonctionne SI le replay est :

- **déterministe** : tous les clients arrivent au même état.
- **rapide** : un joueur ne doit pas attendre 10 minutes pour ouvrir sa console.
- **isomorphe** : le code de replay tourne identiquement en Node et en navigateur.

## Décision

Mode 3. Le client navigateur (`console-live-bitcoin.html`) embarque le moteur
complet (`engine/tick-core.mjs`, `engine/scan-bitcoin.mjs`, etc.) en ES
modules natifs. Au boot :

1. Charge le genesis (statique, depuis le repo / Codeberg Pages).
2. Scanne Mutinynet via Esplora (HTTP) depuis `bloc_genesis` jusqu'au tip.
3. Cache les inscriptions trouvées en IndexedDB (`SCAN_CACHE_KEY = 'scan-v3'`).
4. Rejoue `runTick()` bloc par bloc → état déterministe.
5. Affiche.

Refresh : toutes les 15 s, scan delta depuis `lastCachedBlock + 1`, replay
incrémental.

## Conséquences

### Positives
- Zéro infrastructure à maintenir : `git push codeberg pages` et c'est en
  ligne. Le coût marginal d'un joueur supplémentaire est nul.
- Le client EST son propre validateur : aucune confiance dans un tiers.
- Un bot peut se brancher sans permission — il consomme la même API publique.

### Négatives / à surveiller
- **Boot froid linéaire dans le nombre de blocs**. Aujourd'hui ~quelques
  milliers de blocs Mutinynet → quelques secondes. Demain 100 000 blocs →
  plusieurs minutes. Mitigation : snapshots checkpoints (v0.2 #3).
- **Cache poisoning si IDB corrompu** : on stocke le replay côté client. Si
  le cache est manipulé, l'état affiché diverge — mais aucune ACTION n'est
  validée localement, donc les ordres restent corrects. Mitigation :
  redériver `hash_etat` à chaque replay et le comparer entre clients via
  Nostr (idée future).
- **Esplora est un SPOF de lecture** : si l'API Mutinynet tombe, plus de
  scan. Mitigation : permettre l'override de l'URL Esplora dans la config
  (déjà supporté, cf `cfg.esplora`).
- **Pas d'historique d'événements stable** : les batailles/intel sont
  recalculées à chaque replay. Si on change le code de combat, l'histoire
  change rétroactivement. C'est cohérent avec « le seul état officiel est
  ce que produit le moteur de référence à un commit donné », mais c'est
  surprenant pour un joueur qui revient.

## Alternatives considérées

### A. API REST partagée
Bonne UX (boot instantané) mais réintroduit le serveur et son admin.

### B. Node de validation P2P (libp2p, gossip)
Lourd, ralentit le projet. Pas justifié au scale actuel.

### C. Indexer dédié type Sandshrew/Ord
Possible plus tard pour accélérer le scan, mais introduit une dépendance à
un opérateur tiers. À envisager si la fréquence de joueurs explose.

## Liens

- Boot : `engine/boot-bitcoin.mjs:bootBitcoin()`
- Cache : `engine/cache.mjs`, `engine/cache-browser.mjs`, `engine/cache-node.mjs`
- Console : `console-live-bitcoin.html`
- ADRs liées : ADR-0001 (Mutinynet), ADR-0002 (YAML iso), ADR-0003 (identité)
