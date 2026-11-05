import { Events, Browser } from '@wailsio/runtime';

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
