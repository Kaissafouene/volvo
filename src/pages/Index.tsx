import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { ChatMessage, type ChatMessageChoiceGroup } from "@/components/ChatMessage";
import { VehicleMessage } from "@/components/VehicleMessage";
import { ImageUpload } from "@/components/ImageUpload";
import { Header } from "@/components/Header";
import {
  analyzePartSearchIntent,
  analyzePartsBatchRequest,
  extractVehicleInfoFromImage,
  type VehicleInfo,
} from "@/services/geminiService";
import { buildPartSearchCandidates, type RankedPart } from "@/data/partsDatabase";
import { volvoParts } from "@/data/volvoPartsDatabase";

interface Message {
  id: string;
  role: "user" | "assistant" | "vehicle";
  content: string;
  vehicleInfo?: VehicleInfo;
  choiceGroups?: ChatMessageChoiceGroup[];
}

interface SearchTask {
  id: string;
  requestedLabel: string;
  searchPrompt?: string;
}

interface ActiveVariantSelection {
  messageId: string;
  task: SearchTask;
  candidates: RankedPart[];
  choiceGroups: ChatMessageChoiceGroup[];
  selectedChoices: Record<string, string>;
  remainingTasks: SearchTask[];
}

interface SearchMemory {
  family?: string;
  normalizedQuery?: string;
}

const CONTACT_BLOCK = `Cette piece n'est pas disponible en stock pour le moment.\nPour suivre l'arrivage de cette piece, merci de contacter directement le siege sur place :\n86, rue 8603 Zone industrielle Charguia 1, Tunis, Tunisia, 2035\nou par telephone : 36 028 020`;

const KNOWN_FAMILIES = [
  "echappement",
  "amortisseur",
  "aile",
  "porte",
  "phare",
  "feu",
  "filtre",
  "frein",
  "pare choc",
  "capot",
  "retroviseur",
  "vitre",
  "cardan",
  "triangle",
  "roulement",
  "batterie",
];

const FAMILY_SUBTYPES: Record<string, string[]> = {
  echappement: ["marmite", "joint", "soupape", "support", "catalyseur", "ligne", "silencieux", "pot"],
  amortisseur: ["support", "roulement", "toc", "ressort"],
  aile: ["extension", "support", "garniture"],
  phare: ["optique", "projecteur"],
  feu: ["clignotant", "antibrouillard"],
};

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

const COURTESY_TERMS = ["merci", "merci beaucoup", "merci sahbi", "sahbi", "shukran", "barakallah", "yaatik essaha", "bravo", "sa7a", "thank you", "thx"];

const QUALIFIER_TOKENS = new Set(["av", "avant", "ar", "arriere", "g", "gauche", "d", "droite", "droit", "sup", "superieur", "inf", "inferieur", "int", "interieur", "ext", "exterieur"]);
const STOP_SUBTYPE_TOKENS = new Set(["de", "du", "des", "d", "la", "le", "les"]);

