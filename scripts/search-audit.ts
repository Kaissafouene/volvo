import { buildPartSearchCandidates, type RankedPart } from "../src/data/partsDatabase";

const QUALIFIER_TOKENS = new Set(["av", "avant", "ar", "arriere", "g", "gauche", "d", "droite", "droit", "sup", "superieur", "inf", "inferieur", "int", "interieur", "ext", "exterieur"]);
const STOP_SUBTYPE_TOKENS = new Set(["de", "du", "des", "d", "la", "le", "les"]);

const PRIMARY_FAMILY_SUBTYPE: Record<string, string> = {
  amortisseur: "Amortisseur",
  aile: "Aile",
  capot: "Capot",
  porte: "Porte",
  phare: "Optique",
  feu: "Feu",
  cardan: "Cardan",
  triangle: "Triangle",
};

const SUBTYPE_PATTERNS: Array<{ label: string; patterns: RegExp[] }> = [
  { label: "Porte reservoir", patterns: [/^PORTE RESERVOIR/] },
  { label: "Agrafe", patterns: [/^AGRAFE/, /^AGRAFES/, /^AGRAFFE/] },
  { label: "Charniere", patterns: [/^CHARNIERE/, /^CHARNIÈRE/] },
  { label: "Cable", patterns: [/^CABLE/] },
  { label: "Serrure", patterns: [/^SERRURE/] },
  { label: "Poignee", patterns: [/^POIGNEE/] },
  { label: "Joint", patterns: [/^JOINT\b/, /\bJOINT\b/] },
  { label: "Adhesif", patterns: [/^ADHESIF/] },
  { label: "Capteur", patterns: [/^CAPTEUR/] },
  { label: "Douille", patterns: [/^DOUILLE/] },
  { label: "Cache", patterns: [/^CACHE/] },
  { label: "Tiran", patterns: [/^TIRAN/] },
  { label: "Loquet", patterns: [/^LOQUET/] },
  { label: "Calle", patterns: [/^CALLE/] },
  { label: "Marmite", patterns: [/MARMITE/, /SILENCIEUX/] },
  { label: "Soupape", patterns: [/SOUPAPE/] },
  { label: "Roulement support", patterns: [/ROULEMENT SUPPORT/] },
  { label: "Support", patterns: [/SUPPORT/] },
  { label: "Catalyseur", patterns: [/CATALYSEUR/] },
  { label: "Ligne", patterns: [/\bLIGNE\b/] },
  { label: "Roulement", patterns: [/\bROULEMENT\b/] },
  { label: "Amortisseur malle", patterns: [/AMORTISSEUR MALLE/] },
  { label: "Toc amortisseur", patterns: [/\bTOC\b/, /\bTOCS\b/] },
  { label: "Optique", patterns: [/OPTIQUE/, /PROJECTEUR/] },
  { label: "Clignotant", patterns: [/CLIGNOTANT/, /CLIGNO/] },
  { label: "Plaquette", patterns: [/PLAQUETTE/] },
  { label: "Disque", patterns: [/DISQUE/] },
  { label: "Etrier", patterns: [/ETRIER/] },
  { label: "Cardan", patterns: [/CARDAN/] },
  { label: "Triangle", patterns: [/^TRIANGLE/] },
  { label: "Capot", patterns: [/^CAPOT\b/] },
  { label: "Porte", patterns: [/^PORTE\b/] },
  { label: "Aile", patterns: [/^AILE\b/] },
  { label: "Amortisseur", patterns: [/^AMORTISSEUR\b/] },
  { label: "Phare", patterns: [/^PHARE\b/, /^OPTIQUE\b/] },
  { label: "Feu", patterns: [/^FEU\b/] },
];

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const extractFamilyFromText = (value: string) => {
  const normalizedValue = normalize(value);
  const families = ["echappement", "amortisseur", "aile", "porte", "phare", "feu", "filtre", "frein", "pare choc", "capot", "retroviseur", "vitre", "cardan", "triangle", "roulement", "batterie"];
  return families.find((family) => normalizedValue.includes(family));
};

const detectSubtypeLabel = (designation: string) => {
  const upperDesignation = designation.toUpperCase();
  const explicitSubtype = SUBTYPE_PATTERNS.find(({ patterns }) => patterns.some((pattern) => pattern.test(upperDesignation)));
  if (explicitSubtype) return explicitSubtype.label;

  const cleanedTokens = normalize(designation)
    .split(" ")
    .filter((token) => token && !QUALIFIER_TOKENS.has(token) && !STOP_SUBTYPE_TOKENS.has(token));

  if (cleanedTokens.length === 0) return "";
  return cleanedTokens.slice(0, Math.min(2, cleanedTokens.length)).map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" ");
};

const sortCandidatesForDisplay = (candidates: RankedPart[], label: string) => {
  const family = extractFamilyFromText(label);
  const primarySubtype = family ? PRIMARY_FAMILY_SUBTYPE[family] : undefined;

  return [...candidates].sort((left, right) => {
    const leftSubtype = detectSubtypeLabel(left.designation);
    const rightSubtype = detectSubtypeLabel(right.designation);
    const leftPrimaryBoost = primarySubtype && leftSubtype === primarySubtype ? 1 : 0;
    const rightPrimaryBoost = primarySubtype && rightSubtype === primarySubtype ? 1 : 0;
    if (leftPrimaryBoost !== rightPrimaryBoost) {
      return rightPrimaryBoost - leftPrimaryBoost;
    }

    return right.searchScore - left.searchScore || right.stock - left.stock;
  });
};

const buildPieceChoices = (candidates: RankedPart[], query: string) => {
  const inStockCandidates = sortCandidatesForDisplay(candidates.filter((candidate) => candidate.stock > 0), query);
  const family = extractFamilyFromText(query);
  const primarySubtype = family ? PRIMARY_FAMILY_SUBTYPE[family] : undefined;
  const subtypeOptions = Array.from(new Set(inStockCandidates.map((candidate) => detectSubtypeLabel(candidate.designation)).filter(Boolean))).sort((left, right) => {
    const leftPrimary = primarySubtype && left === primarySubtype ? 1 : 0;
    const rightPrimary = primarySubtype && right === primarySubtype ? 1 : 0;
    if (leftPrimary !== rightPrimary) return rightPrimary - leftPrimary;
    return left.localeCompare(right, "fr");
  });
  const normalizedQuery = normalize(query);
  return subtypeOptions.filter((option) => {
    if (primarySubtype && option === primarySubtype) return true;
    return !normalizedQuery.includes(normalize(option));
  });
};

const queries = [
  "nheb amortisseur",
  "nlawej 3la echappement",
  "famma fnar",
  "choufli aile",
  "nheb capot",
  "nheb porte",
  "nheb cardan",
  "nheb triangle",
  "nheb feu",
];

for (const query of queries) {
  const candidates = buildPartSearchCandidates(query, "volvo", 12);
  const sorted = sortCandidatesForDisplay(candidates, query);
  const pieceChoices = buildPieceChoices(sorted, query);

  console.log(`\n=== ${query} ===`);
  console.log(`Piece choices: ${pieceChoices.join(" | ") || "(none)"}`);
  sorted.slice(0, 6).forEach((candidate, index) => {
    console.log(
      `${index + 1}. ${candidate.designation} | stock=${candidate.stock} | subtype=${detectSubtypeLabel(candidate.designation)} | score=${candidate.searchScore.toFixed(1)}`,
    );
  });
}
