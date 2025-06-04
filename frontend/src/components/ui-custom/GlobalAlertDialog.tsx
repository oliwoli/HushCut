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
} from "@/components/ui/alert-dialog"; // Adjust the import path as necessary

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

    // Subscribe to the event and store the unsubscribe function
    unsubscribeRef.current = EventsOn("showAlert", handler);

    // Cleanup function to unsubscribe when the component unmounts
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, []);

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
