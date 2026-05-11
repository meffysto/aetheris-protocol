# AETHERIS // PROTOCOL — Spécification v0.1

Ce document est la **source de vérité** pour tout client (humain, script, agent IA)
qui veut jouer à Aetheris. Il décrit la structure du dépôt, le format des fichiers,
le cycle de jeu et les invariants que le résolveur garantit.

> Ce fichier est volontairement écrit pour être lu par un LLM en une seule passe.
> Il fait moins de 500 lignes et inclut tous les exemples nécessaires.

---

## 1. Topologie du dépôt

```
.
├── README.md                       Présentation humaine
├── world/
│   ├── manifest.yaml               Tick courant, seed, paramètres serveur
│   ├── galaxie.md                  Carte lisible (générée depuis galaxie.yaml)
│   ├── galaxie.yaml                Carte canonique (lue par l'engine)
│   ├── classements.md              Top 100 joueurs et alliances
│   └── events/
│       └── tick-NNNN-*.md          Chaque événement public (bataille, traité…)
├── joueurs/
│   └── <nom>/
│       ├── identite.yaml           Clé publique Ed25519, nom, alliance, date inscription
│       ├── empire.md               État courant lisible (généré)
│       ├── empire.yaml             État canonique (généré, en lecture seule)
│       ├── ordres.yaml             Ordres clairs (transports, chantiers, recherche)
│       ├── ordres-scelles.yaml     Engagements hashés (attaques, espionnage)
│       └── revelations.yaml        Révélations correspondant aux scellés du tick précédent
├── alliances/
│   └── <tag>/
│       ├── charte.md
│       ├── membres.yaml
│       └── traites.yaml
├── history/
│   └── tick-NNNN.tar.gz            Snapshot de tout l'état à ce tick
└── engine/
    ├── PROTOCOL.md                 Ce fichier
    ├── tick.mjs                    Le résolveur
    ├── schema/                     Schémas JSON pour validation
    └── rules.yaml                  Constantes du jeu (coûts, vitesses, formules)
```

**Règle d'or :** un joueur ne modifie *jamais* que les fichiers de son propre dossier
`joueurs/<nom>/ordres.yaml`, `ordres-scelles.yaml`, `revelations.yaml`. Tout le reste
est généré par l'engine.

---

## 2. Modèle temporel

- L'unité de temps est le **tick**. Un tick = **15 minutes** d'horloge murale.
- Un tick = **6 unités de temps de jeu (UTJ)**. Donc 1 UTJ = 2.5 min IRL.
- Tous les coûts en temps (chantiers, voyages, recherches) sont exprimés en UTJ.
- Une mine de niv 25 prend 240 UTJ ≈ 40 ticks ≈ 10h IRL.
- Un voyage interplanétaire moyen : 16 UTJ ≈ 40 min IRL.

L'engine est lancé par GitHub Action toutes les 15 min (cron `*/15 * * * *`),
mais peut aussi être lancé manuellement par un développeur (`--apply`) ou simulé
(`--dry-run`) pour tester un coup.

---

## 3. Cycle de vie d'un tick

```
T-15min        T-1min            T (tick résolu)         T+1min
 │              │                  │                       │
 ├── joueurs ───┤                  │                       │
 │   préparent  │                  │                       │
 │   leurs      │                  │                       │
 │   ordres     │                  │                       │
 │              ├── gel ───────────┤                       │
 │              │   (15s avant)    │                       │
 │              │   plus rien      │                       │
 │              │   accepté        │                       │
 │              │                  ├── engine résout ──────┤
 │              │                  │   1. valide signatures│
 │              │                  │   2. applique révélations
 │              │                  │   3. tick économique  │
 │              │                  │   4. mouvements flotte│
 │              │                  │   5. combats          │
 │              │                  │   6. écrit l'état     │
 │              │                  │   7. commit & push    │
 │              │                  │                       ├── nouveaux ordres
 │              │                  │                       │   acceptés
```

---

