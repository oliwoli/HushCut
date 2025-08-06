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
import { Button, buttonVariants } from "../ui/button";
import { Input } from "../ui/input";
import { VerifyLicense } from "@wails/go/main/App";

const getAlertIcon = (type: AlertData["status"]) => {
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
  status?: "invalid" | "expired" | "error" | "warning" | "info";
}

const LicensePrompt = () => {
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertData, setAlertData] = useState<AlertData>({
    title: "",
    message: "",
  });

  const [internalOpen, setInternalOpen] = useState(false);
  const [dialogOpacity, setDialogOpacity] = useState(1);

  const [licenseKey, setLicenseKey] = useState("");


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
    const licenseInvalidEvent = EventsOn("license:invalid", () => {
      console.log("license invalid event triggered");
      setAlertData({
        title: "Activate License",
        message: "Please enter your license key below",
        status: "warning",
      });
      setAlertOpen(true);
    });
    return () => {
      if (licenseInvalidEvent) licenseInvalidEvent();
    };

  }, []);

  const handleVerify = async () => {
    setBusy(true);
    try {
      // This calls the Go function
      const licenseData = await VerifyLicense(licenseKey);
      console.log("License is valid!", licenseData);
      // On success, you'd likely close the dialog and maybe
      // trigger a global state change to unlock the app.
      handleOpenChange(false);
    } catch (error) {
      console.error("License verification failed:", error);
      // Update the alert to show the error message
      setAlertData({
        title: "Activation Failed",
        message: String(error),
        status: "error",
      });
    } finally {
      setBusy(false);
    }
  };

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
            expired: "bg-yellow-700",
            invalid: "bg-red-700",
          }[alertData.status ?? "info"]
            }`}
        />
        <div className="w-5 h-5 px-0 p-0 absolute top-12 left-5">{getAlertIcon(alertData.status)}</div>
        <AlertDialogHeader className="pl-11 gap-1 mt-2">
          <AlertDialogTitle className="mb-0">
            <div className="flex gap-2 items-center text-center">
              {alertData.title}
            </div>
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-0">{alertData.message}</AlertDialogDescription>
          <Input
            type="text"
            placeholder="Add License Key"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
          />
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-1">
          <Button
            variant={"secondary"}
            onClick={handleVerify}
            disabled={licenseKey.length < 35 || isBusy}
          >
            Continue
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default LicensePrompt;
