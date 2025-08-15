import { useEffect, useRef, useState } from "react";
import { EventsOn } from "@wails/runtime";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { useAppState } from "@/stores/appSync";
import { AlertTriangle, Info, XCircle } from "lucide-react"; // or whichever icons you prefer
import { buttonVariants } from "../ui/button";
import { cn } from "@/lib/utils";

const getAlertIcon = (type: AlertData["severity"]) => {
  switch (type) {
    case "error":
      return <XCircle className="w-6 h-6 ml-[2px] text-red-700 mb-[1px]" />;
    case "warning":
      return <AlertTriangle className="w-6 h-6 ml-[2px] text-yellow-700 mb-[1px]" />;
    case "info":
      return <Info className="fill-teal-950/60 w-7 h-7 text-teal-700 mb-1 text-center" />;
    default:
      return <Info className="fill-teal-950/60 w-7 h-7 text-teal-700 mb-1 text-center" />;
  }
};


interface AlertAction {
  label: string;
  onClick: () => void;
  // Optional: Add other props like `className` if you want more customization
}

interface AlertData {
  title: string;
  message: string;
  actions?: AlertAction[]; // Add actions array to the interface
  severity?: "error" | "warning" | "info";
}

const GlobalAlertDialog = () => {
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertData, setAlertData] = useState<AlertData>({
    title: "",
    message: "",
  });

  const [internalOpen, setInternalOpen] = useState(false);
  const [dialogOpacity, setDialogOpacity] = useState(1);

  useEffect(() => {
    if (alertOpen) {
      setInternalOpen(true);
      setDialogOpacity(1);
    } else {
      setDialogOpacity(0);
      const fadeOutTimer = setTimeout(() => {
        setInternalOpen(false);
      }, 150); // Match transition duration
      return () => clearTimeout(fadeOutTimer);
    }
  }, [alertOpen]);

  const isBusy = useAppState(s => s.isBusy);
  const setBusy = useAppState(s => s.setBusy);
  const isBusyRef = useRef(isBusy);

  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  useEffect(() => {
    const handler = (data: AlertData) => {
      console.log("alert data: ", data)
      // 1. Set the app to busy *when the event is received*.
      setBusy(true);

      // 2. Set the alert data and open it.
      setAlertData({
        title: data.title || "No title",
        message: data.message || "No message",
        actions: data.actions || [],
        severity: data.severity || "info"
      });
      setAlertOpen(true);
    };

    const alertEvent = EventsOn("showAlert", handler);
    return () => {
      if (alertEvent) alertEvent();
    };

  }, []); // The handler no longer needs dependencies

  // Dialog open/close logic
  const handleOpenChange = (isOpen: boolean) => {
    setAlertOpen(isOpen);
    if (!isOpen) {
      setBusy(false);
      console.log("closing alert!");
    } else {
      console.log("opening alert!");
    }
  };

  if (!internalOpen) return null;

  return (
    <AlertDialog open={internalOpen} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        style={{ opacity: dialogOpacity, transition: 'opacity 150ms ease-in-out' }}
        disableRadixAnimations={dialogOpacity === 0
        }
        className="overflow-hidden rounded-sm"
      >
        <div
          className={`absolute top-0 w-full h-[4px] ${{
            error: "bg-red-700",
            warning: "bg-amber-700",
            info: "bg-teal-800",
          }[alertData.severity ?? "info"]
            }`}
        />
        <div className="w-5 h-5 px-0 p-0 absolute top-12 left-5">{getAlertIcon(alertData.severity)}</div>
        <AlertDialogHeader className="pl-11 gap-1 mt-2">
          <AlertDialogTitle className="mb-0">
            <div className="flex gap-2 items-center text-center">
              {alertData.title}
            </div>
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-0">{alertData.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-1">
          <AlertDialogAction
            className={cn(
              buttonVariants({
                variant: alertData.actions?.length ? "outline" : "default",
              }),
              "focus-visible:border-0 focus-visible:ring-teal-600 focus-visible:ring-2 focus-visible:bg-teal-100"
            )}
          >
            Continue
          </AlertDialogAction>          {alertData.actions && alertData.actions.map((action, index) => (
            <AlertDialogAction key={index} onClick={action.onClick}>
              {action.label}
            </AlertDialogAction>
          ))}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default GlobalAlertDialog;