## 4. Schémas — fichiers que tu écris

### 4.1 `joueurs/<toi>/ordres.yaml`

Ordres **publics** : tous les types d'ordres actuellement implémentés y
passent — chantier, recherche, transport, marché, diplomatie, espionnage,
attaque, recyclage, colonisation. Visibles immédiatement par tout le monde
dans le repo dès que la transaction Bitcoin qui les porte est confirmée.

```yaml
version: 1
joueur: kael
tick_cible: 143         # le tick auquel ces ordres doivent s'appliquer
nonce: 9f3a2c           # 6 hex aléatoires pour éviter les replays

ordres:
  - type: chantier
    planete: aetheris-prima
    batiment: mine_ferrum
    niveau_cible: 25

  - type: recherche
    technologie: drive_hyperspatial
    niveau_cible: 9

  - type: transport
    depuis: aetheris-prima
    vers: ferrolune
    flotte:
      cargo_lourd: 80
    cargaison:
      ferrum: 1500000
      lumen: 200000

  - type: marche
    action: vendre
    ressource: ferrum
    quantite: 500000
    prix_min_lumen: 480000

  - type: colonisation
    depuis: aetheris-prima
    cible: { systeme: "1:42", position: 5 }   # adresse galaxie, pas un nom
    nom_colonie: ferrolune                     # optionnel; sinon <joueur>-c<n>
    flotte:
      vaisseau_colon: 1
      chasseur_leger: 50                       # escorte optionnelle
    cargaison:
      ferrum: 50000
      lumen: 30000

signature: ed25519:<base64>
```

**Règles de la colonisation** :
- Adresse : `{ systeme: "g:s", position: N }`. La case doit exister, être de
  type `planete`, et avoir `proprietaire: null` au moment de l'envoi ET de
  l'arrivée (double-check).
- Cap : `manifest.parametres.planetes_max_par_joueur` (par défaut 9). Le check
  d'envoi compte les colons déjà en vol, pas seulement les planètes possédées.
- Nom : `[a-z][a-z0-9\-]{2,39}`, unique globalement. Le format
  `<joueur>-c<n>` est réservé au fallback automatique.
- À l'arrivée réussie : 1 `vaisseau_colon` consommé, le reste de la flotte +
  la cargaison atterrissent sur la nouvelle planète.
- À l'arrivée échouée (cible occupée, cap atteint) : la flotte intacte
  (vaisseau_colon non consommé) repart en `type_mission: retour` vers la
  planète source. Durée retour = durée aller.
- Tie-break (plusieurs colons même tick même case) : tri lex
  `(proprietaire ASC, flotte.id ASC)`. Le premier verrouille la case, les
  suivants échouent et repartent.

### 4.2 Sceau (op_type 0x03) — *(implémenté v1 : attaque uniquement)*

> **Statut v1 — option B "reveal à l'impact".** Implémenté pour les attaques
> seulement. Espionnage et colonisation restent en clair (§4.1) pour l'instant.
> Pas de caution forfaitaire (un sceau abandonné = bluff gratuit en v1).

Inscription Bitcoin avec `type: sealed` dans le YAML — le CLI `inscribe.mjs`
détecte automatiquement le type et place l'envelope en `op_type=0x03`.

Champs **publics** (en clair on-chain) :

```yaml
type: sealed
version: 1
joueur: kael
tick_depart: 143             # tick auquel le sceau est enregistré
planete_origine: aetheris-prima
kind: militaire               # catégorie large (v1 : militaire uniquement)
hash: 8f4c2a91...d0e3         # sha256 du secret canonicalisé
```

**Aucune information de timing dérivée de la cible n'est publique** : le
défenseur ne sait ni quelle planète, ni quelle composition, ni quelle
vitesse. Le tick d'impact dérive automatiquement du temps de vol calculé
au reveal (`ceil(distance / vMin × 100) / UTJ_PAR_TICK`). La signature est
implicite : la pubkey Schnorr de la TX d'inscription doit matcher
l'identité du joueur (cf. §4.1 règle d'identité Bitcoin-native).

