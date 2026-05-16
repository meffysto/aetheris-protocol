# Roadmap — 500 commandants en 3 mois

> Branche `bitcoin/vivant`. Objectif : porter CITADEL de **MVP fonctionnel
> mais inerte** à **jeu vivant, viral, joué tous les jours**. Cible : 500
> commandants actifs simultanément dans les 90 jours.

---

## Diagnostic — pourquoi le MVP n'attire personne (encore)

Le MVP Bitcoin est techniquement spectaculaire (engine déterministe
isomorphe, inscriptions Taproot, replay sans serveur), mais **le gameplay
de surface est inerte** :

1. **Cadence brutale (15 min/tick)** sans rien à faire entre deux ticks.
   Cookie Clicker te garde par les yeux toutes les 5 s. OGame par les
   alertes push toutes les 4 h. CITADEL te demande de revenir 15 min plus
   tard pour... cliquer un autre bouton. Mort par ennui.
2. **Aucun spectacle.** La carte galactique est SVG plate. Les flottes
   sont des lignes pointillées. Les batailles n'ont pas de replay. Aucune
   image ne donne envie de partager.
3. **Pas de social.** Tu ne vois pas ce que les autres font. Pas de fil
   d'actualité, pas de classement vivant, pas de chat. Un MMO doit
   donner *l'impression* qu'il est peuplé même quand il ne l'est pas.
4. **Pas de viralité.** Aucun bouton "partage", aucun export visuel,
   aucun lien d'invite, aucune storyline. On ne peut pas tweeter.
5. **Onboarding aride.** Le tutoriel 5 étapes explique la mécanique mais
   ne *séduit* pas. Manque l'émerveillement initial.

## Stratégie — les 3 leviers du pack "Vivant"

### 1. Levier d'engagement (anti-ennui inter-tick)

**Le Pont de commandement.** Mini-clicker local 100 % cosmétique,
intégré au top de la vue Aperçu. Tu cliques sur la planète, ça gagne
des "scans" et des "rations". Combo system, rangs (cadet → grand-amiral),
SFX rétro Web Audio. **Aucun impact engine, zéro inscription, pur
fluff** — mais ça donne quelque chose à faire pendant les 15 min, et
ça t'engage par la dopamine pixel.

Cf `client/idle-clicker.mjs`.

### 2. Levier de spectacle (3D + animations)

**Vue Pulse · galaxie 3D.** Nouvelle entrée de nav (✦ Pulse · 3D). La
galaxie réelle (état dérivé du replay) rendue en Three.js : orbites,
planètes par classe (couleur), anneaux pour les gazeuses, halos pour
ta planète et les ennemies, trails 3D pour les flottes hostiles
incoming. Glisse pour orbiter, zoom à la molette, clic pour identifier
un corps.

Cf `client/galaxy3d.mjs`.

**Landing page 3D.** `index-vivant.html` remplace `index.html` (ou se
juxtapose). Hero plein écran avec une mini-galaxie animée Three.js,
tickers live (bloc Mutinynet, tick courant), CTA "Inscrire mon empire".

### 3. Levier de viralité (achievements + cartes partageables)

**Codex.** Nouvelle vue (📖 Codex). Une grille d'achievements évalués
en local contre l'état on-chain :

- Premier souffle (join)
- Première extraction, foreur, magnat (mine niv 2/5/10)
- Premier breakthrough (1re recherche)
- Forces stellaires (1er vaisseau)
- Tacticien (1er sealed)
- Œil galactique (espionnage profond)
- Colon (2e planète), Imperator (5 planètes)
- Top 10 galactique

**Carte commandant.** Génération PNG canvas 1200×630 (taille Twitter
card) : pseudo, rang, planètes, niveaux totaux, achievements,
ferrum, devise. Bouton "Télécharger" et "Tweeter" (intent URL).

Cf `client/achievements.mjs`, `client/share-card.mjs`.

### Bonus : fil galactique + SFX

- **Fil galactique** (panneau "Aperçu") : timeline des events publics
  dérivés de l'état (joins, sealed, flottes en vol, colonisations).
  Donne l'impression de vie sans interroger un serveur.
- **SFX Web Audio** : générés par oscillateurs (pas de fichiers).
  Beep tap, fleet-launch, build-done, alert, achievement-fanfare.
  Opt-in via le bouton du Codex.

---

## Plan d'acquisition — 90 jours

### Semaine 1-2 : finir le pack vivant + récup'

