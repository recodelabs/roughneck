import { Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type ConflictChoice, type MergeRegion, resolveRegions } from "./merge";

export interface ConflictResolveDialogProps {
  /** The full region list from the merge (stable + conflict), in document order. */
  regions: MergeRegion[];
  /** Apply the chosen resolution and save it. */
  onResolve: (text: string) => void | Promise<void>;
  /** Discard our draft and take the server's version instead. */
  onTakeTheirs: () => void;
  /** Cancel — keep editing locally with autosave paused. */
  onCancel: () => void;
}

const choiceLabels: Record<ConflictChoice, string> = {
  ours: "Keep yours",
  theirs: "Use theirs",
  both: "Keep both",
};

function ChoiceColumn({
  title,
  lines,
  selected,
  onSelect,
  tone,
}: {
  title: string;
  lines: string[];
  selected: boolean;
  onSelect: () => void;
  tone: "ours" | "theirs";
}) {
  const accent =
    tone === "ours"
      ? "border-sky-300 dark:border-sky-800"
      : "border-violet-300 dark:border-violet-800";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border bg-background p-2 text-left transition-colors ${
        selected
          ? `${accent} ring-2 ring-ring/40`
          : "border-border hover:bg-muted/50"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{title}</span>
        {selected ? (
          <Check className="size-3.5 text-foreground" aria-hidden="true" />
        ) : null}
      </div>
      <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground">
        {lines.length > 0 ? lines.join("\n") : "(empty)"}
      </pre>
    </button>
  );
}

export function ConflictResolveDialog({
  regions,
  onResolve,
  onTakeTheirs,
  onCancel,
}: ConflictResolveDialogProps) {
  const conflicts = regions.filter((region) => region.type === "conflict");
  // Default every conflict to keeping our edits — the person is actively typing.
  const [choices, setChoices] = useState<ConflictChoice[]>(() =>
    conflicts.map(() => "ours"),
  );
  const [saving, setSaving] = useState(false);

  // A second concurrent save can re-render this same instance with a fresh
  // `regions` set. The `useState` initializer above only runs on mount, so
  // reset choices to the new conflicts' defaults whenever `regions` changes —
  // otherwise resolveRegions would apply stale picks to the wrong regions and
  // silently drop a merge side. (React's "adjust state during render" pattern.)
  const [prevRegions, setPrevRegions] = useState(regions);
  if (prevRegions !== regions) {
    setPrevRegions(regions);
    setChoices(conflicts.map(() => "ours"));
  }

  const setChoice = (index: number, choice: ConflictChoice) => {
    setChoices((prev) => {
      const next = [...prev];
      next[index] = choice;
      return next;
    });
  };

  const handleApply = async () => {
    setSaving(true);
    try {
      await onResolve(resolveRegions(regions, choices));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        data-testid="conflict-resolve-dialog"
        className="max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Resolve edit conflict</DialogTitle>
          <DialogDescription>
            Someone else saved changes that overlap your edits.{" "}
            {conflicts.length === 1
              ? "Pick which version to keep for the conflicting section."
              : `Pick which version to keep for each of the ${conflicts.length} conflicting sections.`}{" "}
            Everything you both edited elsewhere has already been merged.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[55vh] flex-col gap-4 overflow-auto">
          {conflicts.map((conflict, index) => {
            if (conflict.type !== "conflict") return null;
            const choice = choices[index];
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: conflicts are positional and stable for this dialog
                key={index}
                data-testid="conflict-region"
                className="flex flex-col gap-2"
              >
                <div className="text-xs font-medium text-muted-foreground">
                  Conflict {index + 1} of {conflicts.length}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <ChoiceColumn
                    title="Your version"
                    lines={conflict.ours}
                    tone="ours"
                    selected={choice === "ours"}
                    onSelect={() => setChoice(index, "ours")}
                  />
                  <ChoiceColumn
                    title="Their version"
                    lines={conflict.theirs}
                    tone="theirs"
                    selected={choice === "theirs"}
                    onSelect={() => setChoice(index, "theirs")}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(["ours", "theirs", "both"] as const).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={choice === value ? "default" : "outline"}
                      onClick={() => setChoice(index, value)}
                    >
                      {choiceLabels[value]}
                    </Button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            data-testid="conflict-take-theirs"
            onClick={onTakeTheirs}
            disabled={saving}
          >
            Discard my edits
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={onCancel}
              disabled={saving}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid="conflict-apply"
              onClick={() => void handleApply()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Apply & save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
