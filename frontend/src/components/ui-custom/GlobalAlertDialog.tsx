import { useEffect, useRef, useState } from "react";
import { EventsOn } from "@wails/runtime";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useBusy } from "@/context/useBusy";

interface AlertData {
  title: string;
  message: string;
}

const GlobalAlertDialog = () => {
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertData, setAlertData] = useState<AlertData>({
    title: "",
    message: "",
  });

  const isBusy = useBusy(s => s.isBusy);
  const setIsBusy = useBusy(s => s.setIsBusy);

  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (data: any) => {
      alertTimerRef.current = setTimeout(() => {
        if (isBusy) {
          setAlertData({
            title: data.title || "No title",
            message: data.message || "No message",
          });
          setAlertOpen(true);
        } else {
          console.warn("showAlert event received, but app is not busy. Ignoring.");
        }
      }, 50)
    };

    const unsubscribe = EventsOn("showAlert", handler);
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Pointer-events logic
  useEffect(() => {
    const rootEl = document.getElementById('root');
    let timerId;

    if (alertOpen) {
      console.log("opening alert!")
      timerId = setTimeout(() => {
        document.body.style.pointerEvents = 'auto';
        if (rootEl) rootEl.style.pointerEvents = 'none';
      }, 0);

    } else {
      // Cleanup styles after the closing animation.
      timerId = setTimeout(() => {
        document.body.style.pointerEvents = '';
        if (rootEl) rootEl.style.pointerEvents = '';
      }, 200);
    }

    return () => clearTimeout(timerId);
  }, [alertOpen]);

  // NEW: Custom handler to release the lock when the dialog closes.
  const handleOpenChange = (isOpen: boolean) => {
    setAlertOpen(isOpen);
    if (!isOpen) {
      console.log("closing alert!")
      setIsBusy(false);
    }
    else {
      console.log("opening alert!")
    }
  };

  return (
    // Use our new handler for onOpenChange
    <AlertDialog open={alertOpen} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{alertData.title}</AlertDialogTitle>
          <AlertDialogDescription>{alertData.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* AlertDialogAction will trigger onOpenChange(false) automatically */}
          <AlertDialogAction>
            Continue
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default GlobalAlertDialog;