const SUBTYPE_PATTERNS: Array<{ label: string; patterns: RegExp[] }> = [
  { label: "Marmite", patterns: [/MARMITE/, /SILENCIEUX/] },
  { label: "Joint", patterns: [/\bJOINT\b/] },
  { label: "Soupape", patterns: [/SOUPAPE/] },
  { label: "Roulement support", patterns: [/ROULEMENT SUPPORT/] },
  { label: "Support", patterns: [/SUPPORT/] },
  { label: "Catalyseur", patterns: [/CATALYSEUR/] },
  { label: "Ligne", patterns: [/\bLIGNE\b/] },
  { label: "Roulement", patterns: [/\bROULEMENT\b/] },
  { label: "Toc amortisseur", patterns: [/\bTOC\b/, /\bTOCS\b/] },
  { label: "Optique", patterns: [/OPTIQUE/, /PROJECTEUR/] },
  { label: "Clignotant", patterns: [/CLIGNOTANT/, /CLIGNO/] },
  { label: "Plaquette", patterns: [/PLAQUETTE/] },
  { label: "Disque", patterns: [/DISQUE/] },
  { label: "Etrier", patterns: [/ETRIER/] },
  { label: "Cardan", patterns: [/CARDAN/] },
  { label: "Triangle", patterns: [/TRIANGLE/] },
  { label: "Capot", patterns: [/\bCAPOT\b/] },
  { label: "Porte", patterns: [/\bPORTE\b/] },
  { label: "Aile", patterns: [/\bAILE\b/] },
  { label: "Amortisseur", patterns: [/AMORTISSEUR/] },
  { label: "Phare", patterns: [/PHARE/, /OPTIQUE/] },
  { label: "Feu", patterns: [/\bFEU\b/] },
];

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const mergeCandidatePools = (queries: string[]) => {
  const merged = new Map<string, RankedPart>();

  queries
    .filter(Boolean)
    .forEach((query) => {
      buildPartSearchCandidates(query, "volvo", 24).forEach((candidate) => {
        const existing = merged.get(candidate.reference);
        if (!existing || candidate.searchScore > existing.searchScore) {
          merged.set(candidate.reference, candidate);
          return;
        }

        merged.set(candidate.reference, {
          ...existing,
          searchScore: Math.max(existing.searchScore, candidate.searchScore),
          searchSignals: Array.from(new Set([...existing.searchSignals, ...candidate.searchSignals])),
        });
      });
    });

  return Array.from(merged.values())
    .sort((a, b) => b.searchScore - a.searchScore || b.stock - a.stock)
    .slice(0, 30);
};