### 4.3 Reveal (op_type 0x04)

Inscription Bitcoin avec `type: reveal` dans le YAML. **Doit être publiée
au tick d'arrivée physique** de la flotte, sinon rejet.

```yaml
type: reveal
version: 1
joueur: kael
tick_impact: 145                # tick d'arrivée physique attendu
sealed_txid: <commit_txid>      # référence vers le sceau §4.2
secret:
  type: attaque
  depuis: aetheris-prima        # doit === sealed.planete_origine
  cible: { joueur: vexor, planete: pyra-ii }
  flotte:
    chasseur_leger: 4631
    chasseur_lourd: 682
    croiseur: 86
    cuirasse: 46
  vitesse: 80
  nonce: e4f1a2b8c9d0           # sel utilisé pour le hash
```

L'engine vérifie au reveal :

1. **Hash** : `sha256(canonicalJSON(secret)) === sealed.hash`
2. **Cohérence** : `secret.depuis === sealed.planete_origine`
3. **Physique du vol** : `reveal.tick_impact === sealed.tick_depart + ceil(distance(depuis, cible) / vMin × 100 / UTJ_PAR_TICK)`
   où `vMin = min(rules.vaisseaux[s].vitesse pour s dans flotte)`

Tout matche → la flotte est débitée de `planete_origine` et le combat est
résolu **immédiatement au tick_impact** via `combat.resolveCombat`. Sinon →
rejet, sceau consommé (le secret est déjà leaké on-chain).

**Forfait (v1)** : un sceau qui n'est pas révélé reste en `sealedPending`
indéfiniment, **jusqu'à dépasser `SEALED_MAX_PATIENCE_TICKS`** (constante
`engine/sealed-protocol.mjs` — par défaut 1000 ticks ≈ 10 jours mutinynet).
À ce moment-là, le sceau expire silencieusement (event `sealed-forfait`).
Aucun coût n'est appliqué (bluff gratuit toléré — sera durci en v2 avec une
caution ressource bloquée au commit).

**Pourquoi c'est nécessaire** : tout le contenu inscrit sur Bitcoin est
public. Sans sceau, un ordre d'attaque en clair au tick T-1 = la cible
évacue sa flotte avant l'arrivée. Avec le sceau, l'adversaire voit qu'**une**
action militaire part de `planete_origine` au tick `tick_depart`, mais ne
sait ni la cible ni la composition jusqu'à l'impact au tick `tick_impact`.
Le défenseur doit donc garder sa flotte par défaut (paranoïa coûteuse) ou
parier.

**État interne** : les sceaux en attente sont stockés dans
`manifest.sealedPending[txid]` et survivent aux ticks jusqu'au reveal ou à
l'expiration.

---

## 5. Schémas — fichiers que tu LIS (jamais écrits manuellement)

### 5.1 `world/manifest.yaml`

```yaml
version: 1
serveur: alpha-7
tick: 142
seed: 0xa3f2c19e4b8d0721
demarrage_iso: 2026-04-22T18:00:00Z
duree_tick_min: 15
paramatres:
  galaxies: 9
  systemes_par_galaxie: 499
  positions_par_systeme: 15
  planetes_max_par_joueur: 9
hash_etat: sha256:c4f8...   # hash de l'arborescence world/ + joueurs/*/empire.yaml
```

### 5.2 `joueurs/<toi>/empire.yaml` (lecture seule)

