import type { ChatMessageChoiceGroup } from "@/components/ChatMessage";
import { volvoParts, type Part } from "@/data/volvoPartsDatabase";
import type { VehicleInfo } from "@/services/geminiService";

const env = import.meta.env as Record<string, string | undefined>;
const OPENAI_API_KEY = env.VITE_OPENAI_API_KEY || env.OPENAI_API_KEY;
const OPENAI_MODEL = env.VITE_OPENAI_MODEL || env.OPENAI_MODEL || "gpt-5.5";
const OPENAI_API_URL = env.VITE_OPENAI_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses";

const MAX_HISTORY_MESSAGES = 10;

export type ClarificationAxis = "piece" | "position" | "cote" | "niveau";
type SearchKind = "match" | "clarification" | "not_found" | "out_of_stock";

export interface PartsSearchDecision {
  requestedLabel: string;
  normalizedLabel: string;
  kind: SearchKind;
  reply: string;
  candidateReferences: string[];
  selectedReferences: string[];
  clarificationAxes: ClarificationAxis[];
}

export interface PartsConversationPlan {
  intro?: string;
  conversationalReply?: string;
  searches: PartsSearchDecision[];
}

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const QUALIFIER_TOKENS = new Set([
  "av",
  "avant",
  "ar",
  "arriere",
  "g",
  "gauche",
  "d",
  "droite",
  "droit",
  "sup",
  "superieur",
  "inf",
  "inferieur",
  "int",
  "interieur",
  "ext",
  "exterieur",
]);

const STOP_SUBTYPE_TOKENS = new Set(["de", "du", "des", "d", "la", "le", "les"]);

const SUBTYPE_PATTERNS: Array<{ label: string; patterns: RegExp[] }> = [
  { label: "Porte reservoir", patterns: [/^PORTE RESERVOIR/] },
  { label: "Agrafe", patterns: [/^AGRAFE/, /^AGRAFES/, /^AGRAFFE/] },
  { label: "Charniere", patterns: [/^CHARNIERE/] },
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
  { label: "Bougie", patterns: [/^BOUGIE/] },
];

const CATALOG_BY_REFERENCE = new Map(volvoParts.map((part) => [part.reference, part]));

const CATALOG_CONTEXT = volvoParts
  .map((part) => `${part.reference} | ${part.designation} | prix:${part.priceHT.toFixed(3)} DT | stock:${part.stock}`)
  .join("\n");

function getOpenAIApiKey() {
  if (!OPENAI_API_KEY) {
    throw new Error("MISSING_OPENAI_API_KEY");
  }

  return OPENAI_API_KEY;
}

type OpenAIResponseContent = { text?: string };
type OpenAIResponseItem = { content?: OpenAIResponseContent[] };
type OpenAIResponsePayload = { output_text?: string; output?: OpenAIResponseItem[] };

function extractTextFromOpenAIResponse(data: OpenAIResponsePayload) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const texts: string[] = [];
  const outputItems = Array.isArray(data.output) ? data.output : [];

  outputItems.forEach((item) => {
    const contents = Array.isArray(item.content) ? item.content : [];
    contents.forEach((content) => {
      if (typeof content.text === "string") {
        texts.push(content.text);
      }
    });
  });

  return texts.join("\n").trim();
}

function extractJsonPayload(text: string) {
  const trimmed = text.trim();
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  return objectMatch ? objectMatch[0] : trimmed;
}

