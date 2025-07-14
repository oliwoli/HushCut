import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Dialog({
  onOpenChange,
  open,
  disableOutsideClick = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & {
  disableOutsideClick?: boolean;
}) {
  const handleOpenChange = (newOpen: boolean) => {
    // If disableOutsideClick is true and the dialog is trying to close (newOpen is false),
    // we prevent it from closing *unless* it's explicitly triggered by the DialogClose component.
    // Radix UI's DialogPrimitive.Root handles outside clicks by calling onOpenChange(false).
    // By not calling onOpenChange here when newOpen is false and disableOutsideClick is true,
    // we effectively prevent outside clicks from closing the dialog.
    // Clicks on DialogPrimitive.Close will still trigger onOpenChange(false) and pass through this check.
    if (disableOutsideClick && !newOpen) {
      return; // Prevent closing from outside clicks
    }
    onOpenChange?.(newOpen);
  };

  return <DialogPrimitive.Root data-slot="dialog" open={open} onOpenChange={handleOpenChange} {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  const container = document.getElementById('overlays');

  // We must return null if the container doesn't exist to prevent errors.
  if (!container) {
    console.error("Portal target #overlays not found in the DOM.");
    return null;
  }

  return <DialogPrimitive.Portal container={container} data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        "top-[2.25rem]", // Exclude titlebar area
        "pointer-events-none", // Allow clicks to pass through
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  hideCloseButton = false,
  disableRadixAnimations = false,
  disableOutsideClick = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  hideCloseButton?: boolean;
  disableRadixAnimations?: boolean;
  disableOutsideClick?: boolean;
}) {
  const animationClasses = disableRadixAnimations
    ? "" // No animations
    : "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // base classes
          "bg-zinc-900 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
          animationClasses, // Conditionally apply animations
          "pointer-events-auto", // Re-enable pointer events for the content
          className
        )}
        onPointerDownOutside={disableOutsideClick ? (e) => e.preventDefault() : undefined}
        {...props}
      >
        {children}
        {!hideCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
