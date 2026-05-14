# ADR-0010 — Notifications push & responsive mobile

- **Statut** : Accepted (Browser API + responsive mobile ; Nostr self-DM en backlog)
- **Date** : 2026-05-14
- **Décideurs** : meffysto
- **Tags** : ux, mobile, identite

## Contexte

Trois lacunes UX freinaient l'engagement quotidien :

1. **Pas de notifications hors-onglet.** Le joueur devait garder la console
   ouverte pour voir qu'une flotte hostile arrivait, qu'un chantier
   terminait, qu'un stock saturait. La cloche `🔔` in-app n'aidait que pour
   ceux déjà devant l'écran.
2. **Onboarding silencieux sur la notif.** Le bouton "Activer les
   notifications" existait dans le panneau de la cloche mais n'était pas
   surfacé au premier login — la plupart des joueurs ne le découvraient
   jamais.
3. **Console pensée desktop.** Grille 3 colonnes (nav 220px / main 1fr /
   rail 320px), aucun `@media (max-width: ...)`. Sur mobile la mise en page
   pliait moche, rendant le jeu impraticable en mobilité.

## Décision

### Notifications — Browser Notification API
L'API `Notification` existait déjà dans `client/app.js` (objet `notif` avec
`pushPerm`, `requestPush()`, et un test `document.hidden + permission` dans
`notif.add()`). On l'expose explicitement en :

- **Ajoutant une 5ᵉ étape d'onboarding** qui explique le mécanisme et
  pointe vers le bouton d'activation.
- **Documentant** dans CONTEXT.md et le README que c'est en place.

Quand le navigateur affiche un push système, le badge `tag` correspond à
l'`id` interne — un même événement (même `key`) n'apparaît qu'une fois.
Seuls les events de sévérité `med` ou `high` déclenchent un push système
(les `low` restent en cloche in-app uniquement, pour éviter le bruit).

### Notifications — Nostr self-DM (backlog)
L'idée : quand un client détecte un event d'intérêt pour le joueur P,
publier un kind=4 chiffré de P vers P sur les relais Nostr. Un client
Nostr mobile (Damus, Amethyst, etc.) configuré avec la pubkey de P
montrerait alors un push.

Non implémenté dans ce chantier pour les raisons suivantes :

- Demande wallet déverrouillé en permanence pour signer/chiffrer.
- Nécessite gestion d'un pool de relais persistant côté client.
- Chicken-and-egg : pour publier la notif sur Nostr, il faut qu'un client
  CITADEL tourne — mais si le client tourne, le push browser suffit.
  Le seul vrai gain est sur les setups multi-device où un seul client est
  ouvert.
- Risque de spam des relais si plusieurs clients du même joueur tournent.

À reconsidérer si :
- Multi-device devient courant (cf ADR-0006 backlog `device_link`).
- Une feature "agent toujours en ligne" voit le jour (bot de surveillance
  qui sert aussi de pont notification).

### Responsive — mobile-first sous 900px

Découpage en deux paliers :

- **≤ 900 px** : `.shell` devient une grille 1 colonne. Le rail droit
  passe en drawer off-canvas, ouvrable via un bouton `#railToggle` dans
  le header (bouton hamburger). La nav latérale devient une barre de
  bottom-tabs horizontale (icône au-dessus, label en-dessous, badge en
  coin haut-droit). `main` prend toute la largeur. Tap targets ≥ 36 px.
  Le parallax céleste perd son `will-change` pour économiser GPU.
- **≤ 600 px** : labels nav cachés, icônes seulement. Padding réduit.
  `.strip` (ressources) passe en wrap.

Backdrop assombri + `Escape` ferment le drawer. Respect de
`env(safe-area-inset-*)` pour les notchs iOS.

## Conséquences

### Positives
- Push système opérationnel pour tout joueur qui accepte la permission —
  pas besoin de garder la console au premier plan.
- L'onboarding (étape 5) rend la fonctionnalité découvrable au lieu de
  l'enterrer dans un panneau.
- Console utilisable sur smartphone (testée logiquement à 360-414 px de
  large). Engagement quotidien possible en mobilité.
- Aucune dépendance ajoutée (Notification API native, CSS @media natif).

### Négatives / à surveiller
- Permission Notification peut être refusée définitivement par le
  navigateur après un refus initial — le bouton "Activer" passe alors en
  "push refusé par le navigateur" et le joueur doit aller dans les
  préférences système. C'est documenté dans l'onboarding.
- Le drawer mobile masque le rail par défaut — un joueur qui ne sait pas
  qu'il peut l'ouvrir risque de croire que le journal a disparu. Le
  bouton hamburger est visible avec le label "rail" pour cette raison.
- La galaxie orbitale + parallax sur petit écran reste cher visuellement.
  Surveiller les retours mobile, prêt à ajouter `prefers-reduced-motion`
  ou des fallbacks plus simples si besoin.

## Alternatives considérées

### A. Service Worker pour push hors-tab fermé
Demande un endpoint serveur de push (FCM, APNs via VAPID). Inacceptable :
contraire à la promesse "pas de backend" (ADR-0005). Reconsidérable si
un service tiers tolère bien le no-backend.

### B. Polling agressif en arrière-plan
Le navigateur tue les `setInterval` quand l'onglet est en arrière-plan
depuis trop longtemps. Pas une solution fiable.

### C. Framework UI (Svelte, Solid) pour le responsive
Hors scope (cf ADR-0009). Vanilla CSS @media + JS minimal suffit pour
deux paliers.

## Liens

- Code Browser push : `client/app.js:4072-4109` (objet `notif`)
- Code drawer mobile : `client/app.js` (`setupRailDrawer`), `client/styles.css`
  (section `@media (max-width: 900px)`)
- HTML : `console-live-bitcoin.html` (boutons `#railToggle`, `#notifPushBtn`,
  panneau `#notifPanel`)
- ADRs liées : ADR-0005 (pas de backend), ADR-0009 (découpage console)
