import { Upload, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useState, useRef } from "react";
import { cn } from "@/lib/utils";

interface ImageUploadProps {
  onImageUpload: (imageData: string) => void;
  isProcessing: boolean;
}

export function ImageUpload({ onImageUpload, isProcessing }: ImageUploadProps) {
  const { toast } = useToast();
  const [isDragging, setIsDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = async (file: File | null) => {
    if (!file) return;

    const validTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic", "image/heif", "application/pdf"];

    const isValid =
      validTypes.includes(file.type) ||
      file.type.startsWith("image/") ||
      file.name.toLowerCase().match(/\.(jpg|jpeg|png|webp|heic|heif|pdf)$/);

    if (!isValid) {
      toast({
        title: "Erreur",
        description: "Veuillez telecharger une image (PNG, JPG, JPEG, WEBP...) ou un PDF.",
        variant: "destructive",
      });
      return;
    }

    try {
      if (
        file.type === "image/heic" ||
        file.type === "image/heif" ||
        file.name.toLowerCase().endsWith(".heic") ||
        file.name.toLowerCase().endsWith(".heif")
      ) {
        const response = await fetch(URL.createObjectURL(file));
        const blob = await response.blob();
        file = new File([blob], file.name.replace(/\.(heic|heif)$/i, ".jpg"), {
          type: "image/jpeg",
        });
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        onImageUpload(result);
      };
      reader.onerror = () => {
        toast({
          title: "Erreur",
          description: "Impossible de lire le fichier. Essayez un autre format d'image.",
          variant: "destructive",
        });
      };
      reader.readAsDataURL(file);
    } catch (error) {
      toast({
        title: "Erreur",
        description: "Impossible de traiter l'image. Essayez un autre format.",
        variant: "destructive",
      });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    handleFileChange(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={cn(
        "relative border-2 border-dashed rounded-xl p-8 text-center transition-all duration-300 overflow-hidden",
        isDragging ? "border-primary bg-primary/10 scale-[1.02]" : "border-border hover:border-primary/50 hover:bg-muted/30",
      )}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-secondary/5 pointer-events-none" />

      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf,.heic,.heif"
        className="sr-only"
        onChange={(e) => handleFileChange(e.currentTarget.files?.[0] || null)}
        disabled={isProcessing}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*,.heic,.heif"
        capture="environment"
        className="sr-only"
        onChange={(e) => handleFileChange(e.currentTarget.files?.[0] || null)}
        disabled={isProcessing}
      />

      <div className="cursor-pointer relative z-10" onClick={() => !isProcessing && inputRef.current?.click()}>
        <div className="flex flex-col items-center gap-4">
          {isProcessing ? (
            <div className="relative">
              <Loader2 className="h-12 w-12 text-primary animate-spin" />
              <div className="absolute inset-0 blur-xl bg-primary/30 animate-pulse" />
            </div>
          ) : (
            <div className="relative group">
              <Upload className="h-12 w-12 text-primary transition-transform group-hover:scale-110 group-hover:-translate-y-1" />
              <div className="absolute inset-0 blur-2xl bg-primary/20 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm font-semibold">{isProcessing ? "Analyse en cours..." : "Telechargez votre carte grise Volvo"}</p>
            <p className="text-xs text-muted-foreground">
              {isProcessing ? "Extraction des informations du vehicule" : "PNG, JPG, JPEG, WEBP, PDF - Glissez-deposez ou cliquez"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