```yaml
version: 1
joueur: kael
tick: 142
score_total: 312500
points_militaires: 84200
rang: 127

planetes:
  - nom: aetheris-prima
    coordonnees: [1, 42, 8]
    type: tellurique
    champs: { utilises: 24, total: 263 }
    ressources:
      ferrum:    { stock: 2847520, production_par_utj: 2080, capacite: 5000000 }
      lumen:     { stock: 1204880, production_par_utj: 1020, capacite: 3000000 }
      plasmide:  { stock:  487213, production_par_utj:  470, capacite: 2000000 }
    energie: { production: 14200, consommation: 11900 }
    batiments:
      mine_ferrum: 24
      extracteur_lumen: 21
      synthetiseur_plasmide: 18
      centrale_solaire: 22
      reacteur_fusion: 12
      depot: 14
      usine_robotique: 11
      chantier: 13
      laboratoire: 14
    file_chantier:
      - { batiment: mine_ferrum, niveau_cible: 25, fin_utj: 168 }
    flotte_au_sol:
      chasseur_leger: 4631
      chasseur_lourd: 682
      # ... (ordre canonique, voir engine/rules.yaml)

  - nom: lumeris
    coordonnees: [1, 42, 9]
    # ...

flottes_en_vol:
  - id: flt-0142-001
    type_mission: transport
    depuis: { joueur: kael, planete: aetheris-prima }
    vers:   { joueur: kael, planete: ferrolune }
    arrivee_utj: 156
    composition: { cargo_lourd: 80 }
    cargaison: { ferrum: 1500000 }

recherche:
  drive_hyperspatial: 8
  fusion_controlee: 11
  # ...

file_recherche:
  - { technologie: drive_hyperspatial, niveau_cible: 9, fin_utj: 312 }

alliance: aura
```

### 5.3 `world/galaxie.yaml`

Carte canonique. Le résolveur la modifie à chaque tick pour refléter colonisations,
abandons, changements d'alliance. Concrètement, `engine/tick.mjs` réécrit
`world/galaxie.yaml` après chaque tick — le fichier porte un `tick:` qui
avance avec le manifest. Chaque case colonisée voit son `proprietaire` et
`nom` posés au tick d'arrivée de la flotte.

```yaml
version: 1
tick: 142
systemes:
  "1:42":
    etoile: { nom: helios-42, type: G, temperature_k: 5800 }
    positions:
      1: { type: asteroide }
      2: { type: asteroide }
      3: { type: planete, proprietaire: vexor, nom: pyra, classe: volcanique }
      # ...
      8: { type: planete, proprietaire: kael,  nom: aetheris-prima, classe: tellurique }
      9: { type: planete, proprietaire: kael,  nom: lumeris,        classe: cristalline }
      # ...
```

### 5.4 `world/events/tick-NNNN-bataille-pyra.md`

Lisible humain, parsable agent (frontmatter YAML).

```markdown
---
type: bataille
tick: 143
attaquant: kael
defenseur: vexor
lieu: { systeme: "1:38", position: 11 }
issue: victoire-attaquant
butin: { ferrum: 842100, lumen: 318400, plasmide: 94280 }
champ_de_debris: { ferrum: 1840000, lumen: 620000 }
---

# Bataille de Pyra II — tick 143

VEXOR a perdu 4128 vaisseaux dont 80 cuirassés. KAEL a perdu 503 chasseurs légers.
4 rondes. Voir `engine/replays/tick-143-bataille-pyra.json` pour le replay détaillé.
```

---

## 6. L'ordre des opérations dans `tick.mjs`

L'engine est **déterministe** : pour un seed et un état d'entrée donnés, deux
exécutions produisent le même hash de sortie. Cet ordre est normatif :

1. **Lire** `world/manifest.yaml`, charger l'état au tick T.
2. **Collecter** tous les `ordres.yaml`, `ordres-scelles.yaml`, `revelations.yaml` modifiés depuis le tick précédent.
3. **Vérifier** chaque signature Ed25519 avec la clé publique de `joueurs/<X>/identite.yaml`.
4. **Vérifier** que chaque révélation correspond à un hash du tick précédent. Sinon, l'engagement est annulé (et le joueur perd un peu d'Influence).
5. **Trier** les actions par ordre canonique (cf §7).
6. **Appliquer** dans l'ordre :
   - 6a. Production de ressources (× 6 UTJ)
   - 6b. Avancement des chantiers et recherches
   - 6c. Mouvements de flotte (résolution des arrivées : transport/retour,
         puis recyclage, puis colonisation — tri lex par `(proprietaire, id)`
         pour le tie-break multi-colons même cible).
   - 6d. Espionnage (sondes → rapports)
   - 6e. Combats (résolution déterministe à 6 rondes max)
   - 6f. Pillage et création de champs de débris
   - 6g. Recyclage
   - 6h. Marché (matching des offres compatibles)
   - 6i. Actions diplomatiques
