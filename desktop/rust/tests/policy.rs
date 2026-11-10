use nimbo_desktop::policy::*;

fn main_frame() -> NativeRequest<'static> {
    NativeRequest {
        window: "main",
        source: HOSTED_URL,
        frame_id: Some(7),
        main_frame_id: Some(7),
        parent_frame_id: None,
        document_generation: 1,
    }
}

#[test]
fn origin_navigation_and_popup_matrix() {
    let c = Config::release();
    for url in [
        HOSTED_URL,
        "https://golive-ad118.web.app:443/room?x=1",
        "https://GOLIVE-AD118.web.app/room",
    ] {
        assert_eq!(c.navigation(url), Navigation::Allow, "{url}");
        assert_eq!(
            c.popup(url),
            Navigation::External,
            "popups never become app windows"
        );
    }
    for url in [
        "https://golive-ad118.web.app.evil.test/",
        "https://example.org/",
    ] {
        assert_eq!(c.navigation(url), Navigation::External);
    }
    for url in [
        "https://golive-ad118.web.app:444/",
        "http://golive-ad118.web.app/",
        "https://user@golive-ad118.web.app/",
        "https://golive-ad118.web.app@evil.test/",
        "javascript:alert(1)",
        "data:text/html,x",
        "blob:https://golive-ad118.web.app/x",
        "file:///c:/",
        "about:blank",
        "garbage",
        " https://golive-ad118.web.app/",
        "https://golive-ad118.web.app/\n",
    ] {
        assert_ne!(c.navigation(url), Navigation::Allow, "{url}");
    }
    assert_eq!(c.popup("https://user@example.org/"), Navigation::Deny);
    assert_eq!(c.popup("http://example.org/"), Navigation::Deny);
}

#[test]
fn native_authorization_requires_host_owned_frame_window_and_generation() {
    let c = Config::release();
    assert!(c.authorize(&main_frame(), 1));
    for request in [
        NativeRequest {
            source: "https://evil.test/",
            ..main_frame()
        },
        NativeRequest {
            window: "picker",
            ..main_frame()
        },
        NativeRequest {
            parent_frame_id: Some(7),
            frame_id: Some(8),
            ..main_frame()
        },
        NativeRequest {
            parent_frame_id: Some(9),
            ..main_frame()
        },
        NativeRequest {
            frame_id: None,
            ..main_frame()
        },
        NativeRequest {
            main_frame_id: None,
            ..main_frame()
        },
        NativeRequest {
            frame_id: Some(0),
            main_frame_id: Some(0),
            ..main_frame()
        },
        NativeRequest {
            document_generation: 0,
            ..main_frame()
        },
        NativeRequest {
            document_generation: 2,
            ..main_frame()
        },
    ] {
        assert!(!c.authorize(&request, 1), "{request:?}");
        assert!(!c.permission(&request, 1, Permission::Camera));
        assert!(!c.command(&request, 1, "nimbo:capture:stop"));
    }
}

#[test]
fn deny_unknown_permissions_and_commands_and_unproven_capture() {
    let c = Config::release();
    let r = main_frame();
    for permission in [
        Permission::Camera,
        Permission::Microphone,
        Permission::Fullscreen,
        Permission::SanitizedClipboardWrite,
    ] {
        assert!(c.permission(&r, 1, permission));
    }
    for permission in [
        Permission::DisplayCapture,
        Permission::ClipboardRead,
        Permission::Other,
    ] {
        assert!(!c.permission(&r, 1, permission));
    }
    // Only resource cancellation is modeled at this checkpoint, not a real IPC dispatcher.
    assert!(c.command(&r, 1, "nimbo:capture:stop"));
    for command in [
        "nimbo:capture:start",
        "spawn",
        "eval",
        "read_file",
        "plugin:shell|open",
        "nimbo:signIn",
        "nimbo:capture:stop ",
    ] {
        assert!(!c.command(&r, 1, command));
    }
}
