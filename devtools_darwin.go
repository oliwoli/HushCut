//go:build darwin && devtools

package main

/*
#cgo CFLAGS: -mmacosx-version-min=10.13 -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface _WKInspector : NSObject
- (void)connect;
- (void)show;
- (void)showConsole;
- (void)detach;
- (BOOL)isConnected;
- (BOOL)isVisible;
@end

@interface WKWebView (HushCutDevTools)
- (_WKInspector *)_inspector;
@end

static WKWebView* findWKWebView(NSWindow *window) {
    if (!window) return nil;
    NSView *contentView = [window contentView];
    if (!contentView) return nil;
    NSMutableArray *queue = [NSMutableArray arrayWithObject:contentView];
    while ([queue count] > 0) {
        NSView *v = [queue firstObject];
        [queue removeObjectAtIndex:0];
        if ([v isKindOfClass:[WKWebView class]]) {
            return (WKWebView *)v;
        }
        [queue addObjectsFromArray:[v subviews]];
    }
    return nil;
}

// Workaround for upstream Wails v3 bug (https://github.com/wailsapp/wails/issues/6121):
// In Wails v3 webview_window_darwin_dev.go:
//   if (@available(macOS 13.3, *)) {
//       nsWindow.webView.inspectable = YES;
//       return; // <-- Early return skips setting developerExtrasEnabled on macOS 13.3+
//   }
// Furthermore, wailsPrivateOpenWebInspector calls [nsWindow.webView._inspector show] without
// calling [inspector connect], so modern WebKit silently ignores the show request.
void enableWebKitDeveloperExtras(void *nsWindowPtr) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSWindow *window = (__bridge NSWindow *)nsWindowPtr;
        if (!window) {
            window = [NSApp keyWindow];
        }
        WKWebView *wv = findWKWebView(window);
        if (!wv) return;

        @try {
            [wv.configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
        } @catch (NSException *e) {}

#if MAC_OS_X_VERSION_MAX_ALLOWED >= 130300
        if (@available(macOS 13.3, *)) {
            wv.inspectable = YES;
        }
#endif
    });
}

void openWebKitInspector(void *nsWindowPtr) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSWindow *window = (__bridge NSWindow *)nsWindowPtr;
        if (!window) {
            window = [NSApp keyWindow];
        }
        WKWebView *wv = findWKWebView(window);
        if (!wv) return;

        @try {
            [wv.configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
        } @catch (NSException *e) {}

#if MAC_OS_X_VERSION_MAX_ALLOWED >= 130300
        if (@available(macOS 13.3, *)) {
            wv.inspectable = YES;
        }
#endif

        if ([wv respondsToSelector:@selector(_inspector)]) {
            id inspector = [wv performSelector:@selector(_inspector)];
            if (inspector) {
                if ([inspector respondsToSelector:@selector(connect)]) {
                    [inspector performSelector:@selector(connect)];
                }
                if ([inspector respondsToSelector:@selector(show)]) {
                    [inspector performSelector:@selector(show)];
                }
            }
        }
    });
}
*/
import "C"
import "unsafe"

func enableNativeDevTools(nativeWindow unsafe.Pointer) {
	C.enableWebKitDeveloperExtras(nativeWindow)
}

func openNativeDevTools(nativeWindow unsafe.Pointer) {
	C.openWebKitInspector(nativeWindow)
}
