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
import { extractVehicleInfoFromImage, type VehicleInfo } from "@/services/geminiService";
import {
  buildChoiceGroupsFromParts,
  detectAmbiguousAxes,
  filterPartsByChoices,
  getCatalogPartsByReferences,
  searchPartsConversationWithOpenAI,
  type ClarificationAxis,
} from "@/services/openaiPartsService";
import type { Part } from "@/data/volvoPartsDatabase";

interface Message {
  id: string;
  role: "user" | "assistant" | "vehicle";
  content: string;
  vehicleInfo?: VehicleInfo;
  choiceGroups?: ChatMessageChoiceGroup[];
}

interface ActiveVariantSelection {
  messageId: string;
  label: string;
  candidateReferences: string[];
  choiceGroups: ChatMessageChoiceGroup[];
  selectedChoices: Record<string, string>;
}

const CONTACT_BLOCK = `Cette piece n'est pas disponible en stock pour le moment.
Pour suivre l'arrivage de cette piece, merci de contacter directement le siege sur place :
86, rue 8603 Zone industrielle Charguia 1, Tunis, Tunisia, 2035
ou par telephone : 36 028 020`;

const COURTESY_PATTERN = /^(merci|merci beaucoup|thank you|thx|shukran|barakallah|yaatik essaha|bravo|sa7a|bonjour|bonsoir|salut|hello|cc)$/i;

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const formatPriceDT = (value: number) =>
  `${value.toLocaleString("fr-TN", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })} DT`;

