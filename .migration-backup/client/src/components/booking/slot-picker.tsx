import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { Service } from "@shared/schema";

interface Slot {
  startsAt: string;
  endsAt: string;
  resourceIds: number[];
}

interface SlotPickerProps {
  service: Service;
  timezone?: string;
  selectedSlot: Slot | null;
  onSelectSlot: (slot: Slot | null) => void;
}

// Customer-facing slot picker. Date input + grid of available time buttons.
export function SlotPicker({
  service,
  timezone = "America/New_York",
  selectedSlot,
  onSelectSlot,
}: SlotPickerProps) {
  // Default to tomorrow in the customer's timezone
  const tomorrowIso = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return formatInTimeZone(d, timezone, "yyyy-MM-dd");
  }, [timezone]);

  const [date, setDate] = useState(tomorrowIso);

  const { data, isLoading, isError, error } = useQuery<{ slots: Slot[] }>({
    queryKey: ["/api/booking/availability", service.id, date, timezone],
    queryFn: async () => {
      const params = new URLSearchParams({
        serviceId: String(service.id),
        date,
        timezone,
      });
      const res = await fetch(`/api/booking/availability?${params.toString()}`);
      if (!res.ok) throw new Error(`Availability lookup failed: ${res.status}`);
      return res.json();
    },
  });

  const slots = data?.slots ?? [];

  // If user changes date, drop the selected slot
  const handleDateChange = (newDate: string) => {
    setDate(newDate);
    if (selectedSlot) onSelectSlot(null);
  };

  // Min date: today (not yesterday). Max date: service.maxAdvanceDays from now.
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const maxDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + service.maxAdvanceDays);
    return formatInTimeZone(d, timezone, "yyyy-MM-dd");
  }, [service.maxAdvanceDays, timezone]);

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="booking-date">Pick a date</Label>
        <Input
          id="booking-date"
          type="date"
          value={date}
          min={today}
          max={maxDate}
          onChange={e => handleDateChange(e.target.value)}
          className="mt-1"
          data-testid="input-booking-date"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Times shown in {timezone.replace("_", " ")}
        </p>
      </div>

      <div>
        <Label>Available times</Label>
        {isLoading && (
          <div className="grid grid-cols-3 gap-2 mt-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        )}

        {isError && (
          <p className="text-sm text-red-600 mt-2">
            Couldn't load times. {(error as Error).message}
          </p>
        )}

        {!isLoading && !isError && slots.length === 0 && (
          <p className="text-sm text-muted-foreground mt-2 p-3 border border-dashed rounded">
            No availability on this date. Try another day.
          </p>
        )}

        {!isLoading && slots.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mt-2" data-testid="slot-grid">
            {slots.map(slot => {
              const isSelected = selectedSlot?.startsAt === slot.startsAt;
              const label = formatInTimeZone(new Date(slot.startsAt), timezone, "h:mm a");
              return (
                <Button
                  key={slot.startsAt}
                  type="button"
                  variant={isSelected ? "default" : "outline"}
                  size="sm"
                  onClick={() => onSelectSlot(isSelected ? null : slot)}
                  data-testid={`slot-${slot.startsAt}`}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        )}
      </div>

      {selectedSlot && (
        <div className="p-3 bg-green-50 border border-green-200 rounded text-sm">
          <strong>Selected:</strong>{" "}
          {formatInTimeZone(new Date(selectedSlot.startsAt), timezone, "EEEE, MMMM d, yyyy 'at' h:mm a")}
        </div>
      )}
    </div>
  );
}
