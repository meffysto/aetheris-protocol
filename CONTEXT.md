# CONTEXT — Vocabulaire et invariants de CITADEL

> Document de référence pour comprendre le domaine sans lire 10 KLOC.
> Public cible : nouveaux contributeurs, agents IA, joueurs curieux.
> Si tu modifies une définition ici, c'est probablement un changement de gameplay
> qui mérite un ADR (`docs/adr/`).

---

## 1. Le monde en une phrase

CITADEL est un 4X spatial où l'état du jeu vit on-chain sur Mutinynet (signet
Bitcoin), où chaque joueur est identifié par sa pubkey Schnorr Taproot, et où
chaque ordre est une inscription Bitcoin (commit + reveal). Aucun serveur central
ne détient l'état canonique — tout client le dérive en rejouant les inscriptions
depuis le bloc genesis.

---

## 2. Temps

| Terme | Définition |
|---|---|
| **bloc** | Bloc Bitcoin Mutinynet. ~30 s d'horloge murale en moyenne. |
| **tick** | Unité fondamentale de résolution du jeu. 1 tick = `blocs_par_tick` blocs (paramétré par la genesis). Tout tick T correspond à un intervalle de blocs `[bloc_genesis + T·b ; bloc_genesis + (T+1)·b)`. |
| **UTJ** *(unité de temps de jeu)* | Sous-division d'un tick. 1 tick = `duree_utj_par_tick` UTJ (6 par défaut). Les coûts en temps (chantier, voyage, recherche) sont exprimés en UTJ. |
| **tick_courant** | `tickFromBlockHeight(tip, bloc_genesis, blocs_par_tick, 0)` — calculé déterministiquement à partir du tip Bitcoin. |
| **tick_cible** | Tick d'application déclaré dans un ordre. Un ordre inscrit au bloc B s'applique au tick correspondant à B (les anciennes notions de "tick visé future" héritées de la version Git sont obsolètes). |

**Invariant temporel** : pour un même `bloc_genesis` et `blocs_par_tick`, tous
les clients calculent le même `tickFromBlockHeight` pour un tip donné. Aucune
horloge serveur ne fait foi.

---

## 3. Identité

