import { Car } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface HeaderProps {
  vehicleCount: number;
}

export function Header({ vehicleCount }: HeaderProps) {
  return (
    <div className="py-6 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="h-20 w-20 relative">
              <img
                src="/logo-volvo.png"
                alt="Volvo Logo"
                className="w-full h-full object-contain"
              />
              {vehicleCount > 0 && (
                <Badge
                  variant="default"
                  className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs bg-secondary shadow-lg animate-in zoom-in-50"
                >
                  {vehicleCount}
                </Badge>
              )}
            </div>
          </div>
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-primary via-primary to-secondary bg-clip-text text-transparent">
              Volvo Parts Assistant
            </h1>
            <p className="text-sm text-muted-foreground">
              Une experience de recherche de pieces pensee pour l'univers Volvo
            </p>
          </div>
        </div>
      </div>

      {vehicleCount > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground animate-in fade-in-50 slide-in-from-top-2">
          <Car className="h-3.5 w-3.5" />
          <span>{vehicleCount} vehicule{vehicleCount > 1 ? "s" : ""} Volvo charge{vehicleCount > 1 ? "s" : ""}</span>
        </div>
      )}
    </div>
  );
}
