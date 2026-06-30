// Learning content: levels, steps and algorithms.
// Each algorithm's starting case is generated automatically from the inverse
// of its notation, so every demo provably ends on a solved cube.

export interface Algorithm {
  id: string;
  name: string;
  /** Standard notation taught for this case. */
  notation: string;
  /** Short description of when to use it. */
  description: string;
  /** Optional explicit setup (overrides the auto-generated inverse). */
  setup?: string;
}

export interface LevelStep {
  id: string;
  title: string;
  goal: string;
  algorithms: Algorithm[];
  /**
   * Optional "context" applied before the inverse setup in case mode, so the
   * demo ends in a realistic mid-solve state instead of a fully solved cube.
   * Must be a sequence that preserves whatever this step keeps solved (e.g. a
   * last-layer scramble for F2L / middle-layer steps, since LL algs keep the
   * first two layers intact). Leave undefined for foundational/final steps.
   */
  context?: string;
}

// A last-layer scramble: only disturbs the last layer, so it leaves the first
// two layers solved. Used so F2L / second-layer demos end with the cube's last
// layer still unsolved (realistic) rather than fully completed.
const LL_SCRAMBLE = "R U R' U R U2 R' U R U R' U' R' F R2 U' R' U' R U R' F'";

export interface Level {
  slug: string;
  order: number;
  name: string;
  tagline: string;
  difficulty: "Débutant" | "Intermédiaire" | "Avancé" | "Expert";
  color: string; // tailwind gradient classes
  accent: string; // tailwind text/badge color
  intro: string;
  steps: LevelStep[];
}

