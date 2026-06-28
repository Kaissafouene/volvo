import { useState } from "react";
import { Car, Settings, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { VehicleInfo } from "@/services/geminiService";
import { cn } from "@/lib/utils";

interface VehicleMessageProps {
  vehicle: VehicleInfo;
  onUpdate?: (updates: Partial<VehicleInfo>) => void;
}

export function VehicleMessage({ vehicle, onUpdate }: VehicleMessageProps) {
  const [isEditingImmat, setIsEditingImmat] = useState(false);
  const [immatInput, setImmatInput] = useState(vehicle.immatriculation || vehicle.immatriculationRaw || "");
  const modelBadge = { name: "Volvo", color: "bg-primary" };
  const summaryLine = [vehicle.marque, vehicle.modele || modelBadge.name, vehicle.annee].filter(Boolean).join(" - ");

  return (
    <div className="flex gap-4 p-5 rounded-2xl bg-card text-card-foreground border border-border shadow-sm animate-in fade-in-50 slide-in-from-bottom-3 mr-8">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/10 shadow-sm">
        <CheckCircle2 className="h-5 w-5 text-primary" />
      </div>

      <div className="flex-1 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <Car className="h-4 w-4 text-primary" />
              <p className="font-semibold text-sm">Vehicule confirme</p>
            </div>
            {summaryLine && <p className="text-xs text-muted-foreground mt-1">{summaryLine}</p>}
          </div>
          <Badge className={cn(modelBadge.color, "text-white shadow-sm text-xs px-3 py-1 uppercase tracking-[0.18em]")}>{modelBadge.name}</Badge>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          {vehicle.immatriculation && !isEditingImmat && (
            <div className="col-span-2 flex items-center gap-2 rounded-xl bg-primary/5 border border-primary/10 px-3 py-3">
              <span className="text-muted-foreground text-xs uppercase tracking-[0.16em]">Immatriculation</span>
              <span className="font-mono bg-primary/5 px-3 py-1.5 rounded-md border border-primary/20 font-semibold tracking-wide text-primary">
                {vehicle.immatriculation}
              </span>
              {vehicle.immatriculationWarning && (
                <button
                  onClick={() => {
                    setIsEditingImmat(true);
                    setImmatInput(vehicle.immatriculation || vehicle.immatriculationRaw || "");
                  }}
                  className="ml-auto text-xs underline text-primary hover:text-primary/80 transition-colors"
                >
                  Modifier
                </button>
              )}
            </div>
          )}

          {isEditingImmat && (
            <div className="col-span-2 flex items-center gap-2 rounded-xl bg-muted/40 border border-border px-3 py-3">
              <span className="text-muted-foreground text-xs uppercase tracking-[0.16em]">Immatriculation</span>
              <input
                className="font-mono bg-background/50 px-2 py-1 rounded border border-border font-medium w-40"
                value={immatInput}
                onChange={(e) => setImmatInput(e.target.value)}
              />
              <button
                onClick={() => {
                  const cleaned = immatInput.trim().toUpperCase().replace(/[^A-Z0-9\- ]/g, "");
                  onUpdate?.({ immatriculation: cleaned, immatriculationWarning: undefined });
                  setIsEditingImmat(false);
                }}
                className="text-sm text-white bg-primary px-3 py-1.5 rounded-lg"
              >
                Enregistrer
              </button>
              <button
                onClick={() => {
                  setIsEditingImmat(false);
                  setImmatInput(vehicle.immatriculation || vehicle.immatriculationRaw || "");
                }}
                className="text-sm underline text-muted-foreground ml-2"
              >
                Annuler
              </button>
            </div>
          )}

          {!vehicle.immatriculation && !isEditingImmat && vehicle.immatriculationRaw && (
            <div className="col-span-2 flex items-center gap-2 rounded-xl bg-amber-50/60 border border-amber-200/70 px-3 py-3">
              <span className="text-muted-foreground text-xs uppercase tracking-[0.16em]">Lecture proposee</span>
              <span className="font-mono bg-background/50 px-2 py-1 rounded border border-border font-medium">
                {vehicle.immatriculationRaw}
              </span>
              <button
                onClick={() => {
                  setIsEditingImmat(true);
                  setImmatInput(vehicle.immatriculationRaw || "");
                }}
                className="ml-auto text-xs underline text-primary"
              >
                Verifier
              </button>
            </div>
          )}

          <div className="col-span-2 mt-1 grid grid-cols-1 md:grid-cols-3 gap-3">
            {vehicle.marque && (
              <div className="flex flex-col gap-1 rounded-xl bg-muted/30 px-3 py-3">
                <span className="text-[11px] font-medium text-primary uppercase tracking-[0.16em]">Marque</span>
                <span className="text-sm">{vehicle.marque}</span>
              </div>
            )}

            {vehicle.modele && (
              <div className="flex flex-col gap-1 rounded-xl bg-muted/30 px-3 py-3">
                <span className="text-[11px] font-medium text-primary uppercase tracking-[0.16em]">Modele</span>
                <span className="text-sm">{vehicle.modele}</span>
              </div>
            )}

            {vehicle.annee && (
              <div className="flex flex-col gap-1 rounded-xl bg-muted/30 px-3 py-3">
                <span className="text-[11px] font-medium text-primary uppercase tracking-[0.16em]">Annee</span>
                <span className="text-sm">{vehicle.annee}</span>
              </div>
            )}
          </div>

          {vehicle.vin && (
            <div className="col-span-2 flex items-center gap-2 mt-1 bg-muted/50 px-3 py-3 rounded-xl border border-border/60">
              <div className="flex flex-col">
                <span className="text-[11px] font-medium text-primary uppercase tracking-[0.16em]">VIN</span>
                <span className="text-sm font-mono break-all">{vehicle.vin}</span>
              </div>
            </div>
          )}

          {vehicle.typeMoteur && (
            <div className="col-span-2 flex items-center gap-2 mt-1 bg-muted/50 px-3 py-3 rounded-xl border border-border/60">
              <Settings className="h-4 w-4 text-primary" />
              <div className="flex flex-col">
                <span className="text-[11px] font-medium text-primary uppercase tracking-[0.16em]">Motorisation</span>
                <span className="text-sm">{vehicle.typeMoteur}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
