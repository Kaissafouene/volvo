import type { RankedPart } from "@/data/partsDatabase";

const env = import.meta.env as Record<string, string | undefined>;
const GEMINI_API_KEY = env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY;
const GEMINI_MODEL = env.VITE_GEMINI_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_BASE_URL = env.VITE_GEMINI_BASE_URL || env.GEMINI_BASE_URL;

function buildGeminiApiUrl() {
  const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  if (!GEMINI_BASE_URL) {
    return fallbackUrl;
  }

  const trimmedBaseUrl = GEMINI_BASE_URL.trim();
  if (!trimmedBaseUrl) {
    return fallbackUrl;
  }

  if (/\/openai\/?$/i.test(trimmedBaseUrl)) {
    console.warn("GEMINI_BASE_URL pointe vers l'endpoint OpenAI-compatible. L'app utilise ici l'API Gemini native generateContent, donc cette valeur est ignoree.");
    return fallbackUrl;
  }

  const normalizedBaseUrl = trimmedBaseUrl.replace(/\/+$/, "");
  if (/\/models$/i.test(normalizedBaseUrl)) {
    return `${normalizedBaseUrl}/${GEMINI_MODEL}:generateContent`;
  }

  if (/\/v1beta$/i.test(normalizedBaseUrl)) {
    return `${normalizedBaseUrl}/models/${GEMINI_MODEL}:generateContent`;
  }

  return `${normalizedBaseUrl}/models/${GEMINI_MODEL}:generateContent`;
}

const GEMINI_API_URL = buildGeminiApiUrl();

function getGeminiApiKey() {
  if (!GEMINI_API_KEY) {
    console.error("Aucune cle Gemini n'est definie dans les variables d'environnement. Utilise VITE_GEMINI_API_KEY ou GEMINI_API_KEY.");
    throw new Error("MISSING_GEMINI_API_KEY");
  }

  return GEMINI_API_KEY;
}

export interface VehicleInfo {
  id?: number;
  immatriculation?: string;
  immatriculationRaw?: string;
  immatriculationWarning?: string;
  vin?: string;
  marque?: string;
  modele?: string;
  typeMoteur?: string;
  annee?: string;
}

export interface PartSearchIntent {
  normalizedQuery: string;
  alternateQueries: string[];
  referenceHint?: string;
  askForClarification?: boolean;
  clarificationQuestion?: string;
}

export interface PartsBatchPlan {
  intro?: string;
  items: string[];
}

interface GeminiSearchResolution {
  resultType: "match" | "clarification" | "not_found";
  answer: string;
  selectedReferences?: string[];
}

const AUTO_VOCABULARY_HINTS: Array<{ canonical: string; variants: string[] }> = [
  {
    canonical: "echappement",
    variants: [
      "chaqment",
      "cha9ment",
      "chakment",
      "chaqman",
      "cha9man",
      "chakman",
      "chappement",
      "echapman",
      "echapement",
      "pot",
      "silencieux",
    ],
  },
  {
    canonical: "amortisseur",
    variants: ["amorti", "amorto", "amortisseur", "amor", "suspension"],
  },
  {
    canonical: "aile",
    variants: ["aile", "fender"],
  },
  {
    canonical: "pare choc",
    variants: ["pare choc", "parechoc", "parchoque", "parchoc"],
  },
  {
    canonical: "phare",
    variants: ["phare", "fanal", "fanal", "fnar", "fanar"],
  },
  {
    canonical: "feu",
    variants: ["feu", "stop", "clignotant"],
  },
  {
    canonical: "filtre a huile",
    variants: ["filtre huile", "filter huile", "filtre زيت", "filtre zit"],
  },
  {
    canonical: "filtre a air",
    variants: ["filtre air", "filter air"],
  },
  {
    canonical: "plaquette de frein",
    variants: ["plaquette", "plaquettes", "plaket", "plaquette frein"],
  },
  {
    canonical: "retroviseur",
    variants: ["retro", "retroviseur", "miroir", "mirwar"],
  },
  {
    canonical: "capot",
    variants: ["capot", "hood"],
  },
];

