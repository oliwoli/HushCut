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

import { useSyncBusyState } from "@/stores/appSync";

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

  const isBusy = useSyncBusyState(s => s.isBusy);
  const setBusy = useSyncBusyState(s => s.setBusy);
  const isBusyRef = useRef(isBusy);


  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  useEffect(() => {
    const handler = (data: any) => {
      const maxRetries = 5;
      const retryDelay = 30;
      let retries = 0;

      const waitUntilBusy = () => {
        if (isBusyRef.current) {
          setAlertData({
            title: data.title || "No title",
            message: data.message || "No message",
          });
          setAlertOpen(true);
        } else if (retries < maxRetries) {
          retries++;
          alertTimerRef.current = setTimeout(waitUntilBusy, retryDelay);
        } else {
          console.warn("showAlert event received, but app is not busy. Ignoring after retries.");
        }
      };
      waitUntilBusy();
    };

    const unsubscribe = EventsOn("showAlert", handler);
    return () => {
      if (unsubscribe) unsubscribe();
      if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    };
  }, [isBusy]);

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

  return (
    <AlertDialog open={alertOpen} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{alertData.title}</AlertDialogTitle>
          <AlertDialogDescription>{alertData.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default GlobalAlertDialog;