const sanitizeAssistantNarrative = (text: string) =>
  text
    .replace(/â‚¬/g, "DT")
    .replace(/\bEUR\b/gi, "DT")
    .replace(/\beuro?s?\b/gi, "DT")
    .replace(/\bavec\s+\d+\s+unit[eé]s?\b/gi, "")
    .replace(/\b\d+\s+unit[eé]s?\b/gi, "")
    .replace(/\b\d+\s+en stock\b/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();

const formatAvailablePartsResponse = (label: string, references: string[], introOverride?: string) => {
  const visibleParts = getCatalogPartsByReferences(references).filter((part) => part.stock > 0).slice(0, 3);
  if (visibleParts.length === 0) {
    return CONTACT_BLOCK;
  }

  const intro =
    introOverride?.trim()
      ? sanitizeAssistantNarrative(introOverride.trim())
      : visibleParts.length === 1
        ? `Oui, nous avons trouve une correspondance disponible pour ${label}.`
        : `Oui, nous avons trouve ${visibleParts.length} correspondances disponibles pour ${label}.`;

  const blocks = visibleParts.map((part) =>
    [
      `Reference : ${part.reference}`,
      `Designation : ${part.designation}`,
      `Prix HT : ${formatPriceDT(part.priceHT)}`,
    ].join("\n"),
  );

  return [intro, ...blocks].join("\n\n");
};

const AXIS_PRIORITY: ClarificationAxis[] = ["position", "cote", "niveau", "piece"];

const extractChoicesFromText = (value: string, availableChoiceGroups: ChatMessageChoiceGroup[] = []) => {
  const normalizedValue = normalize(value);
  const extracted: Record<string, string> = {};

  if (/(^|\s)(avant|av)(\s|$)/.test(normalizedValue)) {
    extracted.position = "Avant";
  } else if (/(^|\s)(arriere|ar|arriere)(\s|$)/.test(normalizedValue)) {
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

  availableChoiceGroups
    .filter((group) => group.key === "piece")
    .forEach((group) => {
      const matchedOption = group.options.find((option) => normalizedValue.includes(normalize(option)));
      if (matchedOption) {
        extracted.piece = matchedOption;
      }
    });

  return extracted;
};

const buildSequentialChoiceGroups = (parts: Part[], selectedChoices: Record<string, string> = {}) => {
  const filteredParts = filterPartsByChoices(parts, selectedChoices);
  const ambiguousAxes = detectAmbiguousAxes(filteredParts).filter((axis) => !(axis in selectedChoices));
  const nextAxis = AXIS_PRIORITY.find((axis) => ambiguousAxes.includes(axis));

  if (!nextAxis) {
    return {
      choiceGroups: [] as ChatMessageChoiceGroup[],
      filteredParts,
    };
  }

  return {
    choiceGroups: buildChoiceGroupsFromParts(filteredParts, [nextAxis]),
    filteredParts,
  };
};

const buildClarificationMessage = (label: string, choiceGroups: ChatMessageChoiceGroup[]) => {
  const firstGroup = choiceGroups[0];
  if (!firstGroup) {
    return `Pour ${label}, merci de preciser la variante souhaitee.`;
  }

  switch (firstGroup.key) {
    case "position":
      return `Pour ${label}, pourriez-vous me preciser si vous cherchez l'avant ou l'arriere ?`;
    case "cote":
      return `Pour ${label}, pourriez-vous me preciser si vous cherchez le cote droit ou gauche ?`;
    case "niveau":
      return `Pour ${label}, pourriez-vous me preciser s'il s'agit de la version superieure ou inferieure ?`;
    case "piece":
      return `Pour ${label}, pourriez-vous me preciser la piece exacte souhaitee ?`;
    default:
      return `Pour ${label}, merci de preciser la variante souhaitee.`;
  }
};

const Index = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [vehicles, setVehicles] = useState<VehicleInfo[]>([]);
  const [showUpload, setShowUpload] = useState(true);
  const [activeVariantSelection, setActiveVariantSelection] = useState<ActiveVariantSelection | null>(null);
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "";
      const errorDetails = error as Partial<{ detectedMarque: string; detectedModele: string }>;
      let title = "Carte grise refusee";
      let description = "Impossible d'analyser l'image. Reessayez avec une photo plus nette.";

      if (errorMessage === "INVALID_MODEL") {
        const detectedMarque = errorDetails.detectedMarque || "Non detecte";
        const detectedModele = errorDetails.detectedModele || "Non detecte";
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

  const handleChoiceSelect = (groupKey: string, option: string) => {
    setActiveVariantSelection((current) => {
      if (!current) return current;
      const selectedChoices = {
        ...current.selectedChoices,
        [groupKey]: option,
      };
      setInput(Object.values(selectedChoices).join(" "));
      return {
        ...current,
        selectedChoices,
      };
    });
  };

  const handleSend = async () => {
    if (isLoading || vehicles.length === 0) return;

    const typedMessage = input.trim();
    const selectedVariantReply = Object.values(activeVariantSelection?.selectedChoices || {}).join(" ").trim();
    const outgoingMessage = typedMessage || selectedVariantReply;

    if (!outgoingMessage) return;

    const activeVehicle = vehicles[0];
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
        const currentParts = getCatalogPartsByReferences(activeVariantSelection.candidateReferences).filter((part) => part.stock > 0);
        const nextChoices = {
          ...activeVariantSelection.selectedChoices,
          ...extractChoicesFromText(outgoingMessage, activeVariantSelection.choiceGroups),
        };
        const filteredParts = filterPartsByChoices(currentParts, nextChoices);

        if (filteredParts.length === 0) {
          const retryMessage = buildClarificationMessage(activeVariantSelection.label, activeVariantSelection.choiceGroups);
          const retryMessageId = makeId();
          appendMessage({
            id: retryMessageId,
            role: "assistant",
            content: retryMessage,
            choiceGroups: activeVariantSelection.choiceGroups,
          });
          setActiveVariantSelection({
            ...activeVariantSelection,
            messageId: retryMessageId,
          });
          return;
        }

        const { choiceGroups, filteredParts: narrowedParts } = buildSequentialChoiceGroups(filteredParts, nextChoices);

        if (choiceGroups.length > 0) {
          const clarificationMessage = buildClarificationMessage(activeVariantSelection.label, choiceGroups);
          const clarificationMessageId = makeId();
          appendMessage({
            id: clarificationMessageId,
            role: "assistant",
            content: clarificationMessage,
            choiceGroups,
          });
          setActiveVariantSelection({
            messageId: clarificationMessageId,
            label: activeVariantSelection.label,
            candidateReferences: narrowedParts.map((part) => part.reference),
            choiceGroups,
            selectedChoices: nextChoices,
          });
          return;
        }

        appendMessage({
          id: makeId(),
          role: "assistant",
          content: formatAvailablePartsResponse(activeVariantSelection.label, narrowedParts.map((part) => part.reference)),
        });
        setActiveVariantSelection(null);
        return;
      }

      setActiveVariantSelection(null);

      if (COURTESY_PATTERN.test(outgoingMessage)) {
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: `Avec plaisir. Je peux poursuivre la recherche pour votre ${activeVehicle.modele || "Volvo"} des que vous le souhaitez.`,
        });
        return;
      }

      const plan = await searchPartsConversationWithOpenAI(outgoingMessage, textHistory, activeVehicle);

      if (plan.conversationalReply && plan.searches.length === 0) {
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: sanitizeAssistantNarrative(plan.conversationalReply),
        });
        return;
      }

      if (plan.searches.length === 0) {
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: "Je n'ai pas identifie de piece precise dans votre message. Je peux vous aider si vous m'indiquez la piece souhaitee.",
        });
        return;
      }

      if (plan.searches.length > 1 && plan.intro?.trim()) {
        appendMessage({
          id: makeId(),
          role: "assistant",
          content: sanitizeAssistantNarrative(plan.intro),
        });
      }

      for (const search of plan.searches) {
        const label = search.normalizedLabel || search.requestedLabel || "cette piece";

        if (search.kind === "clarification") {
          const candidateParts = getCatalogPartsByReferences(search.candidateReferences);
          const { choiceGroups, filteredParts } = buildSequentialChoiceGroups(candidateParts);
          const clarificationMessage =
            sanitizeAssistantNarrative(search.reply) ||
            buildClarificationMessage(label, choiceGroups);

          const messageId = makeId();
          appendMessage({
            id: messageId,
            role: "assistant",
            content: clarificationMessage,
            choiceGroups,
          });

          if (choiceGroups.length > 0) {
            setActiveVariantSelection({
              messageId,
              label,
              candidateReferences: filteredParts.map((part) => part.reference),
              choiceGroups,
              selectedChoices: {},
            });
          }
          return;
        }

        if (search.kind === "out_of_stock") {
          appendMessage({
            id: makeId(),
            role: "assistant",
            content: CONTACT_BLOCK,
          });
          continue;
        }

        if (search.kind === "match") {
          const matchedParts = getCatalogPartsByReferences(search.selectedReferences).filter((part) => part.stock > 0);
          const { choiceGroups, filteredParts } = buildSequentialChoiceGroups(matchedParts);

          if (choiceGroups.length > 0) {
            const messageId = makeId();
            appendMessage({
              id: messageId,
              role: "assistant",
              content: buildClarificationMessage(label, choiceGroups),
              choiceGroups,
            });
            setActiveVariantSelection({
              messageId,
              label,
              candidateReferences: filteredParts.map((part) => part.reference),
              choiceGroups,
              selectedChoices: {},
            });
            return;
          }

          appendMessage({
            id: makeId(),
            role: "assistant",
            content: formatAvailablePartsResponse(label, search.selectedReferences, search.reply),
          });
          continue;
        }

        appendMessage({
          id: makeId(),
          role: "assistant",
          content: sanitizeAssistantNarrative(search.reply) || "Non disponible dans la base.",
        });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "";

      toast({
        title: "Erreur",
        description:
          errorMessage === "MISSING_OPENAI_API_KEY"
            ? "Ajoutez VITE_OPENAI_API_KEY ou OPENAI_API_KEY dans le fichier .env."
            : errorMessage === "INVALID_OPENAI_API_KEY"
              ? "La cle API OpenAI configuree n'est pas valide."
              : errorMessage === "MISSING_GEMINI_API_KEY"
                ? "Ajoutez VITE_GEMINI_API_KEY ou GEMINI_API_KEY dans le fichier .env."
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
                  placeholder={activeVariantSelection ? "Choisissez vos variantes puis envoyez..." : "Exemple : amortisseur, bougies et aile..."}
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