const LOCAL_AUTOMOTIVE_TERMS = [
  "phare",
  "feu",
  "aile",
  "amortisseur",
  "echappement",
  "retroviseur",
  "porte",
  "vitre",
  "capot",
  "pare choc",
  "filtre",
  "frein",
  "cardan",
  "triangle",
  "roulement",
  "avant",
  "arriere",
  "gauche",
  "droite",
  "superieur",
  "inferieur",
];

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAutoQueryLocally(message: string) {
  let rewritten = message;
  const detectedCanonicals = new Set<string>();

  AUTO_VOCABULARY_HINTS.forEach(({ canonical, variants }) => {
    variants.forEach((variant) => {
      const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(variant)}(?=[^a-z0-9]|$)`, "gi");
      if (pattern.test(rewritten)) {
        detectedCanonicals.add(canonical);
        rewritten = rewritten.replace(pattern, (_match, prefix) => `${prefix}${canonical}`);
      }
    });
  });

  return {
    rewritten: rewritten.replace(/\s+/g, " ").trim(),
    detectedCanonicals: Array.from(detectedCanonicals),
  };
}

function splitLikelyParts(rawMessage: string) {
  return rawMessage
    .split(/\s*(?:,|;|\/|\bet\b|\bou\b|\bw\b|\+)\s*/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanBatchItem(rawItem: string) {
  return rawItem
    .replace(/^(behi|choufli|chouf|nheb|n7eb|lawwejli|lawwej|heb|bghit|brabi|svp|s'il te plait)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFastLocalIntent(message: string, rewritten: string, conversationHistory: Array<{ role: string; content: string }>): PartSearchIntent | null {
  const normalizedRewritten = rewritten
    .replace(/^(behi|choufli|chouf|nheb|n7eb|lawwejli|lawwej|heb|bghit|famma|tawa|brabi)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const normalizedLower = normalizedRewritten.toLowerCase();
  const containsAutomotiveTerm = LOCAL_AUTOMOTIVE_TERMS.some((term) => normalizedLower.includes(term));
  const tokenCount = normalizedLower.split(/\s+/).filter(Boolean).length;
  const isShortVariantReply = /^(avant|arriere|gauche|droite|superieur|inferieur|avant droite|avant gauche|arriere droite|arriere gauche)$/i.test(normalizedLower);

  if (!containsAutomotiveTerm && !isShortVariantReply) {
    return null;
  }

  if (isShortVariantReply && conversationHistory.length === 0) {
    return null;
  }

  if (containsAutomotiveTerm && tokenCount <= 7) {
    return {
      normalizedQuery: normalizedRewritten,
      alternateQueries: [],
      askForClarification: false,
    };
  }

  if (isShortVariantReply) {
    return {
      normalizedQuery: normalizedRewritten,
      alternateQueries: [],
      askForClarification: false,
    };
  }

  return null;
}

function extractJsonPayload(text: string) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return jsonMatch ? jsonMatch[0] : text;
}

function extractVinFromText(text: string) {
  if (!text) return "";

  const vinRegex = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
  const matches = text.match(vinRegex) || [];
  return matches.length ? matches[0].toUpperCase() : "";
}

function normalizeTunisianPlate(rawValue: string) {
  if (!rawValue) return "";

  const upperValue = rawValue.toUpperCase().replace(/[()]/g, " ");
  const explicitMatch = upperValue.match(/(\d{1,5})\s*(?:TU|TUNISIE|TUNISIA)\s*(\d{1,5})/i);
  if (explicitMatch) {
    return `${explicitMatch[1]} TU ${explicitMatch[2]}`;
  }

  const numericGroups = upperValue.match(/\d{1,5}/g) || [];
  if (numericGroups.length >= 2) {
    const uniqueGroups = Array.from(new Set(numericGroups));
    const first = uniqueGroups[0];
    const second = uniqueGroups[1];

    // Common Tunisian registration style: the shorter block generally comes first.
    if (first.length !== second.length) {
      return first.length < second.length ? `${first} TU ${second}` : `${second} TU ${first}`;
    }

    return `${first} TU ${second}`;
  }

  return rawValue.trim().toUpperCase().replace(/\s+/g, " ");
}

function salvageVehicleInfoFromText(text: string): Partial<VehicleInfo> | null {
  if (!text) return null;

  const rawText = text.replace(/```json|```/gi, "").trim();
  const marqueMatch = rawText.match(/"marque"\s*:\s*"([^"]+)"/i);
  const modeleMatch = rawText.match(/"modele"\s*:\s*"([^"]+)"/i);
  const immatMatch = rawText.match(/"immatriculation"\s*:\s*"([^"]+)"/i);
  const vinMatch = rawText.match(/"vin"\s*:\s*"([^"]+)"/i);
  const anneeMatch = rawText.match(/"annee"\s*:\s*"?(20\d{2}|19\d{2})"?/i);
  const typeMoteurMatch = rawText.match(/"typeMoteur"\s*:\s*"([^"]+)"/i);

  const salvaged: Partial<VehicleInfo> = {
    marque: marqueMatch?.[1]?.trim(),
    modele: modeleMatch?.[1]?.trim(),
    immatriculation: immatMatch?.[1]?.trim(),
    vin: vinMatch?.[1]?.trim() || extractVinFromText(rawText),
    annee: anneeMatch?.[1]?.trim(),
    typeMoteur: typeMoteurMatch?.[1]?.trim(),
  };

  const hasUsefulData = Boolean(salvaged.marque || salvaged.modele || salvaged.immatriculation || salvaged.annee);
  return hasUsefulData ? salvaged : null;
}

async function runFallbackVehicleOcr(mimeType: string, base64Data: string) {
  const fallbackPrompt = `Lis cette carte grise Volvo et retourne un JSON tres court avec les champs dans cet ordre exact:
{
  "marque": "VOLVO ou autre marque detectee",
  "modele": "modele ou null",
  "annee": "annee ou null",
  "immatriculation": "immatriculation tunisienne au format 246 TU 9072 ou null",
  "vin": "VIN 17 caracteres ou null"
}

Regles:
- Reponds uniquement en JSON.
- Pas de texte autour.
- Ne confonds pas le VIN avec l'immatriculation.
- Si la marque n'est pas Volvo, retourne quand meme la marque detectee.`;

  const text = await callGemini(
    [
      { text: fallbackPrompt },
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data,
        },
      },
    ],
      {
        temperature: 0.1,
        topK: 1,
        topP: 0.95,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    );

  const jsonText = extractJsonPayload(text || "{}");
  try {
    return JSON.parse(jsonText) as Partial<VehicleInfo>;
  } catch {
    return salvageVehicleInfoFromText(text || "") || {};
  }
}

async function callGemini(parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>, generationConfig?: Record<string, unknown>) {
  const response = await fetch(`${GEMINI_API_URL}?key=${getGeminiApiKey()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts }],
      ...(generationConfig ? { generationConfig } : {}),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const loweredErrorBody = errorBody.toLowerCase();

    if (loweredErrorBody.includes("api key not valid") || loweredErrorBody.includes("api_key_invalid")) {
      throw new Error("INVALID_GEMINI_API_KEY");
    }

    if (loweredErrorBody.includes("permission_denied") || loweredErrorBody.includes("permission denied")) {
      throw new Error("GEMINI_PERMISSION_DENIED");
    }

    throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

export async function extractVehicleInfoFromImage(imageData: string): Promise<VehicleInfo> {
  const prompt = `Tu es un expert OCR specialise dans l'extraction de donnees de cartes grises.

OBJECTIF:
- Lire la carte grise.
- Verifier si la marque du vehicule est VOLVO.
- Extraire l'immatriculation, le VIN, la marque, le modele, le type moteur et l'annee si visibles.

CONSIGNES:
- Cherche d'abord la marque VOLVO n'importe ou sur le document.
- Si possible, retourne l'immatriculation tunisienne au format propre "246 TU 9072" ou "12345 TU 678".
- Si la marque visible n'est pas VOLVO, retourne exactement:
{"error":"invalid_model","detected_marque":"[marque vue ou inconnue]","detected_modele":"[modele vu ou inconnu]"}
- Si l'image est illisible, retourne exactement:
{"error":"unreadable","reason":"description courte"}
- Ne confonds jamais le VIN avec l'immatriculation.
- Le VIN est un identifiant de 17 caracteres alphanumeriques.
- Remplis debug_raw avec le texte principal visible pour le diagnostic.

RETOURNE TOUJOURS UN JSON BRUT, SANS TEXTE AUTOUR:
{
  "immatriculation": "numero trouve ou null",
  "vin": "vin trouve ou null",
  "marque": "VOLVO si trouve, sinon la marque vue",
  "modele": "modele trouve ou null",
  "typeMoteur": "type moteur si visible ou null",
  "annee": "annee sur 4 chiffres ou null",
  "debug_raw": "texte principal visible"
}`;

  try {
    let mimeType = "image/jpeg";
    if (imageData.startsWith("data:image/png")) mimeType = "image/png";
    else if (imageData.startsWith("data:image/jpeg")) mimeType = "image/jpeg";
    else if (imageData.startsWith("data:image/jpg")) mimeType = "image/jpeg";
    else if (imageData.startsWith("data:image/webp")) mimeType = "image/webp";
    else if (imageData.startsWith("data:image/heic")) mimeType = "image/heic";
    else if (imageData.startsWith("data:image/heif")) mimeType = "image/heif";
    else if (imageData.startsWith("data:application/pdf")) mimeType = "application/pdf";

    const base64Data = imageData.split(",")[1];
    const text = await callGemini(
      [
        { text: prompt },
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Data,
          },
        },
      ],
      {
        temperature: 0.1,
        topK: 1,
        topP: 0.95,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    );

    const jsonText = extractJsonPayload(text || "{}");

    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      const salvaged = salvageVehicleInfoFromText(text || "");
      if (!salvaged) {
        throw new Error("PARSE_ERROR");
      }

      parsed = {
        ...salvaged,
        debug_raw: text,
      };
    }

    const needsFallbackPass =
      !parsed?.marque ||
      !parsed?.modele ||
      !parsed?.annee ||
      !parsed?.vin ||
      (parsed?.vin && parsed.vin.toString().replace(/[^A-Z0-9]/gi, "").length < 17);

    if (needsFallbackPass) {
      try {
        const fallbackParsed = await runFallbackVehicleOcr(mimeType, base64Data);
        parsed = {
          ...fallbackParsed,
          ...parsed,
          // Prefer non-empty fallback values when the first pass was truncated.
          marque: parsed?.marque || fallbackParsed?.marque,
          modele: parsed?.modele || fallbackParsed?.modele,
          annee: parsed?.annee || fallbackParsed?.annee,
          immatriculation: parsed?.immatriculation || fallbackParsed?.immatriculation,
          vin: parsed?.vin || fallbackParsed?.vin,
        };
      } catch (fallbackError) {
        console.warn("Fallback OCR pass failed:", fallbackError);
      }
    }

    if (parsed?.error === "unreadable") {
      throw new Error("UNREADABLE_IMAGE");
    }

    if (parsed?.error === "invalid_model") {
      const error = new Error("INVALID_MODEL") as any;
      error.detectedMarque = parsed.detected_marque || "Non detecte";
      error.detectedModele = parsed.detected_modele || "Non detecte";
      throw error;
    }

    const marque = (parsed.marque || "").toString().toUpperCase().trim();
    if (!marque.includes("VOLVO")) {
      const error = new Error("INVALID_MODEL") as any;
      error.detectedMarque = parsed.marque || "Non detecte";
      error.detectedModele = parsed.modele || "Non detecte";
      throw error;
    }

    const rawImmat = parsed.immatriculation ? parsed.immatriculation.toString() : "";
    parsed.immatriculationRaw = rawImmat;
    parsed.vin = parsed.vin ? parsed.vin.toString().trim().toUpperCase() : extractVinFromText(`${text}\n${parsed.debug_raw || ""}`);
    if (parsed.vin) {
      const compactVin = parsed.vin.replace(/[^A-Z0-9]/gi, "");
      parsed.vin = compactVin.length === 17 ? compactVin : extractVinFromText(`${parsed.vin}\n${text}\n${parsed.debug_raw || ""}`);
    }

    const cleaned = rawImmat.trim().toUpperCase().replace(/[^A-Z0-9\- ]/g, "");
    const maybeVin = cleaned.replace(/\s+/g, "");
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/i;

    const extractPlateFromText = (src: string) => {
      if (!src) return "";
      const rawMatches = src.match(/\b[A-Z0-9][A-Z0-9\-\s]{2,10}[A-Z0-9]\b/gi) || [];
      const candidates = rawMatches
        .map((s) => s.replace(/[^A-Z0-9]/gi, "").toUpperCase())
        .filter((s) => s.length >= 4 && s.length <= 10 && /[A-Z]/.test(s) && /\d/.test(s) && !vinRegex.test(s));
      return candidates.length ? candidates[0] : "";
    };

    if (maybeVin.length === 17 && vinRegex.test(maybeVin)) {
      const alt = extractPlateFromText(text);
      if (alt) {
        parsed.immatriculation = normalizeTunisianPlate(alt);
        parsed.immatriculationWarning = undefined;
      } else {
        parsed.immatriculation = undefined;
        parsed.immatriculationWarning = "La valeur extraite ressemble a un VIN. Veuillez corriger l'immatriculation.";
      }
    } else {
      const compact = cleaned.replace(/\s|\-/g, "");
      if (cleaned.length === 0) {
        const alt = extractPlateFromText(text);
        parsed.immatriculation = alt ? normalizeTunisianPlate(alt) : undefined;
      } else if (compact.length < 3 || compact.length > 12) {
        const alt = extractPlateFromText(text);
        if (alt) {
          parsed.immatriculation = normalizeTunisianPlate(alt);
          parsed.immatriculationWarning = undefined;
        } else {
          parsed.immatriculation = undefined;
          parsed.immatriculationWarning = "Immatriculation douteuse. Veuillez verifier manuellement.";
        }
      } else {
        const alt = extractPlateFromText(text);
        parsed.immatriculation = normalizeTunisianPlate(alt && alt !== cleaned ? alt : cleaned);
      }
    }

    parsed.marque = "VOLVO";
    parsed.modele = parsed.modele ? parsed.modele.toString().trim() : undefined;

    const yearRaw = (parsed.annee || "").toString();
    const yearMatch = yearRaw.match(/(20\d{2}|19\d{2})/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10);
      const currentYear = new Date().getFullYear() + 1;
      parsed.annee = year >= 2000 && year <= currentYear ? String(year) : undefined;
    } else {
      parsed.annee = undefined;
    }

    if (parsed.typeMoteur) {
      parsed.typeMoteur = parsed.typeMoteur.toString().trim();
    }

    return parsed;
  } catch (error) {
    console.error("Error extracting vehicle info:", error);
    throw error;
  }
}

export async function analyzePartSearchIntent(
  message: string,
  conversationHistory: Array<{ role: string; content: string }>,
  vehicle?: VehicleInfo,
): Promise<PartSearchIntent> {
  const localNormalization = normalizeAutoQueryLocally(message);
  const fastIntent = buildFastLocalIntent(message, localNormalization.rewritten, conversationHistory);
  if (fastIntent) {
    if (localNormalization.detectedCanonicals.length > 0) {
      fastIntent.alternateQueries = Array.from(new Set([...localNormalization.detectedCanonicals, ...fastIntent.alternateQueries]));
    }
    return fastIntent;
  }
  const prompt = `Tu analyses une demande utilisateur pour rechercher une piece automobile Volvo.

VEHICULE:
- Marque: ${vehicle?.marque || "VOLVO"}
- Modele: ${vehicle?.modele || "Volvo"}
- Annee: ${vehicle?.annee || "Non renseignee"}

HISTORIQUE RECENT:
${conversationHistory.slice(-6).map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n") || "Aucun"}

DERNIER MESSAGE UTILISATEUR:
${message}

LECTURE NORMALISEE LOCALE:
${localNormalization.rewritten}

OBJECTIF:
- Comprendre la demande meme si elle est en darija tunisienne, en francais approximatif, en anglais, ou tres courte.
- Reformuler la recherche en francais clair pour la base de pieces.
- Detecter un indice de reference si l'utilisateur a probablement tape une reference.
- Si le message est juste une precision courte comme "avant droit" ou "gauche", reconstruire l'intention complete a partir de l'historique.
- Indices darija importants: "chaqment", "cha9ment", "chakman" et variantes designent l'echappement.
- N'ajoute jamais "avant", "arriere", "gauche" ou "droite" si l'utilisateur ne l'a pas demande explicitement.

RETOURNE UNIQUEMENT UN JSON BRUT:
{
  "normalizedQuery": "requete principale en francais",
  "alternateQueries": ["variante utile 1", "variante utile 2"],
  "referenceHint": "reference si probable sinon null",
  "askForClarification": false,
  "clarificationQuestion": "question si necessaire sinon chaine vide"
}`;

  try {
    const text = await callGemini([{ text: prompt }], {
      temperature: 0.2,
      topP: 0.95,
      maxOutputTokens: 512,
      responseMimeType: "application/json",
      thinkingConfig: {
        thinkingBudget: 0,
      },
    });

    const parsed = JSON.parse(extractJsonPayload(text || "{}")) as PartSearchIntent;
    const normalizedQuery = parsed.normalizedQuery || localNormalization.rewritten || message;
    const alternateQueries = Array.isArray(parsed.alternateQueries) ? parsed.alternateQueries.filter(Boolean).slice(0, 4) : [];

    if (localNormalization.detectedCanonicals.length > 0) {
      localNormalization.detectedCanonicals.forEach((canonical) => {
        if (!alternateQueries.includes(canonical) && canonical !== normalizedQuery) {
          alternateQueries.unshift(canonical);
        }
      });
    }

    return {
      normalizedQuery,
      alternateQueries: alternateQueries.slice(0, 4),
      referenceHint: parsed.referenceHint || undefined,
      askForClarification: localNormalization.detectedCanonicals.length > 0 ? false : Boolean(parsed.askForClarification),
      clarificationQuestion: localNormalization.detectedCanonicals.length > 0 ? undefined : parsed.clarificationQuestion || undefined,
    };
  } catch (error) {
    console.warn("Falling back to raw search intent:", error);
    return {
      normalizedQuery: localNormalization.rewritten || message,
      alternateQueries: localNormalization.detectedCanonicals,
    };
  }
}

export async function analyzePartsBatchRequest(
  message: string,
  conversationHistory: Array<{ role: string; content: string }>,
  vehicle?: VehicleInfo,
): Promise<PartsBatchPlan> {
  const localNormalization = normalizeAutoQueryLocally(message);
  const localItems = splitLikelyParts(localNormalization.rewritten || message).map(cleanBatchItem).filter(Boolean);
  const localSingleIntent = buildFastLocalIntent(message, localNormalization.rewritten, conversationHistory);

  if (localItems.length > 1) {
    return {
      intro: "Nous allons rechercher les pieces demandees dans l'ordre de votre demande.",
      items: localItems,
    };
  }

  if (localSingleIntent && localItems.length === 1) {
    return {
      items: [localItems[0]],
    };
  }

  const prompt = `Tu analyses une demande utilisateur pour rechercher une ou plusieurs pieces automobiles Volvo.

VEHICULE:
- Marque: ${vehicle?.marque || "VOLVO"}
- Modele: ${vehicle?.modele || "Volvo"}
- Annee: ${vehicle?.annee || "Non renseignee"}

HISTORIQUE RECENT:
${conversationHistory.slice(-6).map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n") || "Aucun"}

DERNIER MESSAGE UTILISATEUR:
${message}

LECTURE NORMALISEE LOCALE:
${localNormalization.rewritten}

OBJECTIF:
- Detecter si l'utilisateur demande une seule piece ou plusieurs pieces.
- Comprendre la darija tunisienne, le francais approximatif et les listes separees par "et", "ou", "," ou "w".
- Retourner les pieces demandees dans l'ordre exact de la demande utilisateur.
- Ne pas inventer de pieces.
- Exemple important: "chaqment" ou variantes doivent etre compris comme "echappement".

RETOURNE UNIQUEMENT UN JSON BRUT:
{
  "intro": "phrase courte si plusieurs pieces sont demandees, sinon chaine vide",
  "items": ["piece 1", "piece 2", "piece 3"]
}`;

  try {
    const text = await callGemini([{ text: prompt }], {
      temperature: 0.2,
      topP: 0.95,
      maxOutputTokens: 512,
      responseMimeType: "application/json",
      thinkingConfig: {
        thinkingBudget: 0,
      },
    });

    const parsed = JSON.parse(extractJsonPayload(text || "{}")) as PartsBatchPlan;
    const items = Array.isArray(parsed.items) ? parsed.items.map((item) => cleanBatchItem(item || "")).filter(Boolean) : [];

    if (localItems.length > 1 && items.length <= 1) {
      return {
        intro: parsed.intro || undefined,
        items: localItems,
      };
    }

    if (items.length > 0) {
      return {
        intro: parsed.intro || undefined,
        items,
      };
    }
  } catch (error) {
    console.warn("Falling back to single-item batch plan:", error);
  }

  const fallbackItems = localItems;
  return {
    items: fallbackItems.length > 0 ? fallbackItems : [message.trim()].filter(Boolean),
  };
}

export async function resolvePartSearchWithGemini(
  message: string,
  conversationHistory: Array<{ role: string; content: string }>,
  context: string,
  candidates: RankedPart[],
  intent: PartSearchIntent,
): Promise<string> {
  const prompt = `Tu es le conseiller IA Volvo d'une demonstration premium specialisee dans la recherche de pieces de rechange.

CONTEXTE VEHICULE:
${context}

HISTORIQUE RECENT:
${conversationHistory.slice(-8).map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`).join("\n") || "Aucun"}

MESSAGE UTILISATEUR:
${message}

INTENTION NORMALISEE:
${JSON.stringify(intent, null, 2)}

CANDIDATS DISPONIBLES DANS LE CATALOGUE LOCAL:
${JSON.stringify(
    candidates.map((candidate) => ({
      reference: candidate.reference,
      designation: candidate.designation,
      priceHT: candidate.priceHT,
      stock: candidate.stock,
      type: candidate.vehicleType,
      score: Number(candidate.searchScore.toFixed(2)),
      signals: candidate.searchSignals,
    })),
    null,
    2,
  )}

REGLES ABSOLUES:
- Reponds toujours en francais correct, fluide, rassurant et professionnel.
- Comprends la darija tunisienne et les formulations approximatives.
- N'utilise que les candidats fournis ci-dessus.
- N'invente jamais une reference ou une designation.
- Si plusieurs variantes sont encore ambiguës, retourne une clarification elegante et concise.
- Si aucun candidat n'est credible, retourne "Non disponible dans la base." exactement.
- Si tu selectionnes des pieces, limite-toi aux 3 meilleures correspondances.

RETOURNE UNIQUEMENT UN JSON BRUT:
{
  "resultType": "match | clarification | not_found",
  "answer": "reponse finale a afficher a l'utilisateur",
  "selectedReferences": ["refs retenues si utiles"]
}`;

  try {
    const text = await callGemini([{ text: prompt }], {
      temperature: 0.2,
      topP: 0.95,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      thinkingConfig: {
        thinkingBudget: 0,
      },
    });

    const parsed = JSON.parse(extractJsonPayload(text || "{}")) as GeminiSearchResolution;
    if (parsed.answer?.trim()) {
      return parsed.answer.trim();
    }
    return "Non disponible dans la base.";
  } catch (error) {
    console.error("Error resolving part search with Gemini:", error);
    throw error;
  }
}
