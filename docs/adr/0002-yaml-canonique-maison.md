# ADR-0002 — YAML canonique maison (parser/serializer isomorphe)

- **Statut** : Accepted
- **Date** : 2026-02 (rétroactif)
- **Décideurs** : meffysto
- **Tags** : architecture, tooling

## Contexte

Les ordres, les états et les règles sont en YAML lisible humain. Cela permet
qu'un joueur (ou agent) lise/écrive ses ordres à la main sans dépendre d'un
outil propriétaire. Mais le moteur a besoin d'une sérialisation
**déterministe** : `sha256(canonicalJSON(secret))` doit donner le même hash
pour tout client qui lit le même secret.

Or :
- `js-yaml` & `yaml` (npm) : ordre des clés non garanti, formatage variable,
  bug potentiels selon version, ~200 KB minifié, gros transitif côté browser.
- Toute différence de blanc/quote/escape entre clients = hash divergent =
  fork de l'état.

On a besoin d'un encodage strictement reproductible, léger, sans deps
externes, et qui marche **identiquement en Node et dans le navigateur**.

## Décision

Implémenter `yparse` / `ystringify` dans `engine/tick-core.mjs` (~150 lignes
chacun). Sous-ensemble strict de YAML : indentation 2 espaces, listes `- `,
scalaires (string, int, float, bool, null), maps imbriquées. Pas
d'ancres/aliases, pas de tags, pas de flow style. Pour les hashes, on passe
par `canonicalJSON` (clés triées récursivement, séparateurs `,`/`:` fixes).

## Conséquences

### Positives
- Zéro dépendance externe pour parser nos formats : un client minimal tient
  dans un seul fichier `tick-core.mjs`.
- Tout hash inscrit on-chain est reproductible bit-à-bit par n'importe qui.
- Diff Git de l'état lisible humain (cohabite avec le fork legacy).

### Négatives / à surveiller
- Sous-ensemble strict : si un joueur écrit un YAML avec une syntaxe non
  supportée (ex: flow style `{ a: 1, b: 2 }` inline), le parser refuse.
- Maintenance : tout bug du parser est notre problème. Les tests
  `tests/replay.test.mjs` couvrent les formats utilisés ; un fuzz sur les
  formes YAML reste à ajouter.
- Performance : pas optimisé, mais sans bottleneck observé sur les payloads
  actuels (< 10 KB par ordre typique).

## Alternatives considérées

### A. JSON pour tout, oublier YAML
Possible, mais perd la lisibilité humaine — un joueur qui ouvre son
`ordres.yaml` à la main préfère YAML. Et la lisibilité est un argument fort
pour l'audit communautaire.

### B. `js-yaml` côté browser, `yaml` côté Node
Risque de divergence subtile (Numbers, ordre des clés, escapes Unicode).
Inacceptable quand le hash est dans la chaîne pour toujours.

### C. CBOR ou MessagePack
Binaire, donc plus petit, mais perd la lisibilité humaine et nécessite des
deps additionnelles. Pas la peine tant que les ordres restent KB.

## Liens

- Implémentation : `engine/tick-core.mjs:19-160`
- Tests : `tests/replay.test.mjs`, `tests/determinism.test.mjs`
- Utilisé par : tous les modules (engine/* et console-live)
