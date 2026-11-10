use nimbo_desktop::policy::{APP_ID, Config, HOSTED_URL, MAIN_WINDOW, Navigation};

#[test]
fn current_nimbo_identity_and_window_are_not_old_golive() {
    assert_eq!(APP_ID, "app.nimbo.desktop");
    assert_eq!(MAIN_WINDOW.title, "Nimbo");
    assert_eq!((MAIN_WINDOW.width, MAIN_WINDOW.height), (1280, 800));
    assert_eq!((MAIN_WINDOW.min_width, MAIN_WINDOW.min_height), (850, 590));
    assert_eq!(MAIN_WINDOW.background, [0x0b, 0x10, 0x20]);
    const { assert!(!MAIN_WINDOW.menu) };
    assert_eq!(Config::release().start_url(), HOSTED_URL);
    assert_eq!(HOSTED_URL, "https://golive-ad118.web.app/");
}

#[test]
fn loopback_is_explicit_and_never_a_release_override() {
    assert!(Config::for_test("http://127.0.0.1:5173/").is_ok());
    assert!(Config::for_test("http://localhost:5173/").is_ok());
    for url in [
        "http://0.0.0.0:5173/",
        "https://evil.test/",
        "http://localhost.evil:5173/",
        "http://user@localhost:5173/",
        "http://127.0.0.1/",
        "file:///test",
    ] {
        assert!(Config::for_test(url).is_err(), "{url}");
    }
    let local = Config::for_test("http://127.0.0.1:5173/").unwrap();
    assert_eq!(
        local.navigation("http://127.0.0.1:5173/room"),
        Navigation::Allow
    );
    assert_ne!(
        local.navigation("http://127.0.0.1:5174/"),
        Navigation::Allow
    );
    assert_ne!(
        Config::release().navigation(local.start_url()),
        Navigation::Allow
    );
}