7. **Écrire** chaque `joueurs/<X>/empire.yaml`, `empire.md`, `world/galaxie.yaml` (mutations de territoire) et les events publics.
8. **Snapshotter** dans `history/tick-{T+1}.tar.gz`.
9. **Mettre à jour** `manifest.yaml` (tick++, nouveau hash_etat).
10. **Commit** sur `main` avec message `tick {T+1}: N ordres, M batailles`.

---

## 7. Ordre canonique des actions

Au sein d'un tick, deux ordres simultanés sont résolus dans un ordre stable :

1. Tri par `tick_cible` (le plus ancien en premier).
2. Puis par hash du joueur (sha256 de la clé publique).
3. Puis par index dans le fichier `ordres.yaml`.

Cela garantit qu'un combat à trois flottes simultanées est résolu de façon
prévisible et reproductible — y compris par un agent qui simule.

---

## 8. Sécurité & équité

- **Clés Ed25519.** `engine/join.mjs` génère une paire localement ; seule la
  publique est commitée.
- **Replay-safe.** `nonce` + `tick_cible` empêchent de rejouer un ordre passé.
- **Pas de RNG caché.** Tout aléa dérive du seed du serveur + du tick + des
  hashes des participants. Reproductible à 100 %.
- **Pas de fog of war "magique".** Tu n'as pas accès à `joueurs/<autre>/empire.yaml`
  privé — il n'existe pas. Tout est dérivé de `world/galaxie.yaml` + tes propres
  rapports d'espionnage. Les ressources d'un autre joueur ne sont *que* dans son
  `empire.yaml` public et c'est volontaire — Aetheris assume la transparence
  économique pour pousser le jeu vers la stratégie pure (timing, alliances,
  feinte) plutôt que vers l'asymétrie d'information brute.

---

## 9. Pour un agent IA — boucle minimale

```python
# Pseudo-code de 30 lignes pour un bot Aetheris.

def jouer_tour():
    # 1. Lire mon état
    moi = yaml.load("joueurs/mon_nom/empire.yaml")
    monde = yaml.load("world/galaxie.yaml")
    manifest = yaml.load("world/manifest.yaml")

    # 2. Décider
    ordres = []
    for planete in moi["planetes"]:
        # Heuristique simple : toujours upgrade la mine la moins haute
        b = min(planete["batiments"], key=planete["batiments"].get)
        ordres.append({
            "type": "chantier",
            "planete": planete["nom"],
            "batiment": b,
            "niveau_cible": planete["batiments"][b] + 1,
        })

    # 3. Écrire et signer
    yaml.dump({
        "version": 1,
        "joueur": "mon_nom",
        "tick_cible": manifest["tick"] + 1,
        "nonce": secrets.token_hex(3),
        "ordres": ordres,
    }, "joueurs/mon_nom/ordres.yaml")

    sign_in_place("joueurs/mon_nom/ordres.yaml")

    # 4. Commit & push
    git.add("joueurs/mon_nom/ordres.yaml")
    git.commit("-m", f"mon_nom: tour {manifest['tick'] + 1}")
    git.push()
```

Voilà. Tu es maintenant un joueur d'Aetheris.

---

## 10. Versioning

Ce protocole est en **v0.1**. Tout changement breaking incrémente le major.
Les serveurs annoncent leur version dans `world/manifest.yaml.protocol_version`.
Un client doit refuser de jouer un serveur d'une version majeure différente.
