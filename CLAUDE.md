@AGENTS.md

# RubixLearn — détecteur de Rubik's cube (architecture & travail réalisé)

App Next.js (dev sur **:3001** — :3000 = serveur golf NestJS de l'utilisateur). Branche
`gray`, remote `github.com/jguyet/3d-cube-cam-detection`. Détection markerless d'un cube
tenu devant la webcam, en temps réel dans le navigateur, + overlay 3D + cubes connectés.

## Contraintes projet (à respecter)

- **Jamais** écrire dans `~/Desktop` (synchro cloud).
- **Pas** de finetuning sur les captures desktop perso (ça marcherait pour l'utilisateur,
  pas pour les autres). Le dataset synthétique (`dataset-1/2`) est OK pour entraîner.
- `python3` (pas `python`). Env : `.venv/`.
- Ne pas toucher au projet linepicplus (copier au besoin).
- **Décodage offline (sharp) ≠ navigateur (canvas)** sur les JPEG → valider en live. Les
  PNG (dataset-1/2) sont lossless → l'offline y colle bien.

## Deux détecteurs

1. **Hybride (legacy)** — `HybridScanner.tsx` : modèle ML iter4 (ONNX, `cubeNet.ts`) donne
   la **zone** du cube, puis `ShapeDetector` + `cubePoseFromStickers` (résection DLT,
   `extractFacesV2`, lattices) à l'intérieur. Lourd (~17 Mo), zone qui saute. Tags
   `hybrid-v1..v8`.
2. **V2 graphe (le bon, développé cette session)** — lit les faces **directement dans le
   graphe de voisinage** des stickers détectés. Pas d'homographie, pas d'ambiguïté
   d'échelle. Tag `v2-graph-v1`. **C'est le système principal.**

## Pipeline V2 (par frame, dans `V2AlgoScanner.tsx` → page `/v2-algo`)

```
detect(colour) → filtre noir → dedupeShapes → detectCubeFaces(graphe) →
keepDominantCluster → présence → FaceTracker (anti-shift+anti-teleport) →
CubeState (vote multi-frame) → CubeSim 3D (gyroscope) + validité/résolvabilité
```

### `ShapeDetector` (`src/lib/rubik-detector/core/ShapeDetector.ts`)
Filtres d'image de `detect(img, thr, region, adaptive, opts)` :
1. extraction canaux RGB + YCbCr ; 2. **flou gaussien 5×5** `[1,4,6,4,1]` sur R,G,B ;
3. **modèle de fond** (opt `motion` — soustrait le décor statique) ; 4. **Sobel RGB** ;
5. **seuil adaptatif** (82ᵉ percentile de la magnitude en zone, clampé [60, thr]) —
LE gain clé ; 6. **arêtes de frontière-couleur** (opt `colour` — quantise → arête au
changement de couleur, sépare 2 stickers de couleurs ≠ sans gap) ; 7. **dilatation** 1px ;
8. **flood-fill** composantes connexes.
- `opts`: `colour`, `mem` (ColourMemory), `aspectMax` (défaut 3.4 ; **v2 utilise 5** pour
  capter les stickers obliques/foreshortened), `minAreaFrac`, `motion`.
- Chaque région porte sa **couleur moyenne** classée + **homogénéité** (écart-type) ; une
  région **noire** ou trop hétérogène est **rejetée à la découverte**.
- `detectWhite` (faces blanches), `splitMerged(shapes, img)` (découpe les blocs même
  couleur sans gap — vérifie une vraie couture avant de couper).

### `shapeGraph.ts` — le cœur V2
- `graphFaces(shapes, oriTol=0.18)` : voisinage par **pitch LOCAL par nœud** (médiane des
  3 plus proches — gère 2 faces à distances ≠), **fold-cut** par orientation propre de
  chaque sticker (coupe les liens à l'arête entre 2 faces), rotation par moyenne d'angle
  doublée, **pitch ANISOTROPE** (pas_u ≠ pas_v pour les faces obliques), BFS → (gx,gy).
- `dedupeShapes` : supprime les doublons (detect+detectWhite+split) qui écrasent le pitch.
- `detectCubeFaces(shapes, {image,mem,minDetected=4,oriTol})` : chaque face = **3×3
  complet toujours** (9 cellules), fenêtres multiples par composante, dedup, couleur par
  cellule (y compris cellules complétées « imaginées »).
- `keepDominantCluster` : **auto-localisation sans ML** — garde le plus gros amas de faces
  adjacentes = le cube ; jette le fond isolé.

### `faceTrack.ts` — `FaceTracker`
Stabilise la face dominante : 9 slots persistants, pré-alignement rigide, EMA position,
**vote couleur**, persistance, **anti-téléportation** (un saut lointain d'1 frame est
rejeté ; ré-acquisition seulement si le déplacement persiste `reacquireK=4` frames).

### `facePose.ts` — gyroscope
`cubeOrientation(faces)` : orientation **absolue** via l'identité couleur du centre
(chaque face → repère cube connu), multi-face (la transition 50/50 sur-détermine la pose).
`R = O·Cᵀ`. Repères canoniques **gauchers** (n = v×u) — cf. bug de chiralité corrigé.

### `cubeState.ts` — `CubeState` (détection continue multi-frames)
Découple la détection par frame de l'état persistant. Chaque cellule **vote** sa couleur ;
se **confirme** à ≥3 votes cohérents (≥60 %). Frames pauvres (<5 cellules propres, ex.
transition) **rejetées**. Détection de changement de face. Centres fixes par schéma.
`completion()`, `validity()` (lois de comptage), `solvable()`.

### `cubeSolvable.ts` — résolvabilité physique
`checkSolvable(54 facelets)` : conversion facelets → pièces (coins/arêtes, layout
Kociemba) + les 3 lois profondes : permutation valide, Σ orient. coins ≡ 0 (mod 3),
Σ orient. arêtes ≡ 0 (mod 2), parité(coins)=parité(arêtes). Validé (solved & coup R → ok ;
coin twisté / arête flippée / échange 2-pièces → rejeté). ~4,3×10¹⁹ états atteignables.

### `cubeSim.ts` — `CubeSim` (rendu 3D three.js)
Pur renderer à côté de la caméra : `applyFace(fi, couleurs)` peint les cellules
confirmées, `setOrientation` (slerp = gyroscope), **6 centres pré-remplis** (schéma std :
blanc=U, jaune=D, vert=F, bleu=B, rouge=R, orange=L).

### `cubeMotion.ts` — `CubeMotion` (prédictif, expérimental)
Estime position/vitesse/vitesse angulaire ; **coast** (extrapole) quand le cube est perdu
(fantôme affiché **seulement** après perte réelle ≥6 frames, jamais sur un creux d'1
frame) ; `contains()` = **gate anti-out-of-cube silencieux** (rejette les faces loin de la
prédiction). ⚠️ A causé un flash parasite (reverté puis refait proprement).

### `stickerColor.ts` — classification couleur
`classifyColour` calé sur **~24k tests** (6 couleurs + peau × teinte/sat/lum × casts
chaud/froid × bruit) → **~98 %**. Fixes : **blanc chaud** reconnu par ses 3 canaux allumés
(min élevé) ; **vert|bleu** à 188 (était 170) ; frontières chaudes red<15/orange<43/
yellow<82/blue<290. `ColourMemory` : palette apprise, ne sert **qu'à départager le trio
chaud rouge↔orange↔jaune** (le snap closed-set de toutes les couleurs déraillait →
blanc→jaune). `seedCanonical()` sème les 6 ancres. `darkFraction` (noir = sombre ET
achromatique), `sampleQuadRGB` (exclut le spéculaire).

## Pages
- `/v2-algo` — **le scanner principal** (caméra + cube 3D gyroscope + complétion% + lois +
  résolvabilité). Toggles : seuil adaptatif, découper blocs, imaginer face, stabiliser,
  retirer le fond, liens.
- `/shape-detector-test` — détecteur brut (+ toggle « frontières couleur (vrai pipeline) »).
- `/shape-detector-links` — brut + liens de voisinage + splitMerged.
- `/v3-zone` — v2 DANS la zone ML hybride (abandonné en live : modèle lent + zone qui saute).
- `/cube-connecte` — cubes Bluetooth (`SmartCubeConnect.tsx`).

## Cubes connectés (`SmartCubeConnect.tsx`)
`cubing/bluetooth` `connectSmartPuzzle()`. **GAN 356i** : pas de capteurs → dead-reckoning
depuis une réf « résolu » (décodage custom `gan356i.ts`). **GiiKER** : rapporte son **état
absolu** → lu via `puzzle.getPattern()` puis converti par `patternToFacelets.ts` (inverse
du `getPatternData` de cubing.js, tables Kociemba) → plus besoin de « mark solved ».

## Dataset & validation (offline, non commité)
- `dataset-1` (1000 PNG) / `dataset-2` (30000 PNG) : cubes synthétiques sur fonds réels,
  `labels.jsonl` = 8 coins + visibilité des 6 faces. `dataset-4/realneg_*` = négatifs.
- `_v2val.ts` : harnais géométrique (coins GT → 9 centres → match). Env : ASPECT, ORI,
  MIND, CLUSTER, MINAREA, DEDUP, FILE (debug), NOSPLIT.
- `_coltest.ts` : générateur de milliers de couleurs teintées pour caler le classifieur.
- `_v2draw.ts` : rend les détections sur une image pour inspection visuelle.
- Lancer : `npx tsx --tsconfig tsconfig.json ./_v2val.ts dataset-1 400`.

### Résultats validés (dataset-1, n=400, pipeline live)
Recall **43.6% → 61.1%**, précision **62.6% → 71.4%**, multi-face 46% → 56%, erreur
position ~0.14·pitch, 8.3/9 cellules. Recall par obliquité : frontal 80%, ≤1.4 76%,
≤1.8 61%, **>1.8 seulement ~14%** (plafond dur : stickers qui fusionnent physiquement).
Généralise sur dataset-2.

## Apprentissages clés
- Le **seuil adaptatif** (~60) a été LE déblocage détection.
- Le graphe ne « bloque » jamais si les 9 nœuds sont là ; les échecs viennent de la
  **détection des nœuds** (obliques, fusion) et du **fond** (d'où auto-localisation +
  gate mouvement).
- L'**identité couleur du centre** est l'ancre absolue (gyroscope + accumulation d'état).
- Reverts fréquents sur les tentatives couleur : toujours **valider sur les 24k tests**
  avant de committer un changement de classifieur ; le closed-set agressif casse le blanc.
