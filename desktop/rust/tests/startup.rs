use nimbo_desktop::shell::{Startup, StartupError};

#[test]
fn missing_or_failed_native_handlers_never_allow_navigation() {
    for hooks in [
        [false, false, false],
        [true, false, true],
        [true, true, false],
        [false, true, true],
    ] {
        let state = Startup::new(hooks[0], hooks[1], hooks[2]);
        assert_eq!(
            state.release_navigation(),
            Err(StartupError::MissingNativeGuards)
        );
    }
}

#[test]
fn installed_deny_guards_are_not_media_or_frame_proof() {
    let state = Startup::new(true, true, true);
    assert_eq!(
        state.release_navigation(),
        Err(StartupError::CaptureNotProven)
    );
}
