//! Bundles the shared TypeScript core for QuickJS with Bun.

use std::path::PathBuf;
use std::process::Command;

fn main() {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("..");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("engine.js");
    for path in [
        "src/core",
        "src/desktop",
        "public/vendor/exsurge.js",
        "public/fonts",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
    let bun = std::env::var("BUN").unwrap_or_else(|_| "bun".into());
    let status = Command::new(&bun)
        .current_dir(&root)
        .args([
            "build",
            "src/desktop/engine.ts",
            "--format=iife",
            "--target=browser",
            "--outfile",
        ])
        .arg(&out)
        .status()
        .unwrap_or_else(|e| panic!("could not run `{bun} build` (install Bun, or set BUN): {e}"));
    assert!(status.success(), "bun build src/desktop/engine.ts failed");
}