const queryMentionsChoice = (query: string, option: string) => {
  const normalizedQuery = normalize(query);
  const aliases: Record<string, string[]> = {
    Avant: ["avant", "av"],
    Arriere: ["arriere", "ar"],
    Gauche: ["gauche", "conducteur"],
    Droite: ["droite", "passager"],
    Superieur: ["superieur"],
    Inferieur: ["inferieur"],
  };

  return (aliases[option] || [option.toLowerCase()]).some((alias) => normalizedQuery.includes(alias));
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

const candidateMatchesChoice = (candidate: RankedPart, groupKey: string, option: string) => {
  const designation = candidate.designation.toUpperCase();

  if (groupKey === "piece") {
    return detectSubtypeLabel(candidate.designation) === option;
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
};

const buildChoiceGroups = (candidates: RankedPart[], query: string): ChatMessageChoiceGroup[] => {
  const inStockCandidates = candidates.filter((candidate) => candidate.stock > 0);
  if (inStockCandidates.length <= 1) return [];

  const groups: ChatMessageChoiceGroup[] = [];
  const family = extractFamilyFromText(query);
  const primarySubtype = family ? PRIMARY_FAMILY_SUBTYPE[family] : undefined;
  const subtypeOptions = Array.from(new Set(inStockCandidates.map((candidate) => detectSubtypeLabel(candidate.designation)).filter(Boolean))).sort((left, right) => {
    const leftPrimary = primarySubtype && left === primarySubtype ? 1 : 0;
    const rightPrimary = primarySubtype && right === primarySubtype ? 1 : 0;
    if (leftPrimary !== rightPrimary) {
      return rightPrimary - leftPrimary;
    }

    return left.localeCompare(right, "fr");
  });
  const remainingSubtypeOptions = subtypeOptions.filter((option) => !queryMentionsChoice(query, option));
  if (remainingSubtypeOptions.length > 1) {
    return [{
      key: "piece",
      label: "Piece",
      options: remainingSubtypeOptions,
    }];
  }

  const possibleGroups = [
    { key: "position", label: "Position", options: ["Avant", "Arriere"] },
    { key: "cote", label: "Cote", options: ["Gauche", "Droite"] },
    { key: "niveau", label: "Niveau", options: ["Superieur", "Inferieur"] },
  ];

  possibleGroups.forEach((group) => {
    const availableOptions = group.options.filter((option) => inStockCandidates.some((candidate) => candidateMatchesChoice(candidate, group.key, option)));
    if (availableOptions.length > 1) {
      const remainingOptions = availableOptions.filter((option) => !queryMentionsChoice(query, option));
      if (remainingOptions.length > 0) {
        groups.push({
          key: group.key,
          label: group.label,
          options: remainingOptions,
        });
      }
    }
  });

  return groups;
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

const filterCandidatesByChoices = (candidates: RankedPart[], selectedChoices: Record<string, string>) => {
  const selectedEntries = Object.entries(selectedChoices).filter(([, option]) => Boolean(option));
  if (selectedEntries.length === 0) return candidates;

  return candidates.filter((candidate) =>
    selectedEntries.every(([groupKey, option]) => candidateMatchesChoice(candidate, groupKey, option)),
  );
};

const formatAvailablePartsResponse = (label: string, candidates: RankedPart[]) => {
  const visibleCandidates = candidates.filter((candidate) => candidate.stock > 0).slice(0, 3);
  if (visibleCandidates.length === 0) {
    return CONTACT_BLOCK;
  }

  const intro =
    visibleCandidates.length === 1
      ? `Oui, nous avons trouve une correspondance disponible pour ${label}.`
      : `Oui, nous avons trouve ${visibleCandidates.length} correspondances disponibles pour ${label}.`;

  const blocks = visibleCandidates.map((candidate) => {
    return [
      `Reference : ${candidate.reference}`,
      `Designation : ${candidate.designation}`,
      `Prix HT : ${candidate.priceHT}`,
      "Stock : Disponible",
    ].join("\n");
  });

  return [intro, ...blocks].join("\n\n");
};

const formatVariantQuestion = (label: string, choiceGroups: ChatMessageChoiceGroup[]) => {
  const availableDimensions = choiceGroups.map((group) => group.label.toLowerCase()).join(", ");
  return `Oui, nous avons des resultats disponibles pour ${label}.\nPrecisez ${availableDimensions} pour afficher la piece exacte.`;
};

const formatQueueIntro = () => {
  return "Nous allons rechercher les pieces demandees dans l'ordre de votre demande.";
};

const extractChoicesFromText = (value: string) => {
  const normalizedValue = normalize(value);
  const extracted: Record<string, string> = {};

  if (/(^|\s)(avant|av)(\s|$)/.test(normalizedValue)) {
    extracted.position = "Avant";
  } else if (/(^|\s)(arriere|ar)(\s|$)/.test(normalizedValue)) {
    extracted.position = "Arriere";
  }

  if (/(^|\s)gauche(\s|$)/.test(normalizedValue)) {
    extracted.cote = "Gauche";
  } else if (/(^|\s)(droite|droit)(\s|$)/.test(normalizedValue)) {
    extracted.cote = "Droite";
  }

  if (/(^|\s)superieur(\s|$)/.test(normalizedValue)) {
    extracted.niveau = "Superieur";
  } else if (/(^|\s)inferieur(\s|$)/.test(normalizedValue)) {
    extracted.niveau = "Inferieur";
  }

  return extracted;
};

const extractFamilyFromText = (value: string) => {
  const normalizedValue = normalize(value);
  return KNOWN_FAMILIES.find((family) => normalizedValue.includes(family));
};

const hasAutomotiveIntent = (value: string) => {
  const normalizedValue = normalize(value);
  if (!normalizedValue) return false;

  return (
    KNOWN_FAMILIES.some((family) => normalizedValue.includes(family)) ||
    Object.values(FAMILY_SUBTYPES).some((subtypes) => subtypes.some((subtype) => normalizedValue.includes(subtype))) ||
    /\b(fnar|fanar|avant|arriere|gauche|droite|superieur|inferieur|reference|prix|stock)\b/.test(normalizedValue)
  );
};

const isSmallTalkMessage = (value: string) => {
  const normalizedValue = normalize(value);
  if (!normalizedValue) return false;

  const containsCourtesy = COURTESY_TERMS.some((term) => normalizedValue.includes(normalize(term)));
  return containsCourtesy && !hasAutomotiveIntent(normalizedValue) && normalizedValue.split(" ").length <= 5;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sanitizeDisplayLabel = (value: string, vehicle?: VehicleInfo) => {
  let cleaned = value;

  if (vehicle?.modele) {
    cleaned = cleaned.replace(new RegExp(`\\b${escapeRegex(vehicle.modele)}\\b`, "gi"), "");
  }

  if (vehicle?.annee) {
    cleaned = cleaned.replace(new RegExp(`\\b${escapeRegex(vehicle.annee)}\\b`, "gi"), "");
  }

  cleaned = cleaned
    .replace(/\bvolvo\b/gi, "")
    .replace(/\b(non|oui|ok|je veux|je parle|je cherche|nheb|n7eb|choufli|behi|tawa|nlawej|lawwej|aussi)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || value;
};

const enrichTaskWithMemory = (label: string, memory: SearchMemory | null): SearchTask => {
  const normalizedLabel = normalize(label);
  const explicitFamily = extractFamilyFromText(label);

  if (isSmallTalkMessage(label) || !hasAutomotiveIntent(label)) {
    return {
      id: makeId(),
      requestedLabel: label,
      searchPrompt: label,
    };
  }

  if (!memory?.family || explicitFamily) {
    return {
      id: makeId(),
      requestedLabel: label,
      searchPrompt: label,
    };
  }

  const candidateSubtypes = FAMILY_SUBTYPES[memory.family] || [];
  const mentionsSubtype = candidateSubtypes.some((subtype) => normalizedLabel.includes(subtype));
  const looksLikeCorrection = /^(non|nn|je veux|je parle|plutot|plutôt|oui|juste|plutot une|plutot un)/i.test(label.trim());
  const isShortFollowUp = normalizedLabel.split(" ").filter(Boolean).length <= 6;

  if (!mentionsSubtype && !looksLikeCorrection && !isShortFollowUp) {
    return {
      id: makeId(),
      requestedLabel: label,
      searchPrompt: label,
    };
  }

  return {
    id: makeId(),
    requestedLabel: label,
    searchPrompt: `${label} ${memory.family}`.trim(),
  };
};

const Index = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [vehicles, setVehicles] = useState<VehicleInfo[]>([]);
  const [showUpload, setShowUpload] = useState(true);
  const [activeVariantSelection, setActiveVariantSelection] = useState<ActiveVariantSelection | null>(null);
  const [searchMemory, setSearchMemory] = useState<SearchMemory | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const appendMessage = (message: Message) => {
    setMessages((prev) => [...prev, message]);
  };

  const handleImageUpload = async (imageData: string) => {
    setIsProcessingImage(true);
    try {
      const info = await extractVehicleInfoFromImage(imageData);
      const infoWithId = { ...info, id: Date.now() };

      setVehicles((prev) => [...prev, infoWithId]);
      appendMessage({
        id: makeId(),
        role: "vehicle",
        content: "",
        vehicleInfo: infoWithId,
      });

      const vehicleCount = vehicles.length + 1;
      if (vehicleCount === 1) {
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: "Carte grise Volvo validee.\nJe suis pret a vous accompagner pour la recherche de pieces, de prix et de disponibilites.",
        });
        setShowUpload(false);
      } else {
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: `Un nouveau vehicule Volvo a ete ajoute a la session (${vehicleCount} au total).`,
        });
      }

      toast({
        title: "Carte grise analysee",
        description: `${info.marque || "VOLVO"} ${info.modele || ""}`.trim(),
      });
    } catch (error: any) {
      const errorMessage = error?.message || "";
      let title = "Carte grise refusee";
      let description = "Impossible d'analyser l'image. Reessayez avec une photo plus nette.";

      if (errorMessage === "INVALID_MODEL") {
        const detectedMarque = error.detectedMarque || "Non detecte";
        const detectedModele = error.detectedModele || "Non detecte";
        description = `Seules les cartes grises Volvo sont acceptees.\n\nDetecte: ${detectedMarque} ${detectedModele}`;
      } else if (errorMessage === "MISSING_GEMINI_API_KEY") {
        title = "Configuration manquante";
        description = "Ajoutez VITE_GEMINI_API_KEY dans le fichier .env.";
      } else if (errorMessage === "INVALID_GEMINI_API_KEY") {
        title = "Cle Gemini invalide";
        description = "La cle API Gemini configuree n'est pas valide.";
      } else if (errorMessage === "GEMINI_PERMISSION_DENIED") {
        title = "Acces Gemini refuse";
        description = "L'acces au modele Gemini est refuse pour cette cle API.";
      } else if (errorMessage === "UNREADABLE_IMAGE") {
        description = "L'image est illisible. Essayez avec une meilleure qualite ou un meilleur eclairage.";
      } else if (errorMessage === "PARSE_ERROR") {
        description = "La lecture OCR a echoue. Verifiez qu'il s'agit bien d'une carte grise.";
      }

      toast({
        title,
        description,
        variant: "destructive",
      });
    } finally {
      setIsProcessingImage(false);
    }
  };

  const handleUpdateVehicle = (id?: number, updates?: Partial<VehicleInfo>) => {
    if (!id) return;
    setVehicles((prev) => prev.map((vehicle) => (vehicle.id === id ? { ...vehicle, ...updates } : vehicle)));
    setMessages((prev) =>
      prev.map((message) => {
        if (message.role === "vehicle" && message.vehicleInfo?.id === id) {
          return {
            ...message,
            vehicleInfo: { ...message.vehicleInfo, ...updates },
          };
        }
        return message;
      }),
    );
  };

  const runSearchFlow = async (
    tasks: SearchTask[],
    historySnapshot: Array<{ role: string; content: string }>,
    activeVehicle: VehicleInfo,
  ) => {
    let rollingHistory = [...historySnapshot];

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      const searchSource = task.searchPrompt || task.requestedLabel;
      const intent = await analyzePartSearchIntent(searchSource, rollingHistory, activeVehicle);
      const displayLabel = sanitizeDisplayLabel(intent.normalizedQuery || task.requestedLabel, activeVehicle);
      const searchQueries = [intent.normalizedQuery, searchSource, task.requestedLabel, ...intent.alternateQueries, intent.referenceHint || ""];
      let candidates = mergeCandidatePools(searchQueries);
      const detectedFamily = extractFamilyFromText(`${displayLabel} ${searchSource}`) || searchMemory?.family;

      setSearchMemory({
        family: detectedFamily,
        normalizedQuery: displayLabel,
      });

      if (candidates.length === 0) {
        const unavailableMessage = CONTACT_BLOCK;
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: unavailableMessage,
        });
        rollingHistory.push({ role: "assistant", content: unavailableMessage });
        continue;
      }

      if (intent.askForClarification && intent.clarificationQuestion) {
        const clarificationMessage = intent.clarificationQuestion;
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: clarificationMessage,
        });
        rollingHistory.push({ role: "assistant", content: clarificationMessage });
        continue;
      }

      const inStockCandidates = candidates.filter((candidate) => candidate.stock > 0);
      if (inStockCandidates.length === 0) {
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: CONTACT_BLOCK,
        });
        rollingHistory.push({ role: "assistant", content: CONTACT_BLOCK });
        continue;
      }

      const focusedCandidates = sortCandidatesForDisplay(inStockCandidates, displayLabel);
      const choiceGroups = buildChoiceGroups(focusedCandidates, task.requestedLabel);
      if (choiceGroups.length > 0) {
        const choiceMessageId = makeId();
        const choiceMessage = formatVariantQuestion(displayLabel, choiceGroups);
        appendMessage({
          id: choiceMessageId,
          role: "assistant",
          content: choiceMessage,
          choiceGroups,
        });
        rollingHistory.push({ role: "assistant", content: choiceMessage });
        setActiveVariantSelection({
          messageId: choiceMessageId,
          task,
          candidates: focusedCandidates,
          choiceGroups,
          selectedChoices: {},
          remainingTasks: tasks.slice(taskIndex + 1),
        });
        return;
      }

      candidates = sortCandidatesForDisplay(filterCandidatesByChoices(focusedCandidates, {}), displayLabel);
      const response = formatAvailablePartsResponse(displayLabel, candidates);
      appendMessage({
        id: makeId(),
        role: "assistant",
        content: response,
      });
      rollingHistory.push({ role: "assistant", content: response });
    }

    setActiveVariantSelection(null);
  };

  const handleChoiceSelect = (groupKey: string, option: string) => {
    setActiveVariantSelection((current) => {
      if (!current) return current;
      const nextSelectedChoices = {
        ...current.selectedChoices,
        [groupKey]: option,
      };
      setInput(Object.values(nextSelectedChoices).join(" "));
      return {
        ...current,
        selectedChoices: nextSelectedChoices,
      };
    });
  };

  const handleSend = async () => {
    if (isLoading || vehicles.length === 0) return;

    const userMessage = input.trim();
    if (!userMessage && !activeVariantSelection) return;

    const activeVehicle = vehicles[0];
    const outgoingMessage = userMessage || Object.values(activeVariantSelection?.selectedChoices || {}).join(" ").trim();
    if (!outgoingMessage) return;

    const userMessageEntry: Message = {
      id: makeId(),
      role: "user",
      content: outgoingMessage,
    };

    setInput("");
    appendMessage(userMessageEntry);
    setIsLoading(true);
    setShowUpload(false);

    try {
      const textHistory = messages
        .filter((message) => message.role !== "vehicle")
        .map((message) => ({ role: message.role, content: message.content }))
        .concat({ role: "user", content: outgoingMessage });

      if (activeVariantSelection) {
        const explicitChoices = {
          ...activeVariantSelection.selectedChoices,
          ...extractChoicesFromText(outgoingMessage),
        };
        const filteredCandidates = filterCandidatesByChoices(activeVariantSelection.candidates, explicitChoices);

        if (filteredCandidates.length > 0) {
          const orderedFilteredCandidates = sortCandidatesForDisplay(filteredCandidates, activeVariantSelection.task.requestedLabel);
          const remainingChoiceGroups = buildChoiceGroups(
            orderedFilteredCandidates,
            `${activeVariantSelection.task.searchPrompt || activeVariantSelection.task.requestedLabel} ${outgoingMessage}`.trim(),
          );

          if (remainingChoiceGroups.length > 0) {
            const choiceMessageId = makeId();
            const choiceMessage = formatVariantQuestion(activeVariantSelection.task.requestedLabel, remainingChoiceGroups);
            appendMessage({
              id: choiceMessageId,
              role: "assistant",
              content: choiceMessage,
              choiceGroups: remainingChoiceGroups,
            });
            setActiveVariantSelection({
              messageId: choiceMessageId,
              task: activeVariantSelection.task,
              candidates: orderedFilteredCandidates,
              choiceGroups: remainingChoiceGroups,
              selectedChoices: explicitChoices,
              remainingTasks: activeVariantSelection.remainingTasks,
            });
            return;
          }

          const response = formatAvailablePartsResponse(activeVariantSelection.task.requestedLabel, orderedFilteredCandidates);
          appendMessage({
            id: makeId(),
            role: "assistant",
            content: response,
          });

          const remainingTasks = activeVariantSelection.remainingTasks;
          setActiveVariantSelection(null);
          if (remainingTasks.length > 0) {
            await runSearchFlow(remainingTasks, textHistory.concat({ role: "assistant", content: response }), activeVehicle);
          }
          return;
        }

        const mergedTask: SearchTask = {
          ...activeVariantSelection.task,
          requestedLabel: `${activeVariantSelection.task.requestedLabel} ${outgoingMessage}`.trim(),
          searchPrompt: `${activeVariantSelection.task.searchPrompt || activeVariantSelection.task.requestedLabel} ${outgoingMessage}`.trim(),
        };
        const remainingTasks = activeVariantSelection.remainingTasks;
        setActiveVariantSelection(null);
        await runSearchFlow([mergedTask, ...remainingTasks], textHistory, activeVehicle);
        return;
      }

      const onlySmallTalk = /^(merci|merci beaucoup|thank you|thx|shukran|barakallah|yaatik essaha|bravo|sa7a)$/i.test(outgoingMessage);
      if (onlySmallTalk || isSmallTalkMessage(outgoingMessage)) {
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: `Avec plaisir. Je peux poursuivre la recherche pour votre ${activeVehicle.modele || "Volvo"} des que vous le souhaitez.`,
        });
        return;
      }

      const batchPlan = await analyzePartsBatchRequest(outgoingMessage, textHistory, activeVehicle);
      const tasks = batchPlan.items.map((item) => enrichTaskWithMemory(item, searchMemory));

      if (tasks.length > 1) {
        const introMessage = batchPlan.intro?.trim() || formatQueueIntro();
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: introMessage,
        });
        textHistory.push({ role: "assistant", content: introMessage });
      }

      await runSearchFlow(tasks, textHistory, activeVehicle);
    } catch (error: any) {
      toast({
        title: "Erreur",
        description:
          error?.message === "MISSING_GEMINI_API_KEY"
            ? "Ajoutez VITE_GEMINI_API_KEY ou GEMINI_API_KEY dans le fichier .env."
            : error?.message === "INVALID_GEMINI_API_KEY"
              ? "La cle API Gemini configuree n'est pas valide."
              : error?.message === "GEMINI_PERMISSION_DENIED"
                ? "L'acces au modele Gemini est refuse pour cette cle API."
                : "Impossible de traiter votre demande. Reessayez.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <div className="container max-w-4xl mx-auto p-4 h-screen flex flex-col">
        <Header vehicleCount={vehicles.length} />
        <Separator className="mb-4" />

        {vehicles.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center space-y-6 animate-in fade-in-50">
            <div className="text-center space-y-4 max-w-md">
              <div className="w-28 h-28 mx-auto">
                <img src="/logo-volvo.png" alt="Volvo Logo" className="w-full h-full object-contain" />
              </div>
              <h2 className="text-2xl font-bold text-foreground">Volvo Parts Assistant</h2>
              <p className="text-muted-foreground">Importez une carte grise Volvo pour ouvrir la recherche conversationnelle de pieces.</p>
            </div>
            <ImageUpload onImageUpload={handleImageUpload} isProcessing={isProcessingImage} />
          </div>
        )}

        {vehicles.length > 0 && (
          <>
            <ScrollArea className="flex-1 pr-4">
              <div className="space-y-4 pb-4">
                {messages.map((message) => {
                  if (message.role === "vehicle" && message.vehicleInfo) {
                    return <VehicleMessage key={message.id} vehicle={message.vehicleInfo} onUpdate={(updates) => handleUpdateVehicle(message.vehicleInfo?.id, updates)} />;
                  }

                  if (message.role === "user" || message.role === "assistant") {
                    return (
                      <ChatMessage
                        key={message.id}
                        role={message.role}
                        content={message.content}
                        choiceGroups={message.role === "assistant" ? message.choiceGroups : undefined}
                        selectedChoices={activeVariantSelection?.messageId === message.id ? activeVariantSelection.selectedChoices : undefined}
                        onChoiceSelect={activeVariantSelection?.messageId === message.id ? handleChoiceSelect : undefined}
                      />
                    );
                  }

                  return null;
                })}

                {isLoading && (
                  <div className="flex gap-3 p-4 rounded-xl bg-gradient-to-br from-muted/80 to-muted/40 mr-8 border border-border/50 animate-in fade-in-50">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent/80 shadow-sm">
                      <div className="h-2.5 w-2.5 bg-accent-foreground rounded-full animate-pulse" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-muted-foreground">Analyse de votre demande en cours...</p>
                    </div>
                  </div>
                )}
                <div ref={scrollRef} />
              </div>
            </ScrollArea>

            {showUpload && (
              <div className="mb-4 animate-in fade-in-50 slide-in-from-bottom-4">
                <ImageUpload onImageUpload={handleImageUpload} isProcessing={isProcessingImage} />
              </div>
            )}

            <div className="pt-4 space-y-3">
              <div className="flex gap-2">
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                  placeholder={
                    activeVariantSelection
                      ? "Choisissez vos variantes puis envoyez..."
                      : "Exemple : amortisseur, echappement et aile..."
                  }
                  disabled={isLoading}
                  className="flex-1 shadow-sm focus:shadow-md transition-shadow"
                />
                <Button onClick={handleSend} disabled={isLoading || (!input.trim() && !activeVariantSelection)} size="icon" className="shadow-sm hover:shadow-md transition-shadow">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-center text-muted-foreground">Presentation Volvo - Recherche intelligente et guidee dans le catalogue local</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Index;
