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
import {
  AlertTriangle,
  CircleAlert,
  DownloadIcon,
  Info,
  XCircle,
} from "lucide-react"; // Added Download icon
import { buttonVariants } from "../ui/button";
import { cn } from "@/lib/utils";
import { useProgressStore } from "@/stores/progressStore";
import { Progress } from "../ui/progress";

const getAlertIcon = (type: DownloadPromptData["severity"]) => {
  switch (type) {
    case "error":
      return <XCircle className="w-6 h-6 ml-[2px] text-red-700 mb-[1px]" />;
    case "important":
      return <CircleAlert className="w-6 h-6 ml-[2px] text-red-700 mb-[1px]" />;
    case "warning":
      return (
        <AlertTriangle className="w-6 h-6 ml-[2px] text-yellow-700 mb-[1px]" />
      );
    default:
      return (
        <Info className="fill-teal-950/60 w-7 h-7 text-teal-700 mb-1 text-center" />
      );
  }
};

interface DownloadPromptData {
  title: string;
  message: string;
  successTitle: string;
  successMessage: string;
  onDownload: () => Promise<void>;
  severity?: "error" | "warning" | "info" | "important";
  taskFileName?: string;
}

const DownloadPrompt = () => {
  const [alertOpen, setAlertOpen] = useState(false);
  const [downloadPromptData, setAlertData] =
    useState<DownloadPromptData | null>(null); // Initialize as null
  const [internalOpen, setInternalOpen] = useState(false);
  const [dialogOpacity, setDialogOpacity] = useState(1);
  const setBusy = useAppState((s) => s.setBusy);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isFinished, setIsFinished] = useState(false);

  const downloadButtonRef = useRef<HTMLButtonElement>(null);
  const downloadProgress = useProgressStore((s) =>
    downloadPromptData?.taskFileName
      ? s.downloadProgress[downloadPromptData.taskFileName]
      : 0
  );

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

  useEffect(() => {
    // --- MODIFIED --- Event handler now uses the 'onDownload' prop directly
    const handler = (data: DownloadPromptData) => {
      if (!data.onDownload) {
        console.error(
          "showDownloadPrompt event received without an onDownload callback."
        );
        return;
      }
      setBusy(true);
      setIsDownloading(false);
      setAlertData({
        title: data.title || "No title",
        message: data.message || "No message",
        successTitle: data.successTitle || "Download finished",
        successMessage:
          data.successMessage ||
          "Successfully downloaded file. You may continue.",
        severity: data.severity || "info",
        taskFileName: data.taskFileName,
        onDownload: data.onDownload, // Store the callback
      });
      setAlertOpen(true);
    };

    const alertEvent = EventsOn("showDownloadPrompt", handler);
    return () => {
      if (alertEvent) alertEvent();
    };
  }, [setBusy]);

  const handleOpenChange = (isOpen: boolean) => {
    // Prevent closing while downloading
    if (isDownloading) return;

    setAlertOpen(isOpen);
    if (!isOpen) {
      setBusy(false);
      setAlertData(null); // Clean up data on close
    }
  };

  const handleDownloadClick = async (event: React.MouseEvent) => {
    event.preventDefault();

    if (!downloadPromptData?.onDownload) return;

    setIsDownloading(true);
    try {
      await downloadPromptData.onDownload();
      setIsFinished(true);
    } catch (error) {
      console.error("Download failed:", error);
    } finally {
      setIsDownloading(false);
    }
  };

  if (!internalOpen || !downloadPromptData) return null;

  return (
    <AlertDialog open={internalOpen} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        style={{
          opacity: dialogOpacity,
          transition: "opacity 150ms ease-in-out",
        }}
        className="overflow-hidden rounded-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          downloadButtonRef.current?.focus();
        }}
      >
        <div
          className={`absolute top-0 w-full h-[4px] ${
            {
              error: "bg-red-700",
              important: "bg-red-700",
              warning: "bg-amber-700",
              info: "bg-teal-800",
            }[downloadPromptData.severity ?? "info"]
          }`}
        />
        <div className="w-5 h-5 px-0 p-0 absolute top-12 left-5">
          {getAlertIcon(downloadPromptData.severity)}
        </div>
        <AlertDialogHeader className="pl-11 gap-1 mt-2">
          <AlertDialogTitle
            className={cn(
              "transition-opacity duration-1000",
              isFinished ? "text-gray-500" : ""
            )}
            style={{ opacity: isFinished ? "50%" : "100%" }}
          >
            <div className="flex gap-2 items-center text-center">
              {downloadPromptData.title}
            </div>
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-0 transition-opacity duration-1000">
            <div
              className="transition-opacity duration-1000"
              style={{ opacity: isFinished ? "50%" : "100%" }}
            >
              {downloadPromptData.message}
            </div>
            {downloadProgress && downloadPromptData.taskFileName && (
              <div className="h-6 w-full mb-1 mt-2 pt-2">
                <Progress
                  value={downloadProgress ?? 0}
                  className="h-1.5 w-full rounded"
                />
                <div className="text-xs text-right text-muted-foreground pt-1">
                  {downloadProgress?.toFixed(0)} %
                </div>
              </div>
            )}
            {isFinished && (
              <div className="animate-enter-calm-sm text-amber-50 opacity-0 max-h-0 overflow-hidden tracking-tight">
                {downloadPromptData.successMessage}
              </div>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter className="mt-1">
          {isFinished ? (
            // STATE 2: Download is complete
            <AlertDialogAction
              className={cn(
                buttonVariants({ variant: "outline" }),
                "bg-amber-300",
                "text-red-500"
              )}
              onClick={() => handleOpenChange(false)}
            >
              <span className="text-gray-200 fade-in-100 transition-opacity duration-100">
                Continue
              </span>
            </AlertDialogAction>
          ) : (
            // STATE 1: Initial prompt or downloading
            <>
              <AlertDialogCancel disabled={isDownloading}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                ref={downloadButtonRef}
                onClick={handleDownloadClick}
                disabled={isDownloading}
                className={cn(
                  buttonVariants({
                    variant: isDownloading ? "outline" : "default",
                  })
                )}
              >
                {isDownloading ? (
                  "Downloading..."
                ) : (
                  <>
                    <DownloadIcon /> Download
                  </>
                )}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default DownloadPrompt;
