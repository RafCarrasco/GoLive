# Nimbo checkpoint-2 native policy / Windows API probe

Status: RETURN — partial local feasibility groundwork, not a desktop migration or capture-capable application. This crate intentionally refuses remote navigation. It records the intended hosted release URL, Nimbo identity and window geometry; it does not open a GUI. No installer/updater or packaging script is replaced. See RESEARCH.md for the precise supported API investigation and missing native media path.

## Portable checks

Rust 1.99.1, rustfmt and clippy are pinned by rust-toolchain.toml. Run from the repository root:

    cargo +1.99.1 test --manifest-path desktop/rust/Cargo.toml --locked
    cargo +1.99.1 fmt --manifest-path desktop/rust/Cargo.toml --all -- --check
    cargo +1.99.1 clippy --manifest-path desktop/rust/Cargo.toml --locked --all-targets -- -D warnings
    cargo +1.99.1 check --manifest-path desktop/rust/Cargo.toml --locked --all-targets
    cargo +1.99.1 run --manifest-path desktop/rust/Cargo.toml --locked

The diagnostic executable intentionally exits 2 (RETURN); that is not a media test failure or success. Portable tests exercise origin/navigation, permissions/native-frame/window/generation policy, metadata ownership/replacement/cancel/native-end/reload and bounded frame-credit bookkeeping. No test claims to capture a screen. There is deliberately no ignored "hardware test" that could report success without a capture implementation.

For this coordinator's Linux environment only, the isolated profile HOME differs from the provisioned Rust home. Prefix commands with RUSTUP_HOME=/opt/data/home/.rustup CARGO_HOME=/opt/data/home/.cargo and add /opt/data/home/.cargo/bin to PATH. No global rustup/profile change is needed. Use the Node22 directory in /opt/data/cache/scratch/nimbo-community-node22-bin.txt for the unchanged Node suite/build.

## Windows source checks vs a real builder

Installed target libraries allow the following Linux metadata checks; they do NOT link an .exe or run COM/GUI/media:

    cargo +1.99.1 check --manifest-path desktop/rust/Cargo.toml --locked --all-targets --target x86_64-pc-windows-msvc
    cargo +1.99.1 clippy --manifest-path desktop/rust/Cargo.toml --locked --all-targets --target x86_64-pc-windows-msvc -- -D warnings
    python3 desktop/rust/experiments/check-source-api.py

The experiment requires Python 3, that Rust target, cached locked dependencies (`cargo fetch --locked --manifest-path desktop/rust/Cargo.toml --target x86_64-pc-windows-msvc` if necessary), and an isolated TMPDIR. It checks positive/negative API compilation only, emitting exact compiler JSON. It never accesses production.

A real Windows x64 builder needs Rust 1.99.1 with x86_64-pc-windows-msvc, Visual Studio C++ Build Tools/MSVC linker and Windows SDK libraries, plus installed WebView2 Evergreen for the diagnostic runtime. Use an x64 Developer PowerShell/command prompt. Do not install or replace a production Nimbo application:

    rustup toolchain install 1.99.1 --profile minimal --component rustfmt --component clippy
    cargo +1.99.1 test --manifest-path desktop/rust/Cargo.toml --locked
    cargo +1.99.1 check --manifest-path desktop/rust/Cargo.toml --locked --all-targets
    cargo +1.99.1 clippy --manifest-path desktop/rust/Cargo.toml --locked --all-targets -- -D warnings
    cargo +1.99.1 build --manifest-path desktop/rust/Cargo.toml --locked --release --target x86_64-pc-windows-msvc
    .\desktop\rust\target\x86_64-pc-windows-msvc\release\nimbo-desktop.exe

Expected diagnostic behavior (not an observed Windows result): print installed WebView2 version if the loader succeeds, print configured hosted URL, refuse startup with RETURN and exit 2. Missing runtime/Win32 API failure exits 1. No login, production site, live updater, device capture or shell launch occurs. The current Linux link attempt failed because link.exe was absent; no Windows executable was produced. Do not ask a user to validate native capture using this diagnostic binary.

## Commit-bound evidence checklist

Before recording ANY Windows result, include `git rev-parse HEAD`, `git status --short`, `rustc +1.99.1 --version`, Windows edition/build, architecture, WebView2 runtime, builder tool/SDK versions, exact command, exit status and output. Record artifact SHA-256 and bytes; size is informational. No push, workflow dispatch, release or deploy is authorized by these instructions. No new workflow exists.

Current artifact checklist, all Windows items pending:

- [ ] Windows link/tests/clippy and diagnostic runtime output at the recorded commit.
- [ ] Real host integration: create a blank WebView, install DenyGuards before navigation, missing-interface/registration/deny-failure rollback and controller closure. Current guard library code is only cross-typechecked.
- [ ] Subsequent bounded checkpoint-2 implementation of actual WGC frames, validated source selection, read-only shared-buffer credits and desktop-injected real MediaStream. Not implemented here; no invocation instructions can honestly run it yet.
- [ ] Unchanged branch source in isolated emulator mode publishes that REAL track to an independent browser; remote hosted release configuration stays unchanged. No fakeMedia=1/native-evidence substitution.
- [ ] Choose two distinct windows/monitors and observe the chosen source, constraints at 720/1080 and 30/60 fps, timestamps/receiver dimensions/frame counts/latency and camera independence. No inferred success from a local preview.
- [ ] Cancel/reselect; stop/native-ended/close/reload/navigation; stale session/ACK; clone/lifetime cleanup and bounded resources after repeated cycles.
- [ ] Denied foreign/same-origin iframe, opaque/unknown frame, forged native command/source/generation and unsupported interface paths, observed in the actual native host.
- [ ] Source/audio-intent/game PID binding retained for later ports; no claim of implemented app audio or game focus privacy yet. Full app-only/no-Nimbo audio, Alt+Tab/game exit, picker parity, installer/updater and session persistence are still mandatory later gates.

Only real Windows capture evidence can close checkpoint 2. Portable passing tests, a source check, an installed runtime or a linked artifact cannot. Stop here; do not implement checkpoints 3–8 under this approval.
