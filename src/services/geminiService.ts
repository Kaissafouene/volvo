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

  let parsed: Record<string, unknown>;
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
    const error = new Error("INVALID_MODEL") as Error & { detectedMarque?: string; detectedModele?: string };
    error.detectedMarque = typeof parsed.detected_marque === "string" ? parsed.detected_marque : "Non detecte";
    error.detectedModele = typeof parsed.detected_modele === "string" ? parsed.detected_modele : "Non detecte";
    throw error;
  }

  const marque = (parsed.marque || "").toString().toUpperCase().trim();
  if (!marque.includes("VOLVO")) {
    const error = new Error("INVALID_MODEL") as Error & { detectedMarque?: string; detectedModele?: string };
    error.detectedMarque = typeof parsed.marque === "string" ? parsed.marque : "Non detecte";
    error.detectedModele = typeof parsed.modele === "string" ? parsed.modele : "Non detecte";
    throw error;
  }

  const rawImmat = parsed.immatriculation ? parsed.immatriculation.toString() : "";
  parsed.immatriculationRaw = rawImmat;
  parsed.vin = parsed.vin ? parsed.vin.toString().trim().toUpperCase() : extractVinFromText(`${text}\n${parsed.debug_raw || ""}`);
  if (parsed.vin) {
    const compactVin = parsed.vin.replace(/[^A-Z0-9]/gi, "");
    parsed.vin = compactVin.length === 17 ? compactVin : extractVinFromText(`${parsed.vin}\n${text}\n${parsed.debug_raw || ""}`);
  }

  const cleaned = rawImmat.trim().toUpperCase().replace(/[^A-Z0-9 -]/g, "");
  const maybeVin = cleaned.replace(/\s+/g, "");
  const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/i;

  const extractPlateFromText = (source: string) => {
    if (!source) return "";
    const rawMatches = source.match(/\b[A-Z0-9][A-Z0-9\-\s]{2,10}[A-Z0-9]\b/gi) || [];
    const candidates = rawMatches
      .map((value) => value.replace(/[^A-Z0-9]/gi, "").toUpperCase())
      .filter((value) => value.length >= 4 && value.length <= 10 && /[A-Z]/.test(value) && /\d/.test(value) && !vinRegex.test(value));
    return candidates.length ? candidates[0] : "";
  };

  if (maybeVin.length === 17 && vinRegex.test(maybeVin)) {
    const alternative = extractPlateFromText(text);
    if (alternative) {
      parsed.immatriculation = normalizeTunisianPlate(alternative);
      parsed.immatriculationWarning = undefined;
    } else {
      parsed.immatriculation = undefined;
      parsed.immatriculationWarning = "La valeur extraite ressemble a un VIN. Veuillez corriger l'immatriculation.";
    }
  } else {
    const compact = cleaned.replace(/\s|-/g, "");
    if (cleaned.length === 0) {
      const alternative = extractPlateFromText(text);
      parsed.immatriculation = alternative ? normalizeTunisianPlate(alternative) : undefined;
    } else if (compact.length < 3 || compact.length > 12) {
      const alternative = extractPlateFromText(text);
      if (alternative) {
        parsed.immatriculation = normalizeTunisianPlate(alternative);
        parsed.immatriculationWarning = undefined;
      } else {
        parsed.immatriculation = undefined;
        parsed.immatriculationWarning = "Immatriculation douteuse. Veuillez verifier manuellement.";
      }
    } else {
      const alternative = extractPlateFromText(text);
      parsed.immatriculation = normalizeTunisianPlate(alternative && alternative !== cleaned ? alternative : cleaned);
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
}
