import { useEffect, useRef, useState } from "react";
import { EventsOn } from "@wails/runtime";

// 1. We switch back to AlertDialog because it has the desired persistence.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface AlertData {
  title: string;
  message: string;
  severity?: "info" | "warning" | "error";
}

const GlobalAlertDialog = () => {
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertData, setAlertData] = useState<AlertData>({
    title: "",
    message: "",
    severity: "info",
  });

  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const handler = (data: any) => {
      console.log("Event: showAlert", data);
      setAlertData({
        title: data.title || "No title",
        message: data.message || "No message",
        severity: data.severity || "info",
      });
      setAlertOpen(true);
    };

    unsubscribeRef.current = EventsOn("showAlert", handler);

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, []);

  // 2. This is the "hack" you proposed, implemented in a useEffect hook.
  useEffect(() => {
    const rootEl = document.getElementById('root');

    if (alertOpen) {
      // Radix applies its style changes in a microtask. To ensure our override
      // runs *after* Radix, we use a setTimeout with a delay of 0.
      const timerId = setTimeout(() => {
        // Force the body to be interactive, overriding Radix's style.
        document.body.style.pointerEvents = 'auto';
        // Apply the 'none' style to our main app container instead.
        if (rootEl) {
          rootEl.style.pointerEvents = 'none';
        }
      }, 0);

      return () => clearTimeout(timerId);

    } else {
      // When the dialog closes, clean up our custom styles.
      document.body.style.pointerEvents = '';
      if (rootEl) {
        rootEl.style.pointerEvents = '';
      }
    }
  }, [alertOpen]); // This effect runs whenever the dialog opens or closes.


  return (
    <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{alertData.title}</AlertDialogTitle>
          <AlertDialogDescription>{alertData.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => setAlertOpen(false)}>
            Continue
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default GlobalAlertDialog;