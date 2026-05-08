# Comment jouer à CITADEL

Tu vas inscrire ton empire **directement dans la blockchain Mutinynet** (le testnet
Bitcoin "rapide", ~30s par bloc). Aucun compte, aucun email, aucun serveur.
Ta pubkey Bitcoin = ton identité.

## Étape 1 — Obtenir des sats Mutinynet (gratuit)

1. Ouvre [https://meffysto.codeberg.page/aetheris-protocol/join-bitcoin.html](https://meffysto.codeberg.page/aetheris-protocol/join-bitcoin.html)
2. Le stepper te génère un wallet Taproot (BIP-86) chiffré dans ton navigateur.
   **Note ta phrase de récupération.** Si tu la perds, ton empire est perdu.
3. Copie ton adresse `tb1p...` et colle-la sur [https://faucet.mutinynet.com/](https://faucet.mutinynet.com/)
4. Attends ~1 bloc (~30s à 2min). Vérifie que les sats arrivent dans la console du stepper.

> Tu auras besoin d'environ **5000 sats** pour le join + plusieurs ordres.

## Étape 2 — Inscrire ton join

1. Toujours sur `join-bitcoin.html`, choisis ton nom d'empire (4-20 caractères).
2. Clique **Inscrire**. Le stepper construit deux transactions :
   - **Commit** : envoie tes sats vers une adresse Taproot dont le script contient
     ton inscription CITADEL.
   - **Reveal** : dépense ce commit en révélant le script. C'est cette transaction
     qui rend ton join visible aux autres joueurs.
3. Attends 1-2 blocs de confirmation. Le scanner du jeu détectera ton join au prochain
   passage (sa pubkey Schnorr du witness = ton identité dans le jeu).

## Étape 3 — Jouer depuis la console

1. Ouvre [https://meffysto.codeberg.page/aetheris-protocol/console-live-bitcoin.html](https://meffysto.codeberg.page/aetheris-protocol/console-live-bitcoin.html)
2. Importe ton wallet (ou laisse le navigateur le retrouver — il est dans le `localStorage`
   chiffré par AES-GCM/PBKDF2).
3. Dérouille la map : tes systèmes, tes flottes, tes ressources.
4. Soumets un ordre (production, mouvement, recherche). Chaque ordre est une nouvelle
   inscription Taproot. Confirmation prend 1-2 blocs.
5. **Chaque bloc Mutinynet = un tour de jeu.** Tes ordres confirmés au bloc N sont
   appliqués dans l'état au bloc N+1.

## FAQ

**Q. C'est de l'argent réel ?**
Non. Mutinynet est un signet (testnet Bitcoin avec des blocs rapides). Les sats que
tu obtiens du faucet n'ont aucune valeur monétaire.

**Q. Je peux jouer depuis un autre appareil ?**
Oui — réimporte ta phrase de récupération dans la console. Le wallet sera redécodé,
le scanner reconstruira ton état depuis le bloc genesis.

**Q. Si je triche ?**
Tu peux pas. Les ordres sont signés par le witness Taproot ; au scan, le moteur
vérifie que la pubkey du witness correspond à l'identité du join. Inscrire un
ordre au nom de quelqu'un d'autre est cryptographiquement impossible (sauf à
voler sa clé privée — ce qui n'est pas un problème de protocole).

**Q. Pourquoi Mutinynet et pas mainnet ?**
Coûts réels en sats trop élevés pour un MVP. Mutinynet a la même surface technique
(Taproot, inscriptions, witness Schnorr) avec des frais nuls et des blocs ~60×
plus rapides.

## Voir aussi

- [`README.md`](../README.md) — pitch et architecture
- [`engine/PROTOCOL.md`](../engine/PROTOCOL.md) — spec pour agents IA
