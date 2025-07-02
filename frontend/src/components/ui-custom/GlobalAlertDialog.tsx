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

import { useSyncBusyState } from "@/stores/appSync";

interface AlertAction {
  label: string;
  onClick: () => void;
  // Optional: Add other props like `className` if you want more customization
}

interface AlertData {
  title: string;
  message: string;
  actions?: AlertAction[]; // Add actions array to the interface
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

  const isBusy = useSyncBusyState(s => s.isBusy);
  const setBusy = useSyncBusyState(s => s.setBusy);
  const isBusyRef = useRef(isBusy);


  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  useEffect(() => {
    // --- THIS IS THE KEY CHANGE ---
    // The handler now takes full control of the busy state.
    const handler = (data: AlertData) => {
      // 1. Set the app to busy *when the event is received*.
      setBusy(true);

      // 2. Set the alert data and open it.
      setAlertData({
        title: data.title || "No title",
        message: data.message || "No message",
        actions: data.actions || [],
      });
      setAlertOpen(true);
    };

    const unsubscribe = EventsOn("showAlert", handler);
    return () => {
      if (unsubscribe) unsubscribe();
      // No need for the timer ref anymore if you remove the retry logic
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
        disableRadixAnimations={dialogOpacity === 0}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{alertData.title}</AlertDialogTitle>
          <AlertDialogDescription>{alertData.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {alertData.actions && alertData.actions.map((action, index) => (
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