| Terme | Définition |
|---|---|
| **inscriberPubKey** | Pubkey Schnorr (x-only, 32 octets hex) extraite du witness Taproot de l'inscription. C'est l'identité cryptographique d'un joueur. |
| **identite** | Mapping `{ nom, cle_publique: "schnorr:<pubkey>" }` créé au premier `join` valide d'un joueur. Stocké en mémoire après replay (jamais persisté côté serveur — n'a pas de serveur). |
| **join** | Inscription `op_type=0x01` qui revendique un nom de joueur. Le premier `join` valide pour un nom donné fixe l'identité. Les `join` suivants pour le même nom sont rejetés. |
| **wallet** | BIP-86 Taproot (m/86'/0'/0'/0/0). Stocké chiffré (AES-GCM, PBKDF2 200k itérations) en localStorage côté navigateur, ou en fichier `.btc-key` côté CLI. |
| **anti-triche pubkey-binding** | À chaque ordre, le scanner vérifie que `ordre.inscriberPubKey === identite[joueur].cle_publique`. Discordance ⇒ rejet automatique au replay. |

**Invariant d'identité** : tant qu'un client peut signer une inscription
Taproot avec la pubkey d'un joueur, il EST ce joueur. La perte de la clé
privée = perte définitive de l'empire (cf. ADR-0006 multi-device en backlog).

---

## 4. Espace

| Terme | Définition |
|---|---|
| **galaxie** | L'univers entier. Une seule par serveur. Définie dans `world/galaxie.yaml` au tick 0, puis mutée par les colonisations/abandons. |
| **système** | Sous-ensemble de la galaxie, clé `"g:s"` (ex `"12:-4"`). Contient une étoile et 15 positions. |
| **étoile** | `{ nom, type, temperature_k }` au centre du système. Influence la production de certaines ressources (température dans la formule du plasmide). |
| **position** | Slot 1..15 dans un système. Type : `empty` | `asteroide` | `planete`. |
| **planète** | Position de type `planete`. Possède une `classe` (tellurique, cristalline, glacée, volcanique, gazeuse) qui module les rendements, un `nom` unique global, et un `proprietaire` (ou `null` si libre). |
| **coord pleine** | `"g:s:p"` (ex `"12:-4:3"`) — identifie une planète. C'est ce qu'on stocke dans `empire.planetes[].coordonnees`. |
| **distance** | Calculée entre deux planètes pour les vols. Détermine la durée de voyage en UTJ. |

**Invariant spatial** : `world/galaxie.yaml` est la source de vérité du
peuplement. Toute case avec `type: planete` ET `proprietaire != null` doit
correspondre à une entrée dans l'`empire.yaml` du joueur cité. Le replay
maintient cet invariant à chaque tick.

---

## 5. Économie

| Terme | Définition |
|---|---|
| **ressources** | `ferrum`, `lumen`, `plasmide`. Trois ressources, asymétriquement avantagées par classes de planète. |
| **mine_ferrum / extracteur_lumen / synthetiseur_plasmide** | Bâtiments de production. Formule `floor(production_base * niveau * 1.1^niveau * bonus_planete)` par UTJ. |
| **bonus_planete** | Multiplicateur de classe (tellurique +30% Fe, cristalline +30% Lu, volcanique +30% Pl). |
| **énergie** | Production des centrales et réacteurs. Si `consommation > production`, les mines tournent au ratio (pénalité économique). |
| **capacité (dépôt)** | Plafond de stockage. Au-delà, la production est perdue. |
| **chantier** | File d'amélioration de bâtiments. 1 file par planète. Durée en UTJ, accélérée par `usine_robotique`. |
| **recherche** | Tech globale au joueur (pas par planète). Accélérée par `laboratoire`. |

---

## 6. Flotte et combat

| Terme | Définition |
|---|---|
| **vaisseau** | Unité construite à l'atelier (`chantier_spatial` côté UI, voir `rules.yaml.vaisseaux`). Ordre canonique fixe pour la reproductibilité des combats. |
| **flotte_au_sol** | Vaisseaux stationnés sur une planète. Disponibles pour mission. |
| **flotte_en_vol** | Vaisseaux en transit. Stocke `depuis`, `vers`, `type_mission`, `tick_arrivee`, `composition`, optionnellement `cargaison`. |
| **type_mission** | `transport` \| `attaque` \| `siege` \| `pillage` \| `bombardement` \| `espionnage` \| `colonisation` \| `recyclage` \| `retour`. |
| **mission hostile** | `attaque`, `siege`, `pillage`, `bombardement`, `espionnage`. Doit passer par un sceau (cf §7) pour ne pas révéler la cible à l'avance. |
| **résolution combat** | Déterministe, 6 rondes max. Voir `engine/combat.mjs`. Pas de RNG : l'aléa éventuel dérive du seed + tick + composition. |
| **champ de débris** | Création post-bataille au-dessus de la cible. Récupérable par mission `recyclage`. |

---

## 7. Sceaux (commit-reveal)

| Terme | Définition |
|---|---|
| **sealed** | Inscription `op_type=0x03`. Annonce publique qu'un joueur prépare une action militaire depuis une planète d'origine, au tick T. Le contenu de l'action est haché (sha256). |
| **reveal** | Inscription `op_type=0x04`. Inscrite au tick d'impact physique. Doit hasher exactement comme le sealed correspondant, et le tick d'impact doit cohabiter avec la physique du vol (`distance / vMin`). |
| **option B "reveal à l'impact"** | Le tick d'impact n'est PAS déclaré au sealing. Il dérive de la distance et de la vitesse de la flotte. Le défenseur n'apprend NI cible NI composition avant l'impact. |
| **patience** | `SEALED_MAX_PATIENCE_TICKS = 1000`. Au-delà, un sceau non révélé expire silencieusement (bluff gratuit en v1, sera coûteux en v2). |

**Invariant cryptographique** : `sha256(canonicalJSON(reveal.secret)) === sealed.hash`.
Toute déviation ⇒ rejet et sceau consommé (le secret est on-chain donc leaké).

---

## 8. Inscriptions Bitcoin — types d'opérations

| `op_type` | Nom | Contenu |
|---|---|---|
| `0x01` | join | `{ joueur, ... }` — revendique un nom |
| `0x02` | order | `{ joueur, ordres: [...] }` — actions publiques (chantier, recherche, transport, colonisation, …) |
| `0x03` | sealed | `{ joueur, tick_depart, planete_origine, kind, hash }` — engagement haché |
| `0x04` | reveal | `{ joueur, tick_impact, sealed_txid, secret: {...} }` — révélation |

Le préfixe d'enveloppe est `'aeth'` (hex `61657468`). Le scanner extrait ces
4 octets en début de payload pour distinguer une inscription CITADEL d'une
inscription Ordinals classique.

---

## 9. État dérivé et déterminisme

| Terme | Définition |
|---|---|
| **état** | Tuple `(manifest, empires, galaxie, identites, sealedPending)` au tick T. Entièrement dérivable du seed + suite des inscriptions. |
| **runTick(state, orders)** | Fonction pure. `runTick(state_T, orders_T) = state_{T+1}`. Aucune mutation en place, aucun I/O. |
| **canonicalJSON** | Sérialisation déterministe (clés triées, espaces fixés) utilisée pour les hashes et les signatures. |
| **isomorphe** | `tick-core.mjs` tourne identiquement en Node et dans le navigateur. C'est la garantie que tout joueur peut vérifier l'état localement avec les mêmes outils que le moteur de référence. |

**Invariant de reproductibilité** : pour un `(bloc_genesis, rules.yaml,
galaxie tick 0, suite d'inscriptions valides)` donné, tout client produit
exactement le même état au tick T. C'est ce qui remplace la confiance dans un
serveur.

---

## 10. Glossaire rapide (autres termes qui reviennent)

- **agglo** — pas utilisé ici (terme du sister-project éventuel).
- **espionnage** — mission qui ne déclenche pas de combat mais produit un
  rapport intel (visible du défenseur sous forme d'alerte).
- **roster** — ensemble des pubkeys Schnorr connues. Sert au routage Nostr DM.
- **Nostr DM** — canal de message privé (kind=4) entre joueurs, identifié par
  la même pubkey. Pas requis pour jouer, mais branché.
- **sealedPending** — index des sceaux dont le reveal n'est pas encore arrivé.
  Stocké dans le manifest et survit aux ticks.
- **events** — sortie observable d'un tick : batailles, alertes, intel,
  forfaits. Pas (encore) inscrits on-chain — recalculés à chaque replay.

---

## 11. Pour aller plus loin

- `engine/PROTOCOL.md` — spec exhaustive (cible : LLM en une passe).
- `docs/adr/` — décisions d'architecture historiques et leurs raisons.
- `engine/rules.yaml` — constantes équilibrage (coûts, bonus, formules).
- `tests/` — exemples concrets de chaque phase de tick.
