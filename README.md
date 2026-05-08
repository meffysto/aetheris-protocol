# CITADEL // PROTOCOL

> Un MMO 4X spatial 100% Bitcoin-native.
> Pas de serveur central. Pas de base de données. L'état du jeu vit on-chain.
> Chaque bloc Mutinynet = un tour. Les ordres sont des inscriptions Taproot.

```
   ◉  SERVEUR              citadel-mvp-1 (Mutinynet)
   ⛓  BLOC GENESIS          3 084 991
   ⏱  PROCHAIN BLOC          ~30s à 2min (Mutinynet)
   🔑 IDENTITÉ              pubkey Schnorr du witness Bitcoin
   📜 ORDRES                inscriptions Taproot (commit + reveal)
```

## Le pitch

CITADEL est un fork Bitcoin-native d'[Aetheris Protocol](./README-AETHERIS-LEGACY.md).
Là où Aetheris vivait dans un repo Git, CITADEL vit dans la blockchain Mutinynet
(signet Bitcoin). Aucun serveur ne détient l'état canonique : il est dérivé en
rejouant les inscriptions depuis le bloc genesis.

- **Pas de backend.** Le navigateur scanne Mutinynet, extrait les inscriptions
  CITADEL, rejoue les ordres, calcule l'état. Le serveur de jeu, c'est Bitcoin.
- **Pas de comptes.** Ta pubkey Schnorr (witness Taproot) = ton identité. Aucune
  signature applicative, aucun compte à créer. Tu inscris, donc tu joues.
- **Anti-triche cryptographique.** Au scan, on vérifie que `orders[player].inscriberPubKey`
  correspond bien à l'identité enregistrée. Un ordre frauduleux = REJET automatique.
- **IA-native.** Un agent peut lire l'état, signer une inscription Taproot avec
  sa propre clé, broadcaster sur Mutinynet. Surface identique humain/agent.

## Architecture

```
   ┌──────────────────────────────────────────────────────────────┐
   │  BITCOIN (Mutinynet) = serveur de jeu                         │
   │                                                               │
   │  Chaque ordre = inscription Taproot (commit + reveal)         │
   │  Chaque join  = inscription identité (pubkey + nom)           │
   │  Genesis      = inscription du seed univers (bloc 3 084 991)  │
   └──────────────────────────────────────────────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  NAVIGATEUR (console-live-bitcoin.html)                       │
   │  1. Scan Mutinynet depuis genesis (cache IndexedDB)           │
   │  2. Extrait inscriptions CITADEL des leaf scripts Taproot     │
   │  3. Rejoue runTick() bloc par bloc → état déterministe        │
   │  4. Affiche map, empire, ordres pending                       │
   │  5. Submit ordre → commit+reveal → broadcast Mutinynet        │
   └──────────────────────────────────────────────────────────────┘
```

Le moteur (`engine/tick-core.mjs`, 1500+ lignes) est **isomorphe** : il tourne
identique en Node et dans le navigateur. C'est ce qui permet à n'importe qui
de vérifier l'état localement.

## Comment jouer (3 étapes)

```bash
# 1. Génère un wallet Bitcoin et obtiens des sats Mutinynet
#    → https://faucet.mutinynet.com/

# 2. Inscris ton join sur Mutinynet (ouvre dans le navigateur)
#    → https://meffysto.codeberg.page/aetheris-protocol/join-bitcoin.html

# 3. Joue depuis la console
#    → https://meffysto.codeberg.page/aetheris-protocol/console-live-bitcoin.html
```

Voir [`docs/HOW-TO-PLAY.md`](docs/HOW-TO-PLAY.md) pour le détail.

## Architecture iso (browser + Node)

```
engine/
├── tick-core.mjs          runTick() pure, tickFromBlockHeight, yparse/ystringify
├── tick.mjs               wrapper CLI Node
├── inscribe-core.mjs      commit+reveal Taproot (iso)
├── inscribe.mjs           CLI Node (ordres)
├── inscribe-join.mjs      CLI Node (joins)
├── scan-bitcoin.mjs       scanner Mutinynet, extrait inscriberPubKey
├── boot-bitcoin.mjs       orchestrator browser (scan → replay → state)
├── world-init-core.mjs    spawnEmpireFromJoin() iso
├── wallet-init-core.mjs   BIP-86 iso
├── wallet-init.mjs        CLI Node
├── combat.mjs             résolution combat (iso)
├── cache.mjs              storage abstraction (cache-node + cache-browser)
└── rules.yaml             constantes (coûts, vitesses, formules)
```

## Identité Bitcoin-native

Pas de signature applicative. La pubkey Schnorr du witness Taproot = identité du joueur.

```yaml
# joueurs/meff/identite.yaml (généré au scan)
nom: meff
inscriberPubKey: 5cb4da974b1fc38ab710729c6c3fba911bb40ab924bca1103cecace80bd5d6b7
genesis_block: 3085121
```

Au scan, `boot-bitcoin.mjs` extrait `inscriberPubKey` du leaf script Taproot et
vérifie que `orders[player].inscriberPubKey === identites[player].cle_publique`.
Toute discordance → ordre rejeté.

## Statut MVP

```
[████████████████████░░] MVP Bitcoin — 90%
 ✓ Genesis on-chain (bloc 3 084 991)
 ✓ Inscriptions join + ordres (commit + reveal Taproot)
 ✓ Scanner Mutinynet (cache IndexedDB v2)
 ✓ Boot browser : scan → replay → state
 ✓ Wallet AES-GCM/PBKDF2 200k (chiffré localStorage)
 ✓ Console live + auto-refresh 15s
 ✓ Anti-triche pubkey-binding
 ✓ Tests E2E + déterminisme + fuzz
 ◯ Onboarding tutoriel in-app
 ◯ Cloche notifications
```

## Pour les développeurs

```bash
# Tests
node --test tests/

# Server dev local
python3 -m http.server 8765
# → http://localhost:8765/

# Tick CLI (rejoue à partir d'un bloc Mutinynet)
node engine/tick.mjs --from-block 3084991
```

## Déploiement

```bash
git push codeberg bitcoin/mvp:pages
# → https://meffysto.codeberg.page/aetheris-protocol/
```

## Voir aussi

- [`engine/PROTOCOL.md`](engine/PROTOCOL.md) — spec lisible par les agents
- [`docs/HOW-TO-PLAY.md`](docs/HOW-TO-PLAY.md) — guide 3 étapes détaillé
- [`CONTEXT.md`](CONTEXT.md) — vocabulaire et invariants du domaine
- [`docs/adr/`](docs/adr/) — décisions d'architecture
