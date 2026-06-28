import { volvoParts } from "./volvoPartsDatabase";

export interface Part {
  reference: string;
  designation: string;
  vehicleType: string;
  priceHT: number;
  stock: number;
  model: "volvo";
}

export interface RankedPart extends Part {
  searchScore: number;
  searchSignals: string[];
}

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (value: string) => (value ? normalize(value).split(" ").filter(Boolean) : []);

const levenshteinDistance = (left: string, right: string) => {
  const matrix: number[][] = [];
  for (let row = 0; row <= right.length; row += 1) matrix[row] = [row];
  for (let column = 0; column <= left.length; column += 1) matrix[0][column] = column;

  for (let row = 1; row <= right.length; row += 1) {
    for (let column = 1; column <= left.length; column += 1) {
      if (right.charAt(row - 1) === left.charAt(column - 1)) {
        matrix[row][column] = matrix[row - 1][column - 1];
      } else {
        matrix[row][column] = Math.min(matrix[row - 1][column - 1] + 1, matrix[row][column - 1] + 1, matrix[row - 1][column] + 1);
      }
    }
  }

  return matrix[right.length][left.length];
};

const FAMILY_ALIASES: Record<string, string[]> = {
  phare: ["phare", "phares", "optique", "optiques", "projecteur", "headlight", "fnar", "fanar", "fanal", "bloc phare"],
  feu: ["feu", "feux", "stop", "clignotant", "cligno", "antibrouillard", "catadioptre"],
  aile: ["aile", "fender"],
  amortisseur: ["amortisseur", "amortisseurs", "amorti", "amorto", "amort", "suspension", "amor"],
  echappement: ["echappement", "exhaust", "chaqment", "cha9ment", "chakment", "chaqman", "cha9man", "chakman", "silencieux", "pot"],
  porte: ["porte", "portiere", "portieres", "door", "bab"],
  vitre: ["vitre", "vitres", "glace", "glaces", "lunette", "window", "verre"],
  retroviseur: ["retroviseur", "retro", "miroir", "mirwar"],
  capot: ["capot", "hood"],
  pare_choc: ["pare choc", "parechoc", "parchoque", "parchoc"],
  filtre: ["filtre", "filter", "filtr"],
  frein: ["frein", "freinage", "brake", "plaquette", "plaquettes", "disque", "disques", "etrier", "tambour"],
  cardan: ["cardan", "transmission"],
  triangle: ["triangle", "bras de suspension", "bras suspension", "bras"],
  roulement: ["roulement", "bearing", "rulman", "roulman"],
  batterie: ["batterie", "battery"],
  radiateur: ["radiateur", "refroidissement"],
};

const FAMILY_WEIGHTS: Record<string, number> = {
  phare: 1.6,
  feu: 1.45,
  aile: 1.45,
  amortisseur: 1.55,
  echappement: 1.55,
  porte: 1.35,
  vitre: 1.35,
  retroviseur: 1.35,
  capot: 1.35,
  pare_choc: 1.35,
  filtre: 1.2,
  frein: 1.45,
  cardan: 1.35,
  triangle: 1.35,
  roulement: 1.25,
  batterie: 1.2,
  radiateur: 1.25,
};

const SUBTYPE_ALIASES: Record<string, string[]> = {
  optique: ["optique", "bloc phare", "projecteur"],
  clignotant: ["clignotant", "cligno"],
  marmite: ["marmite", "silencieux arriere", "pot arriere"],
  joint: ["joint", "gasket", "seal"],
  soupape: ["soupape", "valve"],
  support: ["support", "bracket"],
  catalyseur: ["catalyseur", "catalytic", "convertisseur catalytique"],
  ligne: ["ligne", "ligne complete", "systeme complet"],
  roulement: ["roulement", "bearing"],
  extension: ["extension"],
  garniture: ["garniture"],
  charniere: ["charniere"],
  cable: ["cable"],
};

const SUBTYPE_TO_FAMILY: Record<string, string> = {
  optique: "phare",
  clignotant: "feu",
  marmite: "echappement",
  joint: "echappement",
  soupape: "echappement",
  support: "echappement",
  catalyseur: "echappement",
  ligne: "echappement",
  roulement: "amortisseur",
  extension: "aile",
  garniture: "aile",
  charniere: "porte",
  cable: "capot",
};

const QUALIFIER_ALIASES: Record<string, string[]> = {
  avant: ["avant", "av"],
  arriere: ["arriere", "ar"],
  gauche: ["gauche", "g", "conducteur"],
  droite: ["droite", "d", "droit", "passager"],
  superieur: ["superieur", "sup"],
  inferieur: ["inferieur", "inf"],
  interieur: ["interieur", "int"],
  exterieur: ["exterieur", "ext"],
};

