//! Runs the local LilyPond, as `src/lily.ts` does for the CLI. It engraves a
//! score once when it opens; chord edits are drawn over that engraving and never
//! wait for LilyPond. Exporting runs it again on the saved text.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

/// Point-and-click links for noteheads and syllables (`readGeometry` in `src/core/lilypond.ts`).
const GEOMETRY_ARGS: &[&str] = &[
    "-dbackend=svg",
    "-dpoint-and-click=(note-event lyric-event)",
];
/// Text as outlines, so pages draw the same without LilyPond's fonts.
const DISPLAY_ARGS: &[&str] = &["-dbackend=cairo", "--svg", "-dno-point-and-click"];

pub struct Engraved {
    pub geometry: Vec<String>,
    pub display: Vec<String>,
    /// The path LilyPond's links name.
    pub file: String,
}

fn lilypond() -> String {
    std::env::var("LILYPOND").unwrap_or_else(|_| "lilypond".into())
}

/// A private folder holding `score.ly`, removed when dropped.
struct Scratch {
    dir: PathBuf,
    file: PathBuf,
}

impl Scratch {
    fn new(source: &str) -> Result<Scratch, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "neumes-ly-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dir = dir.canonicalize().map_err(|e| e.to_string())?;
        let file = dir.join("score.ly");
        std::fs::write(&file, source).map_err(|e| e.to_string())?;
        Ok(Scratch { dir, file })
    }

    fn start(&self, args: &[&str], stem: &str, include: Option<&Path>) -> Result<Child, String> {
        let mut command = Command::new(lilypond());
        command
            .current_dir(&self.dir)
            .args(["-l", "ERROR"])
            .args(args);
        if let Some(dir) = include {
            command.arg("-I").arg(dir);
        }
        command
            .arg("-o")
            .arg(stem)
            .arg(&self.file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => {
                    "LilyPond is not installed. Install it, or set LILYPOND to its path."
                        .to_string()
                }
                _ => format!("Could not run LilyPond: {e}"),
            })
    }

    /// Files LilyPond wrote as `<stem>.<ext>` or `<stem>-1.<ext>`, `<stem>-2.<ext>`, … in page order.
    fn outputs(&self, stem: &str, ext: &str) -> Result<Vec<PathBuf>, String> {
        let mut found: Vec<(u32, PathBuf)> = std::fs::read_dir(&self.dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter_map(|path| {
                let name = path.file_name()?.to_str()?.to_owned();
                let rest = name
                    .strip_prefix(stem)?
                    .strip_suffix(&format!(".{ext}"))?
                    .to_owned();
                let page = if rest.is_empty() {
                    0
                } else {
                    rest.strip_prefix('-')?.parse().ok()?
                };
                Some((page, path))
            })
            .collect();
        found.sort();
        if found.is_empty() {
            return Err("LilyPond produced no output.".into());
        }
        Ok(found.into_iter().map(|(_, path)| path).collect())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn finish(child: Child) -> Result<(), String> {
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lines: Vec<&str> = stderr.trim().lines().collect();
    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
    Err(format!(
        "LilyPond failed: {}",
        if tail.is_empty() {
            "unknown error"
        } else {
            &tail
        }
    ))
}

fn read_all(paths: Vec<PathBuf>) -> Result<Vec<String>, String> {
    paths
        .iter()
        .map(|p| std::fs::read_to_string(p).map_err(|e| e.to_string()))
        .collect()
}

/// Engraves `music` for the editor; `include` is the score's folder, for its `\include`s.
pub fn engrave(music: &str, include: Option<&Path>) -> Result<Engraved, String> {
    let scratch = Scratch::new(music)?;
    let geometry = scratch.start(GEOMETRY_ARGS, "geometry", include)?;
    let display = scratch.start(DISPLAY_ARGS, "display", include);
    let results = (finish(geometry), display.and_then(finish));
    results.0?;
    results.1?;
    Ok(Engraved {
        geometry: read_all(scratch.outputs("geometry", "svg")?)?,
        display: read_all(scratch.outputs("display", "svg")?)?,
        file: scratch.file.to_string_lossy().into_owned(),
    })
}

/// The finished score as LilyPond prints it.
pub fn pdf(source: &str, include: Option<&Path>) -> Result<Vec<u8>, String> {
    let scratch = Scratch::new(source)?;
    finish(scratch.start(&["-dno-point-and-click"], "out", include)?)?;
    let first = scratch.outputs("out", "pdf")?.remove(0);
    std::fs::read(first).map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn available() -> bool {
        Command::new(lilypond())
            .arg("--version")
            .stdout(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    #[test]
    fn engraves_pages_with_links() {
        if !available() {
            eprintln!("skipped: LilyPond is not installed");
            return;
        }
        let engraved = engrave("{ c'4 d' e' f' }", None).unwrap();
        assert_eq!(engraved.geometry.len(), 1);
        assert_eq!(engraved.display.len(), 1);
        assert!(engraved.geometry[0].contains(&format!("textedit://{}", engraved.file)));
        assert!(pdf("{ c'4^\"Am\" }", None).unwrap().starts_with(b"%PDF"));
        let error = engrave("{ c'4 ", None).err().unwrap();
        assert!(error.contains("LilyPond failed"), "{error}");
    }
}