export const LEVELS: Level[] = [
  {
    slug: "debutant",
    order: 1,
    name: "Débutant",
    tagline: "Résoudre le cube couche par couche",
    difficulty: "Débutant",
    color: "from-emerald-500 to-teal-600",
    accent: "text-emerald-600",
    intro:
      "La méthode couche par couche. Tu résous le cube étage par étage avec très peu d'algorithmes à mémoriser. C'est le point de départ idéal pour comprendre comment les pièces bougent.",
    steps: [
      {
        id: "croix-blanche",
        title: "1 · La croix blanche",
        goal: "Former une croix blanche sur la face du bas, arêtes alignées avec les centres de couleur.",
        algorithms: [
          {
            id: "croix-insert",
            name: "Insérer une arête blanche",
            notation: "F2",
            description:
              "Place l'arête blanche au-dessus de sa position cible puis descends-la. Étape essentiellement intuitive — observe comment l'arête tombe à sa place.",
          },
        ],
      },
      {
        id: "coins-1ere-couche",
        title: "2 · Les coins de la première couche",
        goal: "Compléter la première couche en insérant les 4 coins blancs.",
        algorithms: [
          {
            id: "coin-droit",
            name: "Insertion d'un coin (à droite)",
            notation: "R U R' U'",
            description:
              "Le fameux « trigger ». Place le coin sous sa position et répète R U R' U' jusqu'à ce qu'il se loge correctement.",
          },
          {
            id: "coin-gauche",
            name: "Insertion d'un coin (à gauche)",
            notation: "L' U' L U",
            description: "La version miroir pour insérer un coin depuis le côté gauche.",
          },
        ],
      },
      {
        id: "deuxieme-couche",
        title: "3 · La deuxième couche",
        goal: "Placer les 4 arêtes de la couche du milieu.",
        context: LL_SCRAMBLE,
        algorithms: [
          {
            id: "arete-droite",
            name: "Arête vers la droite",
            notation: "U R U' R' U' F' U F",
            description:
              "Quand l'arête doit descendre dans l'emplacement à droite. Aligne d'abord la couleur de face avec son centre.",
          },
          {
            id: "arete-gauche",
            name: "Arête vers la gauche",
            notation: "U' L' U L U F U' F'",
            description: "La version miroir, pour insérer l'arête dans l'emplacement de gauche.",
          },
        ],
      },
      {
        id: "croix-jaune",
        title: "4 · La croix jaune",
        goal: "Orienter les arêtes du dessus pour former la croix jaune.",
        algorithms: [
          {
            id: "croix-jaune-fruruf",
            name: "Former la croix jaune",
            notation: "F R U R' U' F'",
            description:
              "Applique cet algo depuis un point, une barre (L) ou une ligne. Répète-le jusqu'à obtenir la croix jaune complète.",
          },
        ],
      },
      {
        id: "face-jaune",
        title: "5 · Orienter les coins jaunes",
        goal: "Faire toute la face jaune (orienter les 4 coins).",
        algorithms: [
          {
            id: "sune",
            name: "Sune",
            notation: "R U R' U R U2 R'",
            description:
              "Place un coin jaune correct en bas à gauche et répète jusqu'à ce que toute la face soit jaune.",
          },
        ],
      },
      {
        id: "permuter-derniere-couche",
        title: "6 · Permuter la dernière couche",
        goal: "Mettre les coins puis les arêtes à leur place finale.",
        algorithms: [
          {
            id: "permuter-coins",
            name: "Permuter les coins",
            notation: "U R U' L' U R' U' L",
            description:
              "Cycle 3 coins jusqu'à ce qu'ils soient tous bien placés (les couleurs des côtés peuvent encore être désorientées).",
          },
          {
            id: "permuter-aretes",
            name: "Permuter les arêtes",
            notation: "R U' R U R U R U' R' U' R2",
            description: "Le dernier algo : cycle les arêtes restantes pour finir le cube.",
          },
        ],
      },
    ],
  },
  {
    slug: "f2l",
    order: 2,
    name: "F2L",
    tagline: "Les deux premières couches en une fois",
    difficulty: "Intermédiaire",
    color: "from-sky-500 to-blue-600",
    accent: "text-sky-600",
    intro:
      "First Two Layers : au lieu de résoudre la première couche puis la deuxième, tu insères en une fois une paire coin + arête. C'est le plus gros gain de vitesse de la méthode CFOP. Voici les cas les plus fréquents.",
    steps: [
      {
        id: "paires-de-base",
        title: "Les paires de base",
        goal: "Insérer une paire coin+arête déjà rassemblée dans son emplacement (slot avant-droit).",
        context: LL_SCRAMBLE,
        algorithms: [
          {
            id: "f2l-1",
            name: "Paire prête, coin orienté à droite",
            notation: "U R U' R'",
            description: "Le coin a sa face blanche sur le côté droit, l'arête est au-dessus : insertion directe.",
          },
          {
            id: "f2l-2",
            name: "Paire prête, coin orienté à l'avant",
            notation: "y' U' R' U R",
            description: "Variante miroir lorsque la face blanche du coin pointe vers l'avant.",
          },
          {
            id: "f2l-3",
            name: "Séparer puis insérer (droite)",
            notation: "U' R U R'",
            description: "Le coin et l'arête sont mal alignés : on les sépare avant de les recombiner.",
          },
        ],
      },
      {
        id: "blanc-en-haut",
        title: "Face blanche vers le haut",
        goal: "Gérer les cas où le coin a sa face blanche tournée vers le haut.",
        context: LL_SCRAMBLE,
        algorithms: [
          {
            id: "f2l-4",
            name: "Coin blanc en haut, arête à droite",
            notation: "R U' R' U R U' R'",
            description: "On éloigne, on réoriente, puis on insère la paire proprement.",
          },
          {
            id: "f2l-5",
            name: "Coin blanc en haut, arête à gauche",
            notation: "y' R' U R U' R' U R",
            description: "La version miroir pour l'emplacement gauche.",
          },
        ],
      },
      {
        id: "cas-coriaces",
        title: "Cas plus coriaces",
        goal: "Les configurations qui demandent un setup avant l'insertion.",
        context: LL_SCRAMBLE,
        algorithms: [
          {
            id: "f2l-6",
            name: "Paire jointe à réorienter",
            notation: "U R U2 R' U R U' R'",
            description: "Le coin et l'arête sont collés mais mal orientés : on prépare avant d'insérer.",
          },
          {
            id: "f2l-7",
            name: "Coin coincé dans le slot",
            notation: "R U' R' U R U' R' U R U' R'",
            description: "Quand la paire est déjà (mal) dans l'emplacement, on l'extrait puis on la réinsère.",
          },
        ],
      },
    ],
  },
  {
    slug: "oll",
    order: 3,
    name: "OLL",
    tagline: "Orienter la dernière couche",
    difficulty: "Avancé",
    color: "from-amber-500 to-orange-600",
    accent: "text-amber-600",
    intro:
      "Orientation of the Last Layer : faire toute la face jaune d'un coup. La version complète compte 57 algos ; on commence ici par le « 2-look OLL » (la croix puis les coins), largement suffisant pour bien progresser.",
    steps: [
      {
        id: "oll-aretes",
        title: "Étape 1 · Orienter les arêtes (la croix)",
        goal: "Former la croix jaune selon le motif de départ.",
        algorithms: [
          {
            id: "oll-point",
            name: "Point",
            notation: "F R U R' U' F' f R U R' U' f'",
            description: "Aucune arête orientée : enchaîne les deux algos de croix.",
          },
          {
            id: "oll-l",
            name: "Coude (L)",
            notation: "F R U R' U' F'",
            description: "Deux arêtes adjacentes orientées : oriente l'angle vers l'arrière-gauche.",
          },
          {
            id: "oll-ligne",
            name: "Ligne",
            notation: "f R U R' U' f'",
            description: "Deux arêtes opposées orientées : place la ligne horizontalement.",
          },
        ],
      },
      {
        id: "oll-coins",
        title: "Étape 2 · Orienter les coins",
        goal: "Les 7 cas pour finir la face jaune une fois la croix faite.",
        algorithms: [
          {
            id: "oll-sune",
            name: "Sune",
            notation: "R U R' U R U2 R'",
            description: "Un seul coin orienté, en bas à gauche.",
          },
          {
            id: "oll-antisune",
            name: "Antisune",
            notation: "R U2 R' U' R U' R'",
            description: "Un seul coin orienté, en bas à droite (miroir du Sune).",
          },
          {
            id: "oll-h",
            name: "H (double Sune)",
            notation: "R U2 R' U' R U R' U' R U' R'",
            description: "Deux coins orientés se faisant face (OLL 21).",
          },
          {
            id: "oll-pi",
            name: "Pi",
            notation: "R U2 R2 U' R2 U' R2 U2 R",
            description: "Deux coins orientés côte à côte à l'avant.",
          },
          {
            id: "oll-t",
            name: "T",
            notation: "r U R' U' r' F R F'",
            description: "Deux coins orientés en diagonale, motif en T.",
          },
          {
            id: "oll-u",
            name: "U (phares)",
            notation: "R2 D R' U2 R D' R' U2 R'",
            description: "Deux « phares » jaunes à l'avant.",
          },
          {
            id: "oll-l-coins",
            name: "L",
            notation: "F R' F' r U R U' r'",
            description: "Motif en L des coins jaunes.",
          },
        ],
      },
    ],
  },
  {
    slug: "pll",
    order: 4,
    name: "PLL",
    tagline: "Permuter la dernière couche",
    difficulty: "Expert",
    color: "from-fuchsia-500 to-purple-600",
    accent: "text-fuchsia-600",
    intro:
      "Permutation of the Last Layer : la dernière étape de CFOP. Une fois la face jaune faite, ces algos déplacent les pièces à leur position finale. La version complète compte 21 algos ; voici les plus courants pour démarrer (2-look PLL).",
    steps: [
      {
        id: "pll-coins",
        title: "Permuter les coins",
        goal: "Mettre les 4 coins à leur place.",
        algorithms: [
          {
            id: "pll-aa",
            name: "Aa-perm",
            notation: "x R' U R' D2 R U' R' D2 R2",
            description: "Cycle 3 coins dans le sens anti-horaire.",
          },
          {
            id: "pll-ab",
            name: "Ab-perm",
            notation: "x R2 D2 R U R' D2 R U' R",
            description: "Cycle 3 coins dans le sens horaire (miroir de Aa).",
          },
          {
            id: "pll-e",
            name: "E-perm",
            notation: "x' R U' R' D R U R' D' R U R' D R U' R' D'",
            description: "Échange les deux paires de coins en diagonale.",
          },
        ],
      },
      {
        id: "pll-aretes",
        title: "Permuter les arêtes",
        goal: "Mettre les 4 arêtes à leur place pour finir le cube.",
        algorithms: [
          {
            id: "pll-ua",
            name: "Ua-perm",
            notation: "R U' R U R U R U' R' U' R2",
            description: "Cycle 3 arêtes dans le sens anti-horaire.",
          },
          {
            id: "pll-ub",
            name: "Ub-perm",
            notation: "R2 U R U R' U' R' U' R' U R'",
            description: "Cycle 3 arêtes dans le sens horaire.",
          },
          {
            id: "pll-h",
            name: "H-perm",
            notation: "M2 U M2 U2 M2 U M2",
            description: "Échange les deux paires d'arêtes opposées.",
          },
          {
            id: "pll-z",
            name: "Z-perm",
            notation: "M2 U M2 U M' U2 M2 U2 M' U2",
            description: "Échange les arêtes adjacentes deux à deux.",
          },
        ],
      },
      {
        id: "pll-complets",
        title: "Cas complets (T, Y, J)",
        goal: "Quelques PLL qui permutent coins ET arêtes en une fois.",
        algorithms: [
          {
            id: "pll-t",
            name: "T-perm",
            notation: "R U R' U' R' F R2 U' R' U' R U R' F'",
            description: "Échange deux coins adjacents et deux arêtes. Un grand classique.",
          },
          {
            id: "pll-y",
            name: "Y-perm",
            notation: "F R U' R' U' R U R' F' R U R' U' R' F R F'",
            description: "Échange deux coins en diagonale et deux arêtes.",
          },
          {
            id: "pll-jb",
            name: "Jb-perm",
            notation: "R U R' F' R U R' U' R' F R2 U' R' U'",
            description: "Permute un bloc de deux coins et deux arêtes adjacents.",
          },
        ],
      },
    ],
  },
];

export function getLevel(slug: string): Level | undefined {
  return LEVELS.find((l) => l.slug === slug);
}