const FILLER_TOKENS = new Set([
  "nheb",
  "n7eb",
  "famma",
  "behi",
  "choufli",
  "chouf",
  "lawwejli",
  "lawwej",
  "tawa",
  "3la",
  "ala",
  "une",
  "un",
  "des",
  "de",
  "du",
  "la",
  "le",
  "les",
  "svp",
  "brabi",
  "je",
  "veux",
  "cherche",
  "cherch",
  "non",
  "oui",
  "parle",
  "juste",
]);

interface QueryIntent {
  normalizedQuery: string;
  tokens: string[];
  family?: string;
  subtype?: string;
  qualifiers: string[];
  freeTokens: string[];
}

interface IndexedPart {
  part: Part;
  normalizedDesignation: string;
  designationTokens: string[];
  families: string[];
  subtypes: string[];
  qualifiers: string[];
  articleHead: string;
}

const matchesAlias = (tokens: string[], normalizedText: string, alias: string) => {
  const normalizedAlias = normalize(alias);
  if (!normalizedAlias) return false;

  if (normalizedAlias.includes(" ")) {
    return normalizedText.includes(normalizedAlias);
  }

  return tokens.some((token) => token === normalizedAlias || token.startsWith(normalizedAlias));
};

const matchesAliasFuzzy = (token: string, aliases: string[]) =>
  aliases.some((alias) =>
    tokenize(alias).some((aliasToken) => token.length >= 4 && levenshteinDistance(token, aliasToken) <= 1),
  );

const detectBestKey = (tokens: string[], normalizedText: string, aliasesMap: Record<string, string[]>, weights?: Record<string, number>) => {
  let bestKey: string | undefined;
  let bestScore = -1;

  Object.entries(aliasesMap).forEach(([key, aliases]) => {
    let score = 0;

    aliases.forEach((alias) => {
      if (matchesAlias(tokens, normalizedText, alias)) {
        score += normalize(alias).includes(" ") ? 9 : 7;
      }
    });

    tokens.forEach((token) => {
      if (matchesAliasFuzzy(token, aliases)) {
        score += 3;
      }
    });

    if (score > 0 && weights?.[key]) {
      score *= weights[key];
    }

    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  });

  return bestScore > 0 ? bestKey : undefined;
};

const analyzeQuery = (query: string): QueryIntent => {
  const normalizedQuery = normalize(query);
  const tokens = tokenize(query).filter((token) => !FILLER_TOKENS.has(token));
  const family = detectBestKey(tokens, normalizedQuery, FAMILY_ALIASES, FAMILY_WEIGHTS);
  const subtype = detectBestKey(tokens, normalizedQuery, SUBTYPE_ALIASES);
  const effectiveFamily = family || (subtype ? SUBTYPE_TO_FAMILY[subtype] : undefined);

  const qualifiers = Object.entries(QUALIFIER_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => matchesAlias(tokens, normalizedQuery, alias)))
    .map(([qualifier]) => qualifier);

  const aliasTokens = new Set<string>();
  if (effectiveFamily) {
    [effectiveFamily, ...(FAMILY_ALIASES[effectiveFamily] || [])].forEach((alias) => tokenize(alias).forEach((token) => aliasTokens.add(token)));
  }
  if (subtype) {
    [subtype, ...(SUBTYPE_ALIASES[subtype] || [])].forEach((alias) => tokenize(alias).forEach((token) => aliasTokens.add(token)));
  }
  qualifiers.forEach((qualifier) => QUALIFIER_ALIASES[qualifier].forEach((alias) => aliasTokens.add(alias)));

  const freeTokens = tokens.filter((token) => !aliasTokens.has(token));

  return {
    normalizedQuery,
    tokens,
    family: effectiveFamily,
    subtype,
    qualifiers,
    freeTokens,
  };
};

const detectPartFamilies = (designationTokens: string[], normalizedDesignation: string) =>
  Object.entries(FAMILY_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => matchesAlias(designationTokens, normalizedDesignation, alias)))
    .map(([family]) => family);

const detectPartSubtypes = (designationTokens: string[], normalizedDesignation: string) =>
  Object.entries(SUBTYPE_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => matchesAlias(designationTokens, normalizedDesignation, alias)))
    .map(([subtype]) => subtype);

