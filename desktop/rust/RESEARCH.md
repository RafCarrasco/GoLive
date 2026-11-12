# Checkpoint 2: API investigation — RETURN, not capture parity

This independent crate is a native policy/diagnostic experiment. It is NOT a replacement application, installer, custom capture picker, or MediaStream producer. No web files, Electron shipping entry points or workflows are changed. All later feature ports remain gated.

## Documented incompatibility reproduced

Electron currently calls `callback({ video: selected.source })` after its custom picker (`../main.cjs:679–693`). WebView2's `ICoreWebView2ScreenCaptureStartingEventArgs` has only Cancel, Handled, OriginalSourceFrameInfo and GetDeferral (plus the inherited IUnknown methods). Cancel denies the call. Handled only stops propagation between frame/core event handlers; it does NOT mean "use my selected source". Deferral delays the decision to display the WebView2 system UI. None accepts an HWND, GraphicsCaptureItem, video track or custom source identifier.

Primary API references inspected:

- https://learn.microsoft.com/en-us/microsoft-edge/webview2/webview2-api-reference
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2screencapturestartingeventargs
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_27
- Pinned generated source: `webview2-com-sys` 0.39.1, `src/bindings.rs`, `impl ICoreWebView2ScreenCaptureStartingEventArgs` and its vtable. Cargo.lock fixes the registry checksum. This is a third-party binding of the primary COM surface, not a Microsoft SDK guarantee by itself.

`python3 desktop/rust/experiments/check-source-api.py` builds a disposable Windows-target crate twice, using this lockfile. Positive control `SetCancel(true)` must typecheck. The deliberately hypothetical `SetSelectedSource(1)` must fail with E0599 for that method, NOT with dependency, compiler or linker errors. The hypothetical method is never used in the implementation; its absence supports the documented incompatibility, not a claim to have exhaustively disproven all adapters. Both fixtures are removed. No Windows runtime is involved.

The old Rust shell was consulted read-only. Only the pure navigation/window concepts were adapted to current identity, origin, permissions and frame/generation requirements. No old workspace or GoLive config was imported. Its unhandled registration errors and system-picker-only approach were not reused.

## Desktop-owned injected route investigated, NOT implemented/proven

The most concrete supported building blocks found are:

1. `IGraphicsCaptureItemInterop::CreateForWindow(HWND, ...)` / CreateForMonitor binds native Windows Graphics Capture to a host-selected source, unlike ScreenCaptureStarting. A native picker must validate/own handles and PIDs, including HWND reuse, session expiry and process lifetime. This is not the WebView2 system picker. Native support/device/OS/consent failures must be visible.
2. A Direct3D11CaptureFramePool supplies actual window/display frames. Its ContentSize must bound copied pixels (padding can be undefined), frames/surfaces cannot outlive checkout, resize/device-loss must recreate safely, BGRA/HDR need explicit conversion. The native producer is NOT implemented here.
3. WebView2 Environment12.CreateSharedBuffer and CoreWebView2_17.PostSharedBufferToScript can share native memory read-only to the MAIN FRAME. This transports an ArrayBuffer, NOT a MediaStream. `candidate_interfaces` typechecks the required QueryInterface calls; it is not exercised on a WebView. Never use frame-post APIs for this route. JSON may contain bounded control/session/slot information, never unbounded video payloads. Read-only mapping writes crash the renderer. Closing native memory does NOT revoke the existing script view: both sides must release; stop producing before navigation. Do not overwrite a slot until its matching session/sequence ACK. Timeouts must close the session rather than queue frames indefinitely.
4. A desktop initialization script could replace only getDisplayMedia in the authorized top document, copy validated live pixels to an origin-clean canvas, and return canvas.captureStream's actual MediaStream/video track to the unchanged caller. No such script is shipped here: a canvas demo or a track-shaped JS object would not establish native compatibility. Tauri's remote capability declarations alone do not prove frame attribution. Tauri integration/ACL configuration is deferred rather than adding an unused broad capability.

Primary sources:

- https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow
- https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment12
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_17
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2sharedbuffer
- https://w3c.github.io/mediacapture-fromelement/ (draft; engine behavior still requires testing)
- https://v2.tauri.app/reference/acl/capability/

Additional browser implementation reference: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream . No browser synthetic source was used as native evidence. Two initially attempted Microsoft/W3C URLs returned 404; the valid links above were retrieved instead. No undocumented source-selection API is assumed.

## Why the candidate does not yet pass checkpoint 2

There is no native producer, native custom picker, shared-memory transport, injected getDisplayMedia bridge or independent browser receive evidence in this artifact. Linux cannot establish Windows engine behavior. A native Windows implementation and interactive experiment are required before selecting this route as viable; this research does NOT prove it impossible either.

The unchanged consumer at `src/live/capture.ts:90–103` awaits setCaptureAudio, requests real getDisplayMedia video with ideal width/height and ideal/max frameRate, adds native audio then attaches game monitoring. A compatible adapter must preserve real MediaStream/MediaStreamTrack methods, applyConstraints/getSettings/capabilities semantics, contentHint, WebRTC publication, getUserMedia camera independence, and rejection/cancel behavior. `stop()` ends a track without firing its own ended event: native resources must still stop; native source closure must produce appropriate termination. Clones/peer references must not leak capture after cancellation. Native request identity cannot come from JS-supplied URL/frame flags.

Native frame policy must reject unknown/zero frame IDs, same-origin iframes, opaque frames, foreign origins/windows and stale documents. FrameInfo2's documentation warns some frame IDs are zero/stale; reject these rather than infer top-level identity from URL alone. See https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2frameinfo2 . The current native guard denies EVERY permission/capture request, so an incomplete attribution adapter never grants access. Portable policy tests model future authorized decisions; they are not wired as production permission grants.

Background/minimized performance, 30/60 fps, multi-monitor/DPI, minimized/fullscreen game source binding, Alt+Tab privacy and app-only/exclude-Nimbo audio remain mandatory. Metadata-only Binding tests do not implement those features. The model's 3840×2160/60 experiment ceiling is not a product resolution restriction. Its two-slot credits are not actual memory/IPC/native-media evidence.

No generic-picker fallback, fake/prerecorded capture, JSON video pump, cookie/token migration, provider changes, updater replacement, portable-only cutover or web edits are authorized substitutes. Electron remains the shipping product. Checkpoint 2 decision remains RETURN.