- [x] Branche `bitcoin/vivant`
- [x] Bridge (clicker tactique)
- [x] Vue 3D Pulse (Three.js)
- [x] Codex achievements + carte commandant
- [x] Fil galactique + SFX
- [x] Landing page animée
- [ ] Tester sur 3 navigateurs (Chrome, Safari, Firefox) + mobile
- [ ] Régler les frictions de l'onboarding (1 clic faucet, qr-code wallet, etc.)
- [ ] Tutoriel "histoire" : storyline mini (un PNJ "l'Émissaire" donne
      les premières quêtes). Pas de PNJ réel — juste du flavor text.

### Semaine 3-4 : *seed* social

- [ ] Inviter 30 amis × 5 cercles = **150 testeurs** (Discord crypto,
      r/Bitcoin, BitDevs locaux, lounge Nostr).
- [ ] Préparer **3 tweets fil** chacun avec une carte commandant et
      un GIF de la vue Pulse 3D. Cible : showcase "no server, no
      account, just my pubkey".
- [ ] Demande de cross-post Hacker News : *"Show HN: A 4X MMO that
      lives entirely in Bitcoin signet"*. Angle technique (pas marketing).
- [ ] Article Medium / hashnode : *"How I built a deterministic MMO
      on Bitcoin without a server"*.

### Semaine 5-8 : *retention loops*

- [ ] Push notifications déjà en place — ajouter "ton voisin t'attaque
      dans 2 ticks" depuis les sealed (révèle après impact).
- [ ] Daily quests cosmétiques (Codex : "scanne 100× aujourd'hui", "joue
      à 3 ticks différents"). Pure cosmétique, pas de coût on-chain.
- [ ] Vidéo timelapse : un client headless rejoue la chaîne depuis
      genesis et exporte un MP4 d'un mois compressé en 60 s. Asset
      viralisable.

### Semaine 9-12 : *waves & events*

- [ ] **Premier event galactique** : "Le Réveil". Une faction PNJ
      (sans IA, juste des inscriptions auto signées par un wallet
      neutre publié) apparaît à un système central, donne des récompenses
      cosmétiques au top 10 attaqueurs.
- [ ] **Alliance v0** : `op_type=0x05` (déjà conçue), accord public
      d'entraide. Permet le classement par alliance.
- [ ] **Marché actif** : campagne pour bootstraper les ratios — un
      "market maker" altruiste (un autre wallet neutre).

---

## Métriques de succès

| KPI | T+30 j | T+60 j | T+90 j |
|---|---|---|---|
| Joueurs ayant `join` | 80 | 250 | **500** |
| Actifs sur 7j roulants | 30 | 100 | 250 |
| Ticks moyens par session | 1.5 | 3 | 5+ |
| Cartes commandant partagées | 5/sem | 25/sem | 100/sem |
| Stars Codeberg/GitHub | 30 | 100 | 300 |

## Risques & mitigations

- **Mutinynet down.** Toujours possible (signet expérimental). Snapshot
  IndexedDB couvre la continuité de session, mais un downtime > 24 h
  paralyse les inscriptions. Mitigation : faux genesis sur testnet en
  backup ; déjà supporté par `engine/scan-bitcoin.mjs`.
- **Pic de joueurs → fees Mutinynet.** Mutinynet a fees ~ 0 mais si
  saturé, on observe latence. Mitigation : batcher les ordres dans une
  seule inscription (déjà fait par `op_type=0x02`).
- **3D plante sur mobile bas de gamme.** Le fallback SVG existant (vue
  Galaxie) reste actif. Pulse est opt-in. `mount()` retourne `false`
  proprement si Three.js indisponible.

## Non-breaking guarantee

**Aucun fichier de l'engine n'est modifié** dans le pack vivant. Le
déterminisme du tick est intact :

```bash
# Sanity check
node --test tests/determinism.test.mjs tests/determinism-boot.test.mjs \
                tests/replay.test.mjs tests/combat.test.mjs \
                tests/colonisation.test.mjs tests/epochs.test.mjs
# → tous les tests doivent passer SANS modification
```

Tous les ajouts vivent dans :
- `client/sfx.mjs`, `client/idle-clicker.mjs`, `client/feed.mjs`,
  `client/galaxy3d.mjs`, `client/achievements.mjs`, `client/share-card.mjs`
- ajouts CSS en fin de `client/styles.css` (prefixés `.bridge-`, `.feed-`,
  `.pulse-`, `.codex-`)
- ajouts d'imports dans `console-live-bitcoin.html` (importmap + module
  loader), + 2 boutons de nav et 2 containers de vue
- ajouts dans `client/app.js` en fin de fichier (section "Pack Vivant"),
  hookés via `setInterval(__vivantPostRender, 600)` qui est idempotent
- nouveau fichier `index-vivant.html` (landing) — n'écrase pas `index.html`

## Démarrer en local

```bash
python3 -m http.server 8765
# Console : http://localhost:8765/console-live-bitcoin.html
# Landing : http://localhost:8765/index-vivant.html
```