const detectPartQualifiers = (designation: string, designationTokens: string[]) => {
  const upperDesignation = designation.toUpperCase();
  const qualifiers: string[] = [];

  if (designationTokens.some((token) => token === "av" || token.includes("avant")) || /\bAV\b/.test(upperDesignation)) qualifiers.push("avant");
  if (designationTokens.some((token) => token === "ar" || token.includes("arriere")) || /\bAR\b/.test(upperDesignation) || upperDesignation.includes("AR ")) qualifiers.push("arriere");
  if (designationTokens.some((token) => token === "g" || token.includes("gauche")) || /\bG\b/.test(upperDesignation)) qualifiers.push("gauche");
  if (designationTokens.some((token) => token === "d" || token.includes("droite") || token.includes("droit")) || /\bD\b/.test(upperDesignation)) qualifiers.push("droite");
  if (designationTokens.some((token) => token.includes("superieur")) || /\bSUP\b/.test(upperDesignation)) qualifiers.push("superieur");
  if (designationTokens.some((token) => token.includes("inferieur")) || /\bINF\b/.test(upperDesignation)) qualifiers.push("inferieur");
  if (designationTokens.some((token) => token.includes("interieur"))) qualifiers.push("interieur");
  if (designationTokens.some((token) => token.includes("exterieur"))) qualifiers.push("exterieur");

  return qualifiers;
};

const indexedParts: IndexedPart[] = volvoParts.map((part) => {
  const normalizedDesignation = normalize(part.designation);
  const designationTokens = tokenize(part.designation);
  const families = detectPartFamilies(designationTokens, normalizedDesignation);
  const subtypes = detectPartSubtypes(designationTokens, normalizedDesignation);
  const qualifiers = detectPartQualifiers(part.designation, designationTokens);
  const articleHead = designationTokens.find((token) => !["av", "ar", "g", "d", "de", "du", "des"].includes(token)) || designationTokens[0] || "";

  return {
    part,
    normalizedDesignation,
    designationTokens,
    families,
    subtypes,
    qualifiers,
    articleHead,
  };
});

export function buildPartSearchCandidates(query: string, model?: "volvo", limit = 40): RankedPart[] {
  const intent = analyzeQuery(query);
  if (intent.tokens.length === 0) return [];

  const ranked: RankedPart[] = [];

  indexedParts.forEach((entry) => {
    const { part, normalizedDesignation, designationTokens, families, subtypes, qualifiers } = entry;
    const signals = new Set<string>();
    let score = 0;

    if (intent.family) {
      if (!families.includes(intent.family)) {
        return;
      }
      score += 260 * (FAMILY_WEIGHTS[intent.family] || 1);
      signals.add(`Famille: ${intent.family}`);
    }

    if (intent.subtype) {
      if (!subtypes.includes(intent.subtype) && !matchesAlias(designationTokens, normalizedDesignation, intent.subtype)) {
        return;
      }
      score += 220;
      signals.add(`Sous-type: ${intent.subtype}`);
    }

    for (const qualifier of intent.qualifiers) {
      if (qualifiers.includes(qualifier)) {
        score += 135;
        signals.add(`Variante: ${qualifier}`);
      } else {
        score -= 120;
      }
    }

    for (const token of intent.freeTokens) {
      if (designationTokens.some((designationToken) => designationToken === token || designationToken.startsWith(token))) {
        score += 36;
        signals.add(`Mot: ${token}`);
      } else if (designationTokens.some((designationToken) => token.length >= 4 && levenshteinDistance(token, designationToken) <= 1)) {
        score += 18;
        signals.add(`Approximation: ${token}`);
      } else {
        score -= 8;
      }
    }

    const normalizedReference = normalize(part.reference);
    if (normalizedReference === intent.normalizedQuery) {
      score += 1000;
      signals.add("Reference exacte");
    } else if (intent.normalizedQuery.length >= 5 && normalizedReference.includes(intent.normalizedQuery)) {
      score += 360;
      signals.add("Reference partielle");
    }

    if (!intent.family && families.length > 0) {
      score += 20;
    }

    if (!intent.subtype && subtypes.length > 0 && intent.freeTokens.some((token) => subtypes.some((subtype) => subtype.startsWith(token)))) {
      score += 55;
    }

    if (model && part.model === model) score += 60;
    if (part.stock > 0) score += 14;

    if (score <= 0) return;

    ranked.push({
      ...part,
      searchScore: score,
      searchSignals: Array.from(signals),
    });
  });

  ranked.sort((left, right) => right.searchScore - left.searchScore || right.stock - left.stock);
  return ranked.slice(0, limit);
}

export function searchParts(query: string, model?: "volvo"): Part[] {
  return buildPartSearchCandidates(query, model, 8).map(({ searchScore, searchSignals, ...part }) => part);
}