async function callOpenAIJson(prompt: string) {
  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getOpenAIApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: prompt,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const loweredErrorBody = errorBody.toLowerCase();

    if (response.status === 401 || loweredErrorBody.includes("invalid_api_key")) {
      throw new Error("INVALID_OPENAI_API_KEY");
    }

    throw new Error(`OPENAI_API_ERROR: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  const data = (await response.json()) as OpenAIResponsePayload;
  const text = extractTextFromOpenAIResponse(data);
  return JSON.parse(extractJsonPayload(text || "{}"));
}

function safeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function safeStringArray(value: unknown, limit = 12) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeString(item))
    .filter(Boolean)
    .slice(0, limit);
}

function safeAxisArray(value: unknown): ClarificationAxis[] {
  const allowed = new Set<ClarificationAxis>(["piece", "position", "cote", "niveau"]);
  return safeStringArray(value, 4).filter((item): item is ClarificationAxis => allowed.has(item as ClarificationAxis));
}

function safeSearchKind(value: unknown): SearchKind {
  return value === "match" || value === "clarification" || value === "out_of_stock" ? value : "not_found";
}

function sanitizeDecision(decision: unknown): PartsSearchDecision {
  const record = (decision && typeof decision === "object" ? decision : {}) as Record<string, unknown>;

  return {
    requestedLabel: safeString(record.requestedLabel) || safeString(record.normalizedLabel) || "piece",
    normalizedLabel: safeString(record.normalizedLabel) || safeString(record.requestedLabel) || "piece",
    kind: safeSearchKind(record.kind),
    reply: safeString(record.reply),
    candidateReferences: safeStringArray(record.candidateReferences),
    selectedReferences: safeStringArray(record.selectedReferences),
    clarificationAxes: safeAxisArray(record.clarificationAxes),
  };
}

export function getCatalogPartsByReferences(references: string[]) {
  const seen = new Set<string>();
  const parts: Part[] = [];

  references.forEach((reference) => {
    const part = CATALOG_BY_REFERENCE.get(reference);
    if (!part || seen.has(reference)) return;
    seen.add(reference);
    parts.push(part);
  });

  return parts;
}

function detectSubtypeLabel(designation: string) {
  const upperDesignation = designation.toUpperCase();
  const explicitSubtype = SUBTYPE_PATTERNS.find(({ patterns }) => patterns.some((pattern) => pattern.test(upperDesignation)));
  if (explicitSubtype) return explicitSubtype.label;

  const cleanedTokens = normalize(designation)
    .split(" ")
    .filter((token) => token && !QUALIFIER_TOKENS.has(token) && !STOP_SUBTYPE_TOKENS.has(token));

  if (cleanedTokens.length === 0) return "";

  return cleanedTokens
    .slice(0, Math.min(2, cleanedTokens.length))
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function partMatchesChoice(part: Part, groupKey: string, option: string) {
  const designation = part.designation.toUpperCase();

  if (groupKey === "piece") {
    return detectSubtypeLabel(part.designation) === option;
  }

  switch (option) {
    case "Avant":
      return /\bAV\b/.test(designation) || designation.includes("AVANT");
    case "Arriere":
      return /\bAR\b/.test(designation) || designation.includes("ARRIERE") || designation.includes("AR ");
    case "Gauche":
      return /\bG\b/.test(designation) || designation.includes("GAUCHE");
    case "Droite":
      return /\bD\b/.test(designation) || designation.includes("DROITE") || designation.includes("DROIT");
    case "Superieur":
      return designation.includes("SUPERIEUR") || /\bSUP\b/.test(designation);
    case "Inferieur":
      return designation.includes("INFERIEUR") || /\bINF\b/.test(designation);
    default:
      return false;
  }
}

export function filterPartsByChoices(parts: Part[], selectedChoices: Record<string, string>) {
  const selectedEntries = Object.entries(selectedChoices).filter(([, option]) => Boolean(option));
  if (selectedEntries.length === 0) {
    return parts;
  }

  return parts.filter((part) => selectedEntries.every(([groupKey, option]) => partMatchesChoice(part, groupKey, option)));
}

export function detectAmbiguousAxes(parts: Part[]): ClarificationAxis[] {
  const inStockParts = parts.filter((part) => part.stock > 0);
  if (inStockParts.length <= 1) {
    return [];
  }

  const axes: ClarificationAxis[] = [];
  const subtypeOptions = Array.from(new Set(inStockParts.map((part) => detectSubtypeLabel(part.designation)).filter(Boolean)));

  if (subtypeOptions.length > 1) {
    axes.push("piece");
  }

  const groups = [
    { key: "position", options: ["Avant", "Arriere"] },
    { key: "cote", options: ["Gauche", "Droite"] },
    { key: "niveau", options: ["Superieur", "Inferieur"] },
  ] as const;

  groups.forEach((group) => {
    const availableOptions = group.options.filter((option) => inStockParts.some((part) => partMatchesChoice(part, group.key, option)));
    if (availableOptions.length > 1) {
      axes.push(group.key);
    }
  });

  return axes;
}

export function buildChoiceGroupsFromParts(parts: Part[], axes: ClarificationAxis[]): ChatMessageChoiceGroup[] {
  const inStockParts = parts.filter((part) => part.stock > 0);
  if (inStockParts.length <= 1) return [];

  const axisSet = new Set(axes);
  const groups: ChatMessageChoiceGroup[] = [];

  if (axisSet.has("piece")) {
    const subtypeOptions = Array.from(new Set(inStockParts.map((part) => detectSubtypeLabel(part.designation)).filter(Boolean))).sort((left, right) => left.localeCompare(right, "fr"));
    if (subtypeOptions.length > 1) {
      groups.push({
        key: "piece",
        label: "Piece",
        options: subtypeOptions,
      });
    }
  }

  const possibleGroups = [
    { key: "position", label: "Position", options: ["Avant", "Arriere"] },
    { key: "cote", label: "Cote", options: ["Gauche", "Droite"] },
    { key: "niveau", label: "Niveau", options: ["Superieur", "Inferieur"] },
  ] as const;

  possibleGroups.forEach((group) => {
    if (!axisSet.has(group.key)) return;

    const availableOptions = group.options.filter((option) => inStockParts.some((part) => partMatchesChoice(part, group.key, option)));
    if (availableOptions.length > 1) {
      groups.push({
        key: group.key,
        label: group.label,
        options: availableOptions,
      });
    }
  });

  return groups;
}

export async function searchPartsConversationWithOpenAI(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
  vehicle: VehicleInfo,
): Promise<PartsConversationPlan> {
  const historyBlock = conversationHistory
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");

  const prompt = `Tu es le moteur de recherche principal d'une application tunisienne de pieces Volvo.

VEHICULE:
- Marque: ${vehicle.marque || "VOLVO"}
- Modele: ${vehicle.modele || "Non renseigne"}
- Annee: ${vehicle.annee || "Non renseignee"}
- VIN: ${vehicle.vin || "Non renseigne"}
- Immatriculation: ${vehicle.immatriculation || "Non renseignee"}

HISTORIQUE RECENT:
${historyBlock || "Aucun"}

DERNIER MESSAGE UTILISATEUR:
${userMessage}

CATALOGUE LOCAL VOLVO:
${CATALOG_CONTEXT}

MISSION:
- Comprendre le francais, la darija tunisienne, les fautes, les messages courts et les reponses de suivi comme "avant", "droite", "arriere".
- Utiliser uniquement le catalogue local fourni.
- Ignorer totalement les salutations et la politesse: bonjour, salut, merci, etc. Ne jamais les traiter comme une piece.
- Si le message melange une salutation et une piece, ne garder que la piece.
- Ne jamais proposer des pieces d'une autre famille juste parce qu'elles partagent un cote ou une position.
- Exemple absolu: si l'utilisateur demande "phare" ou "phares", tu dois rester dans la famille optique/phare/projecteur uniquement.
- Tu n'as pas le droit de remplacer "phare" par support pare choc, aile, amortisseur, agrafe, filtre ou autre piece voisine.
- Tu n'as pas le droit de retourner des resultats hors famille juste pour "aider".
- Si aucune piece exacte de la famille demandee n'existe dans le catalogue, retourne "not_found" sans boutons.
- Si une precision manque vraiment, retourne "clarification" avec les references candidates exactes encore plausibles.
- N'affiche des boutons que si plusieurs references exactes et plausibles restent apres filtrage.
- Si la piece exacte existe mais tout le stock correspondant est a 0, retourne "out_of_stock".
- Si une seule piece exacte en stock correspond, retourne "match".
- Si plusieurs pieces exactes en stock correspondent mais qu'elles peuvent etre affichees directement sans confusion, tu peux retourner "match" avec plusieurs references.
- Les prix sont en dinars tunisiens DT.
- Ne parle jamais d'euros.
- Ne mentionne jamais la quantite en stock dans la reponse.

RAPPELS FAMILLES IMPORTANTES:
- phares, phare, optique, projecteur, fanar, fnar => famille phare
- feux, feu, stop, clignotant, antibrouillard, catadioptre => famille feu
- bougie, bougies => bougie d'allumage
- amortisseur => amortisseur uniquement
- aile => aile uniquement
- porte => porte, poignee de porte, serrure de porte, tirant de porte
- vitre => vitre uniquement

RETOURNE UNIQUEMENT UN JSON BRUT AVEC CETTE STRUCTURE:
{
  "intro": "phrase courte si plusieurs recherches",
  "conversationalReply": "reponse si aucun article de recherche n'est demande",
  "searches": [
    {
      "requestedLabel": "libelle utilisateur",
      "normalizedLabel": "libelle propre",
      "kind": "match | clarification | not_found | out_of_stock",
      "reply": "reponse breve et naturelle en francais, sans stock, sans euro",
      "candidateReferences": ["references plausibles pour clarification"],
      "selectedReferences": ["references finales si match ou out_of_stock"],
      "clarificationAxes": ["piece", "position", "cote", "niveau"]
    }
  ]
}`;

  const parsed = await callOpenAIJson(prompt);

  const searches = Array.isArray(parsed?.searches) ? parsed.searches.map(sanitizeDecision).filter((decision) => decision.requestedLabel) : [];

  return {
    intro: safeString(parsed?.intro) || undefined,
    conversationalReply: safeString(parsed?.conversationalReply) || undefined,
    searches,
  };
}
