//! Feasibility invariants only. These tests do not capture a screen or construct a MediaStream.
use nimbo_desktop::capture::*;

fn binding() -> Binding {
    Binding {
        source: Source::Window { hwnd: 101, pid: 42 },
        audio: AudioIntent::IncludeProcess(42),
        game_pid: Some(42),
    }
}

#[test]
fn session_owns_source_audio_game_and_rejects_stale_documents() {
    let mut owner = CaptureOwner::new();
    let first = owner.select(1, binding()).unwrap();
    assert_eq!(owner.binding(first, 1), Some(&binding()));
    assert!(owner.binding(first, 2).is_none());
    assert!(!owner.stop(first, 2));
    assert!(owner.binding(first, 1).is_some());
    let second = owner.select(1, binding()).unwrap();
    assert_ne!(first, second);
    assert!(!owner.stop(first, 1));
    assert!(owner.binding(second, 1).is_some());
    owner.invalidate_document();
    assert!(owner.binding(second, 1).is_none());
    assert!(
        owner.select(1, binding()).is_err(),
        "reloaded document cannot reuse its generation"
    );
    assert!(owner.select(2, binding()).is_ok());
}

#[test]
fn stop_end_and_failure_are_idempotent_and_release_metadata() {
    let mut owner = CaptureOwner::new();
    let lease = owner.select(1, binding()).unwrap();
    assert!(owner.stop(lease, 1));
    assert!(!owner.stop(lease, 1));
    assert!(owner.binding(lease, 1).is_none());
    let lease = owner.select(1, binding()).unwrap();
    assert!(owner.end_from_native(lease));
    assert!(!owner.end_from_native(lease));
    assert!(owner.binding(lease, 1).is_none());
}

#[test]
fn invalid_or_inconsistent_source_metadata_fails_closed() {
    let mut owner = CaptureOwner::new();
    for invalid in [
        Binding {
            source: Source::Window { hwnd: 0, pid: 42 },
            ..binding()
        },
        Binding {
            source: Source::Window { hwnd: 1, pid: 0 },
            ..binding()
        },
        Binding {
            audio: AudioIntent::IncludeProcess(0),
            ..binding()
        },
        Binding {
            game_pid: Some(0),
            ..binding()
        },
    ] {
        assert!(owner.select(1, invalid).is_err());
    }
    assert!(owner.select(0, binding()).is_err());
}

#[test]
fn candidate_transport_is_bounded_and_never_reuses_a_reading_slot() {
    assert!(FrameBudget::new(0, 1080, 60).is_err());
    assert!(FrameBudget::new(u32::MAX, u32::MAX, 60).is_err());
    assert!(FrameBudget::new(1920, 1080, 0).is_err());
    assert!(FrameBudget::new(1920, 1080, 61).is_err());
    let mut budget = FrameBudget::new(1920, 1080, 60).unwrap();
    assert_eq!(budget.max_bytes(), 1920 * 1080 * 4 * 2);
    let a = budget.reserve().unwrap();
    let b = budget.reserve().unwrap();
    assert_ne!(a, b);
    assert!(
        budget.reserve().is_none(),
        "drop incoming frame under backpressure"
    );
    assert!(budget.acknowledge(a));
    assert!(!budget.acknowledge(a));
    let next = budget.reserve().unwrap();
    assert_eq!(next.slot(), a.slot());
    assert_ne!(next, a);
    assert!(
        !budget.acknowledge(a),
        "a stale ACK cannot release a newer frame"
    );
    assert!(budget.reserve().is_none());
    assert!(budget.acknowledge(b));
}
