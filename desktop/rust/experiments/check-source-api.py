"""Reproduce the documented ScreenCaptureStarting source-selection incompatibility.

Uses a disposable crate, the locked dependencies, and Windows cargo check (no linker).
This is an API-surface experiment, NOT a capture or Windows runtime test.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="nimbo-source-api-", dir=os.environ.get("TMPDIR")) as directory:
    scratch = Path(directory)
    for name in ["Cargo.toml", "Cargo.lock"]:
        shutil.copy2(root / name, scratch / name)
    (scratch / "src").mkdir()
    source = scratch / "src/main.rs"
    prelude = """#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ScreenCaptureStartingEventArgs;
#[cfg(windows)]
#[allow(dead_code)]
unsafe fn api_probe(args: &ICoreWebView2ScreenCaptureStartingEventArgs) -> windows::core::Result<()> {
    unsafe { BODY }
}
fn main() {}
"""
    command = ["cargo", "+1.99.1", "check", "--offline", "--locked", "--target", "x86_64-pc-windows-msvc", "--manifest-path", str(scratch / "Cargo.toml"), "--message-format=json"]
    # Reuse compiled dependency metadata without writing generated files into tracked source.
    environment = {**os.environ, "CARGO_TARGET_DIR": str(root / "target/source-api-experiment")}
    outputs = {}
    for name, body in [("supported_cancel", "args.SetCancel(true)"), ("unsupported_source", "args.SetSelectedSource(1)")]:
        source.write_text(prelude.replace("BODY", body), encoding="utf-8")
        result = subprocess.run(command, text=True, capture_output=True, env=environment, check=False)
        diagnostics = []
        for line in result.stdout.splitlines():
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("reason") == "compiler-message":
                diagnostics.append(message["message"])
        outputs[name] = {"exit": result.returncode, "diagnostics": diagnostics, "stderr": result.stderr}
    print(json.dumps(outputs, indent=2))
    assert outputs["supported_cancel"]["exit"] == 0, "positive control must typecheck first"
    assert outputs["unsupported_source"]["exit"] != 0
    assert any(d.get("code", {}).get("code") == "E0599" and "SetSelectedSource" in d["message"] for d in outputs["unsupported_source"]["diagnostics"]), "must fail for missing method, not builder/dependency failure"
    print("SOURCE_API_EXPERIMENT_CONFIRMED: Cancel typechecks; hypothetical SetSelectedSource does not exist. This proves no such setter in pinned bindings, not impossibility of an injected adapter.")
