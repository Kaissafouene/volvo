import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface ChatMessageChoiceGroup {
  key: string;
  label: string;
  options: string[];
}

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  time?: string; // optional timestamp
  choiceGroups?: ChatMessageChoiceGroup[];
  selectedChoices?: Record<string, string>;
  onChoiceSelect?: (groupKey: string, option: string) => void;
}

// Small, safe inline parser for **bold**, *italic* and `code` (returns React nodes)
function renderInline(text: string) {
  const parts: React.ReactNode[] = [];
  // Split by code first
  const codeSplit = text.split(/(`[^`]+`)/g);
  codeSplit.forEach((chunk, i) => {
    if (!chunk) return;
    const codeMatch = chunk.match(/^`([^`]+)`$/);
    if (codeMatch) {
      parts.push(
        <code key={`c-${i}`} className="bg-muted/50 px-1 py-0.5 rounded text-xs font-mono text-muted-foreground">
          {codeMatch[1]}
        </code>
      );
      return;
    }

    // Handle bold and italic inside non-code chunks
    const boldSplit = chunk.split(/(\*\*[^*]+\*\*)/g);
    boldSplit.forEach((bs, j) => {
      if (!bs) return;
      const boldMatch = bs.match(/^\*\*([^*]+)\*\*$/);
      if (boldMatch) {
        parts.push(
          <strong key={`b-${i}-${j}`} className="font-semibold">
            {boldMatch[1]}
          </strong>
        );
        return;
      }

      const italicSplit = bs.split(/(\*[^*]+\*)/g);
      italicSplit.forEach((is, k) => {
        if (!is) return;
        const italicMatch = is.match(/^\*([^*]+)\*$/);
        if (italicMatch) {
          parts.push(
            <em key={`i-${i}-${j}-${k}`} className="italic">
              {italicMatch[1]}
            </em>
          );
        } else {
          parts.push(<span key={`t-${i}-${j}-${k}`}>{is}</span>);
        }
      });
    });
  });
  return parts;
}

export function ChatMessage({ role, content, time, choiceGroups, selectedChoices, onChoiceSelect }: ChatMessageProps) {
  // Render content preserving newlines as <p>
  const lines = content.split('\n').filter(l => l.length > 0);

  return (
    <div
      className={cn(
        "flex gap-3 animate-in fade-in-50 slide-in-from-bottom-3 transition-all duration-200",
        role === 'user' ? "justify-end" : "justify-start"
      )}
    >
      {role === 'assistant' && (
        <div className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent/80 text-accent-foreground shadow-md">
          <Bot className="h-4 w-4" />
        </div>
      )}

      <div
        className={cn(
          "max-w-2xl rounded-lg px-5 py-3 shadow-sm",
          role === 'user'
            ? "bg-gradient-to-br from-primary to-primary/90 text-primary-foreground rounded-br-none shadow-lg"
            : "bg-white dark:bg-slate-800 text-foreground border border-border/60 rounded-bl-none"
        )}
      >
        <div className={cn("text-sm leading-relaxed whitespace-pre-wrap break-words")}> 
          {lines.map((line, idx) => (
            <p key={idx} className="mb-2 last:mb-0">
              {renderInline(line)}
            </p>
          ))}
        </div>

        {role === "assistant" && choiceGroups && choiceGroups.length > 0 && (
          <div className="mt-4 space-y-3">
            {choiceGroups.map((group) => (
              <div key={group.key} className="space-y-2">
                <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{group.label}</p>
                <div className="flex flex-wrap gap-2">
                  {group.options.map((option) => {
                    const isSelected = selectedChoices?.[group.key] === option;
                    return (
                      <Button
                        key={option}
                        type="button"
                        size="sm"
                        variant={isSelected ? "default" : "outline"}
                        className={cn(
                          "rounded-full px-4",
                          isSelected ? "shadow-md" : "bg-background/80",
                        )}
                        onClick={() => onChoiceSelect?.(group.key, option)}
                      >
                        {option}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* metadata row (timestamp) */}
        {time && (
          <div className="mt-2 text-xs text-muted-foreground flex items-center gap-2">
            <span className="opacity-80">{time}</span>
          </div>
        )}
      </div>

      {role === 'user' && (
        <div className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-md">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}
