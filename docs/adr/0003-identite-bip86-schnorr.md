# ADR-0003 — Identité joueur = pubkey Schnorr Taproot (BIP-86)

- **Statut** : Accepted
- **Date** : 2026-02 (rétroactif)
- **Décideurs** : meffysto
- **Tags** : identite, securite

## Contexte

Aetheris (avant le fork bitcoin) utilisait Ed25519 applicatif : chaque joueur
générait une paire `ed25519`, et chaque ordre était signé puis vérifié par le
résolveur. Problèmes :

- Le joueur gérait DEUX clés : une clé jeu + un GitHub token. Onboarding lourd.
- Toute compromission du runner GH = capacité de fabriquer des signatures pour
  tous les joueurs (le runner détient les clés publiques mais pas une autorité
  de signature ; néanmoins il choisit ce qu'il valide).
- Une signature applicative n'a aucun lien cryptographique avec l'inscription
  qui la transporte. Un agent malveillant peut copier l'inscription d'un autre
  joueur tant que la signature interne matche.

Avec Bitcoin comme substrat (ADR-0001), on a déjà une identité crypto
indispensable pour signer la TX : la pubkey Schnorr (x-only) du witness
Taproot. Pourquoi en ajouter une seconde ?

## Décision

L'identité d'un joueur EST sa pubkey Schnorr Taproot (BIP-86, path
`m/86'/0'/0'/0/0`). Aucune signature applicative en plus. Au scan, le
résolveur extrait `inscriberPubKey` du leaf script Taproot de chaque
inscription. Pour un ordre du joueur P :

```
ordre.inscriberPubKey === identites[P].cle_publique
```

Toute discordance ⇒ rejet automatique. Le wallet est généré et stocké
localement : `.btc-key` (CLI) ou localStorage chiffré AES-GCM/PBKDF2 200k
itérations (browser).

## Conséquences

### Positives
- Une seule clé à gérer pour jouer (= wallet Bitcoin).
- L'identité est aussi sûre que Bitcoin lui-même : il faut briser Schnorr
  pour usurper un joueur, ce qui revient à briser Bitcoin.
- Surface d'attaque identique humain/agent : un bot signe une TX comme un
  humain, sans rien de plus.
- Onboarding "wallet first" : tu génères, tu reçois des sats faucet, tu joues.

### Négatives / à surveiller
- **Pas de multi-device** : un joueur ne peut pas jouer depuis 2 machines
  sans copier sa seed phrase (= risque). Mitigation prévue : ADR future sur
  `device_link` qui inscrirait une seconde pubkey valide pour signer.
- **Pas de récupération** : perte de la clé = perte définitive de l'empire.
  Pas de "mot de passe oublié". L'utilisateur doit comprendre cette propriété
  avant le premier `join`.
- **Pseudonymat ↔ pubkey** : la même pubkey reçoit aussi les sats du faucet.
  Un observateur de la chaîne peut faire des analyses tx-graph sur le wallet
  du joueur. Pas un problème de gameplay, mais à signaler aux joueurs
  attachés à leur vie privée.

## Alternatives considérées

### A. Garder Ed25519 applicatif en plus
Inutilement double : si la TX Bitcoin est validée par Schnorr, la sig
Ed25519 n'ajoute aucune garantie qu'un attaquant qui détient le wallet ne
peut pas déjà falsifier.

### B. Identité Nostr (pubkey secp256k1 séparée)
Possible mais découple identité-Nostr et identité-Bitcoin. Or on veut UNE
seule identité pour minimiser la friction. Mitigation : Nostr DM peut
réutiliser la même pubkey (cf ADR-0005).

### C. Multi-sig pour des "comptes corporate" (guildes IRL)
Hors scope MVP. À considérer si une équipe veut piloter un empire commun :
ils peuvent créer un wallet 2-of-3 et inscrire ensemble. Le protocole le
permet déjà sans modification — c'est juste un choix d'organisation.

## Liens

- Wallet : `engine/wallet-init-core.mjs`, `engine/wallet-init.mjs`
- Extraction pubkey : `engine/scan-bitcoin.mjs` (fonction d'extraction inscriberPubKey)
- Vérification : `engine/boot-bitcoin.mjs` (vérif pubkey-binding à chaque ordre)
