import { Events, Browser, setTransport, type RuntimeTransport } from '@wailsio/runtime';

export function hasNativeBridge(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(
        (window as any).chrome?.webview?.postMessage ||
        (window as any).webkit?.messageHandlers?.external?.postMessage ||
        (window as any).wails?.invoke
    );
}

export function isVitePreview(): boolean {
    if (typeof window === 'undefined') return false;
    if (hasNativeBridge()) return false;
    // Port 9245 is the Vite dev server (which has no Go backend attached).
    // In Wails Server Mode (e.g. port 8080), Wails serves /wails/runtime and connects to Go directly.
    return window.location.port === '9245';
}

export function isBrowserEnvironment(): boolean {
    return isVitePreview();
}

// Only enable mock transport when running standalone in Vite (port 9245) without a Go backend.
// In Server Mode (port 8080), Wails's built-in HTTP fetch transport talks directly to the Go server.
if (isVitePreview()) {
    const browserTransport: RuntimeTransport = {
        async call(objectID: number, method: number, windowName: string, args: any): Promise<any> {
            // objectID 0: Call (Service method bindings)
            if (objectID === 0) {
                const methodID = args?.methodID ?? method;
                switch (methodID) {
                    case 1780012486: // GetAppVersion
                        return "0.3.4 (Browser Preview)";
                    case 351539104: // GetFFmpegStatus
                        return 1; // Status.Ready
                    case 1284527746: // GetFfmpegVersion
                        return "FFmpeg (Browser Preview)";
                    case 1746083693: // GetGoServerPort
                        return 9245;
                    case 4156711874: // GetPythonReadyStatus
                        return true;
                    case 2554697378: // GetSettings
                        return {};
                    case 933096804: // GetToken
                        return "";
                    case 3613097918: // GetUpdateInfo
                        return null;
                    case 1352203027: // HasAValidLicense
                        return true;
                    case 1050264718: // SyncWithDavinci
                    case 2153205730:
                        return {
                            status: "success",
                            message: "Browser Preview Mode: Running without DaVinci Resolve connection.",
                            data: null,
                        };
                    case 2903892510: // CloseApp
                        console.log("[Browser Preview] CloseApp called");
                        return;
                    case 3856108169: // SetWindowAlwaysOnTop
                        return;
                    case 4081882403: // OpenDevTools
                        console.log("[Browser Preview] OpenDevTools called");
                        return;
                    default:
                        console.debug(`[Browser Preview] Unhandled Call method ID: ${methodID}`);
                        return null;
                }
            }

            // objectID 3: Events
            if (objectID === 3) {
                // EmitMethod = 0
                if (method === 0) {
                    const event = args?.[0] || args;
                    if (event && (window as any)._wails?.dispatchWailsEvent) {
                        (window as any)._wails.dispatchWailsEvent(event);
                    }
                }
                return null;
            }

            // objectID 9: Browser
            if (objectID === 9) {
                if (method === 0 && args?.[0]) {
                    window.open(args[0], '_blank');
                }
                return null;
            }

            // objectID 8: System
            if (objectID === 8) {
                switch (method) {
                    case 0: // IsDarkMode
                        return true;
                    case 1: // Environment
                        return { os: "darwin", arch: "arm64" };
                    case 2: // Capabilities
                        return {};
                    default:
                        return null;
                }
            }

            return null;
        },
    };

    setTransport(browserTransport);
}

export function EventsOn(eventName: string, callback: (...args: any[]) => void): () => void {
    return Events.On(eventName, (ev: any) => {
        callback(ev.data);
    });
}

export function EventsEmit(eventName: string, ...data: any[]): void {
    Events.Emit(eventName, data.length === 1 ? data[0] : data);
}

export const BrowserOpenURL = (url: string) => Browser.OpenURL(url);

export { Events, Browser };
