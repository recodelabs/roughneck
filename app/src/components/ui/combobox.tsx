import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Select-style combobox: a trigger button showing the current value, and a
 * popup holding a search field plus the full list of items.
 *
 * This is the "pulldown" counterpart to {@link ./autocomplete}. The autocomplete
 * keeps its input in the page and only opens while you type — so the list is
 * always filtered by whatever is already in the field. Here the input lives
 * *inside* the popup and starts empty on every open, so clicking the trigger
 * always shows every item.
 */
function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>,
) {
  return <ComboboxPrimitive.Root data-slot="combobox" {...props} />;
}

function ComboboxTrigger({
  className,
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        "flex h-10 cursor-pointer items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm text-slate-950 dark:text-slate-50 outline-none transition hover:bg-black/[0.02] dark:hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-slate-300/70 dark:focus-visible:ring-slate-600/70 disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:ring-2 data-[popup-open]:ring-slate-300/70 dark:data-[popup-open]:ring-slate-600/70",
        className,
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.Icon
        data-slot="combobox-icon"
        className="flex shrink-0 items-center text-stone-400 dark:text-stone-500 transition-transform data-[popup-open]:rotate-180"
      >
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </ComboboxPrimitive.Icon>
    </ComboboxPrimitive.Trigger>
  );
}

/**
 * The selected value. The primitive renders bare text, so wrap it in a span
 * that can be truncated inside the trigger.
 */
function ComboboxValue({
  className,
  ...props
}: ComboboxPrimitive.Value.Props & { className?: string }) {
  return (
    <span
      data-slot="combobox-value"
      className={cn("min-w-0 truncate text-left", className)}
    >
      <ComboboxPrimitive.Value {...props} />
    </span>
  );
}

function ComboboxContent({
  className,
  sideOffset = 5,
  children,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<ComboboxPrimitive.Positioner.Props, "sideOffset" | "align">) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "z-50 flex max-h-[min(20rem,var(--available-height))] w-max min-w-[var(--anchor-width)] max-w-[min(24rem,var(--available-width))] origin-(--transform-origin) flex-col overflow-hidden rounded-lg border border-[#DCD6CC] dark:border-slate-700 bg-[#FFFDFC] dark:bg-slate-800 text-xs text-stone-700 dark:text-stone-300 shadow-[0_12px_32px_rgba(57,47,38,0.16)] dark:shadow-[0_12px_32px_rgba(0,0,0,0.4)] data-[ending-style]:animate-out data-[ending-style]:fade-out-0 data-[ending-style]:zoom-out-95 data-[starting-style]:animate-in data-[starting-style]:fade-in-0 data-[starting-style]:zoom-in-95",
            className,
          )}
          {...props}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

/** Search field pinned to the top of the popup. */
function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <div className="border-b border-[#DCD6CC] dark:border-slate-700 p-1">
      <ComboboxPrimitive.Input
        data-slot="combobox-input"
        className={cn(
          "h-8 w-full rounded-md bg-transparent px-2 text-xs text-slate-950 dark:text-slate-50 outline-none placeholder:text-stone-400",
          className,
        )}
        spellCheck={false}
        autoCapitalize="none"
        autoComplete="off"
        {...props}
      />
    </div>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("overflow-y-auto p-1", className)}
      {...props}
    />
  );
}

function ComboboxItem({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[0.72rem] leading-none outline-none transition select-none data-[highlighted]:bg-[#EEE9E1] dark:data-[highlighted]:bg-slate-700 data-[highlighted]:text-stone-900 dark:data-[highlighted]:text-stone-100 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ComboboxPrimitive.ItemIndicator
        data-slot="combobox-item-indicator"
        className="ml-auto flex size-3 shrink-0 items-center justify-center text-stone-700 dark:text-stone-300"
      >
        <Check className="size-3" aria-hidden="true" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "px-3 py-2 text-[0.72rem] text-stone-400 dark:text-stone-500 empty:m-0 empty:p-0",
        className,
      )}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
};
