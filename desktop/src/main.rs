//! Neumes on the desktop: the shared core (`src/core`, run by QuickJS) behind a
//! native Rune window. `cargo run --release` from `desktop/`, optionally with a
//! `.gabc` path to open.

mod engine;
mod fonts;
mod images;
mod palette;
mod raster;
mod view;

use std::path::{Path, PathBuf};
use std::time::Duration;

use rune::prefs::Prefs;
use rune::{AppSpec, FileDialogOptions, Key, KeyEvent, Tx};
use serde::{Deserialize, Serialize};
use serde_json::json;

use engine::Engine;

const MAX_SIZE: u64 = 4 * 1024 * 1024;
const PAPER_WIDTH: f32 = 612.0;
const DRAFT: &str = "draft";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    System,
}

/// The open score. Its content lives in the engine.
pub struct Score {
    pub path: Option<PathBuf>,
    pub name: String,
    /// What the file held when it was opened or last saved, to notice other programs' edits.
    pub disk: String,
    /// Restored from a draft and not yet written to any file.
    pub recovered: bool,
    pub header_height: f32,
    pub view: engine::View,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Then {
    Open,
    OpenPath(PathBuf),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Purpose {
    Discard(Then),
    DiskChanged,
    Recover,
    About,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Dialog {
    Question { title: String, text: String, choices: Vec<(&'static str, &'static str, Style)>, purpose: Purpose },
    Shortcuts,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Style {
    Plain,
    Primary,
    Danger,
}

#[derive(Serialize, Deserialize)]
struct Draft {
    name: String,
    source: String,
}

pub struct DragState {
    last: (f32, f32),
    fine: bool,
}

pub struct State {
    pub engine: Engine,
    pub score: Option<Score>,
    pub zoom: f32,
    /// The zoom staff images are drawn at; it follows `zoom` once zooming pauses.
    pub raster_zoom: f32,
    zoom_due: Option<f64>,
    pub theme: Theme,
    pub menu_open: bool,
    pub dialog: Option<Dialog>,
    pub toast: Option<String>,
    toast_due: f64,
    pub drop_hover: bool,
    pub window_width: f32,
    drag: Option<DragState>,
    prefs: Prefs,
    draft_due: Option<f64>,
    pub images: images::Images,
}

impl State {
    fn new() -> State {
        let engine = Engine::new().unwrap_or_else(|e| panic!("could not start the score engine: {e}"));
        // Headless runs (snapshots, scripts) never touch the real theme or draft.
        let headless = std::env::args().any(|a| matches!(a.as_str(), "--snap" | "--script" | "--tree" | "--frames" | "--video" | "--strip"));
        let prefs = if headless { Prefs::memory() } else { Prefs::open("net.dommcdev.neumes") };
        let theme = prefs.get("theme").unwrap_or(Theme::System);
        let mut s = State {
            engine, score: None, zoom: 1.5, raster_zoom: 1.5, zoom_due: None, theme, menu_open: false,
            dialog: None, toast: None, toast_due: 0.0, drop_hover: false, window_width: 1100.0, drag: None,
            prefs, draft_due: None, images: images::Images::default(),
        };
        if s.prefs.contains(DRAFT) {
            s.dialog = Some(question("Recover unsaved chords?",
                "A local draft from your previous session is available. Recover it, then use Save as to write it to a file.",
                vec![("discard", "Discard draft", Style::Plain), ("restore", "Recover", Style::Primary)], Purpose::Recover));
        }
        s
    }

    pub fn unsaved(&self) -> bool {
        self.score.as_ref().is_some_and(|s| s.view.dirty || s.recovered)
    }

    pub fn dark(&self, system_dark: bool) -> bool {
        self.theme == Theme::Dark || (self.theme == Theme::System && system_dark)
    }

    fn toast(&mut self, tx: &mut Tx, message: impl Into<String>) {
        self.toast = Some(message.into());
        self.toast_due = tx.clock() + 6.0;
        tx.wake_after(Duration::from_secs(6));
    }

    /// Reads the engine's state after an edit and schedules the draft.
    fn refresh(&mut self, tx: &mut Tx) {
        let Some(score) = self.score.as_mut() else { return };
        match self.engine.view() {
            Ok(view) => score.view = view,
            Err(e) => eprintln!("neumes: {e}"),
        }
        let title = format!("{}{} — Neumes", if self.unsaved() { "• " } else { "" }, self.score.as_ref().unwrap().name);
        tx.set_title(&title);
        self.draft_due = Some(tx.clock() + 0.3);
        tx.wake_after(Duration::from_millis(300));
    }

    fn write_draft(&mut self) {
        self.draft_due = None;
        let result = match (&self.score, self.unsaved()) {
            (Some(score), true) => match self.engine.call::<String>("serialize", json!([])) {
                Ok(source) => self.prefs.set(DRAFT, &Draft { name: score.name.clone(), source }),
                Err(_) => Ok(()),
            },
            _ => if self.prefs.contains(DRAFT) { self.prefs.remove(DRAFT) } else { Ok(()) },
        };
        if let Err(e) = result { eprintln!("neumes: could not keep a draft: {e}"); }
    }

    fn set_zoom(&mut self, tx: &mut Tx, zoom: f32) {
        self.zoom = zoom.clamp(0.3, 5.0);
        self.zoom_due = Some(tx.clock() + 0.12);
        tx.wake_after(Duration::from_millis(130));
    }

    /// Opens `source` in place of the current score, keeping the current one when it fails.
    fn load(&mut self, tx: &mut Tx, source: String, name: String, path: Option<PathBuf>) -> bool {
        if !name.to_lowercase().ends_with(".gabc") {
            self.toast(tx, "Please open a .gabc chant file.");
            return false;
        }
        let opened = self.engine.open(&source).and_then(|o| self.engine.view().map(|v| (o, v)));
        match opened {
            Ok((opened, view)) => {
                self.images.reset();
                self.score = Some(Score { path, name, disk: source, recovered: false, header_height: opened.header_height, view });
                self.images.header_svg = opened.header;
                let fit = (self.window_width - if self.window_width < 650.0 { 24.0 } else { 80.0 }) / PAPER_WIDTH;
                self.zoom = fit.min(1.6).clamp(0.3, 5.0);
                self.raster_zoom = self.zoom;
                tx.scroll_to_instant("workspace", 0.0, 0.0);
                self.refresh(tx);
                true
            }
            Err(e) => {
                self.toast(tx, format!("Could not open score: {e}"));
                false
            }
        }
    }

    fn load_path(&mut self, tx: &mut Tx, path: PathBuf) {
        let name = file_name(&path);
        match read_score(&path) {
            Ok(source) => { self.load(tx, source, name, Some(path)); }
            Err(e) => self.toast(tx, format!("Could not open score: {e}")),
        }
    }

    /// Asks before replacing unsaved changes, then does `then`.
    fn replace(&mut self, tx: &mut Tx, then: Then) {
        if self.unsaved() {
            self.dialog = Some(question("Replace this score?",
                "Opening another file will overwrite your unsaved changes. Save your chords first, or discard them to continue.",
                vec![("cancel", "Cancel", Style::Plain), ("discard", "Discard changes", Style::Danger), ("save", "Save first", Style::Primary)],
                Purpose::Discard(then)));
        } else {
            self.proceed(tx, then);
        }
    }

    fn proceed(&mut self, tx: &mut Tx, then: Then) {
        match then {
            Then::OpenPath(path) => self.load_path(tx, path),
            Then::Open => {
                let options = FileDialogOptions { title: "Open a chant".into(), ..Default::default() }.filter("Gregorian chant", &["gabc"]);
                tx.open_file(options, |s: &mut State, result, tx| match result {
                    Ok(Some(path)) => s.load_path(tx, path),
                    Ok(None) => {}
                    Err(e) => s.toast(tx, e.to_string()),
                });
            }
        }
    }

    /// Saves to the score's file (or asks where), then does `after`.
    fn save(&mut self, tx: &mut Tx, save_as: bool, after: Option<Then>) {
        let Some(score) = &self.score else { return };
        // Serializing validates every chord before asking for a file.
        let source = match self.engine.serialize() {
            Ok(source) => source,
            Err(e) => return self.toast(tx, format!("Could not save: {e}")),
        };
        match (&score.path, save_as) {
            (Some(path), false) => {
                let path = path.clone();
                match std::fs::read_to_string(&path) {
                    Ok(on_disk) if on_disk != score.disk => {
                        self.dialog = Some(question("The file changed on disk",
                            "Another program may have edited this score. Reload it to keep those edits, or save your work to a different file.",
                            vec![("cancel", "Cancel", Style::Plain), ("reload", "Reload", Style::Plain), ("copy", "Save a copy", Style::Primary)],
                            Purpose::DiskChanged));
                    }
                    // A missing file is simply written again.
                    _ => self.write(tx, path, source, after),
                }
            }
            _ => {
                let options = FileDialogOptions { title: "Save chant".into(), file_name: Some(score.name.clone()), ..Default::default() }
                    .filter("Gregorian chant", &["gabc"]);
                tx.save_file(options, move |s: &mut State, result, tx| match result {
                    Ok(Some(path)) => s.write(tx, with_extension(path, "gabc"), source.clone(), after.clone()),
                    Ok(None) => {}
                    Err(e) => s.toast(tx, format!("Could not save: {e}")),
                });
            }
        }
    }

    fn write(&mut self, tx: &mut Tx, path: PathBuf, source: String, after: Option<Then>) {
        if let Err(e) = write_atomic(&path, source.as_bytes()) {
            return self.toast(tx, format!("Could not save: {e}"));
        }
        if let Err(e) = self.engine.run("saved", json!([source])) {
            return self.toast(tx, format!("Could not save: {e}"));
        }
        if let Some(score) = self.score.as_mut() {
            score.name = file_name(&path);
            score.path = Some(path);
            score.disk = source;
            score.recovered = false;
        }
        self.refresh(tx);
        self.write_draft();
        if let Some(then) = after { self.proceed(tx, then); }
    }

    fn export_pdf(&mut self, tx: &mut Tx) {
        let Some(score) = &self.score else { return };
        let pages = match self.engine.pages() {
            Ok(pages) => pages,
            Err(e) => return self.toast(tx, format!("Could not export: {e}")),
        };
        let name = format!("{}.pdf", score.name.strip_suffix(".gabc").unwrap_or(&score.name));
        self.refresh(tx);
        let options = FileDialogOptions { title: "Export to PDF".into(), file_name: Some(name), ..Default::default() }.filter("PDF", &["pdf"]);
        tx.save_file(options, move |s: &mut State, result, tx| match result {
            Ok(Some(path)) => {
                let written = raster::pdf(&pages).and_then(|pdf| write_atomic(&with_extension(path, "pdf"), &pdf).map_err(|e| e.to_string()));
                if let Err(e) = written { s.toast(tx, format!("Could not export: {e}")); }
            }
            Ok(None) => {}
            Err(e) => s.toast(tx, format!("Could not export: {e}")),
        });
    }

    pub fn action(&mut self, tx: &mut Tx, name: &str) {
        self.menu_open = false;
        match name {
            "open" => self.replace(tx, Then::Open),
            "save" => self.save(tx, false, None),
            "save-as" => self.save(tx, true, None),
            "export-pdf" => self.export_pdf(tx),
            "shortcuts" => self.dialog = Some(Dialog::Shortcuts),
            "about" => self.dialog = Some(question("About Neumes",
                "Neumes is for adding accompaniment to Gregorian chant scores. Open a .gabc file, add chords above the notes, and save your score or export it to PDF.",
                vec![("close", "Close", Style::Plain)], Purpose::About)),
            "zoom-in" if self.score.is_some() => self.set_zoom(tx, self.zoom * 1.15),
            "zoom-out" if self.score.is_some() => self.set_zoom(tx, self.zoom / 1.15),
            "undo" | "redo" if self.score.is_some() => {
                let _ = self.engine.run(name, json!([]));
                self.refresh(tx);
            }
            _ => {}
        }
    }

    pub fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
        if let Err(e) = self.prefs.set("theme", &theme) { eprintln!("neumes: {e}"); }
    }

    pub fn answer(&mut self, tx: &mut Tx, choice: &str) {
        let Some(Dialog::Question { purpose, .. }) = self.dialog.take() else {
            self.dialog = None;
            return;
        };
        match (purpose, choice) {
            (Purpose::Discard(then), "discard") => self.proceed(tx, then),
            (Purpose::Discard(then), "save") => self.save(tx, false, Some(then)),
            (Purpose::DiskChanged, "reload") => {
                if let Some(path) = self.score.as_ref().and_then(|s| s.path.clone()) { self.load_path(tx, path); }
            }
            (Purpose::DiskChanged, "copy") => self.save(tx, true, None),
            (Purpose::Recover, "restore") => {
                let draft: Option<Draft> = self.prefs.get(DRAFT);
                if let Some(draft) = draft && self.load(tx, draft.source, draft.name, None) {
                    // Not yet written to any file: keep the draft until a save, and say it's unsaved.
                    if let Some(score) = self.score.as_mut() { score.disk.clear(); score.recovered = true; }
                    self.refresh(tx);
                }
            }
            (Purpose::Recover, "discard") => { let _ = self.prefs.remove(DRAFT); }
            _ => {}
        }
    }

    // Pointer input on a staff, in staff points from the top of its image.
    pub fn press(&mut self, tx: &mut Tx, staff: usize, x: f32, y: f32, clicks: u32, fine: bool) {
        self.menu_open = false;
        if self.score.is_none() { return; }
        let result = if clicks >= 2 {
            self.engine.run("editAt", json!([staff, x, y]))
        } else {
            self.engine.run("pointerDown", json!([staff, x, y]))
        };
        if let Err(e) = result { eprintln!("neumes: {e}"); }
        self.drag = Some(DragState { last: (0.0, 0.0), fine });
        self.refresh(tx);
    }

    pub fn drag_to(&mut self, tx: &mut Tx, staff: usize, x: f32, travel: (f32, f32)) {
        let Some(drag) = self.drag.as_mut() else { return };
        let (dx, dy) = ((travel.0 - drag.last.0) / self.zoom, (drag.last.1 - travel.1) / self.zoom);
        let distance = travel.0.hypot(travel.1);
        let moved = self.engine.call::<bool>("pointerMove", json!([staff, x, dx, dy, drag.fine, distance])).unwrap_or(false);
        if moved || distance > 3.0 { drag.last = travel; }
        if moved { self.refresh(tx); }
    }

    /// The staff under a point given relative to staff `from`, and the x there.
    pub fn staff_at(&self, from: usize, x: f32, y: f32) -> (usize, f32) {
        let Some(score) = &self.score else { return (from, x) };
        let staves = &score.view.staves;
        let (mut index, mut y) = (from, y);
        while y < 0.0 && index > 0 {
            index -= 1;
            y += staves[index].height + staves[index].gap;
        }
        while index + 1 < staves.len() && y > staves[index].height + staves[index].gap {
            y -= staves[index].height + staves[index].gap;
            index += 1;
        }
        (index, x)
    }

    pub fn release(&mut self) {
        self.drag = None;
        let _ = self.engine.run("pointerUp", json!([]));
    }

    pub fn drop_files(&mut self, tx: &mut Tx, files: &[PathBuf]) {
        self.drop_hover = false;
        if let Some(path) = files.first() { self.replace(tx, Then::OpenPath(path.clone())); }
    }

    pub fn magnify(&mut self, tx: &mut Tx, delta: f32) {
        if self.score.is_some() { self.set_zoom(tx, self.zoom * (1.0 + delta)); }
    }
}

pub fn question(title: &str, text: &str, choices: Vec<(&'static str, &'static str, Style)>, purpose: Purpose) -> Dialog {
    Dialog::Question { title: title.into(), text: text.into(), choices, purpose }
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(|| "chant.gabc".into(), |n| n.to_string_lossy().into_owned())
}

fn with_extension(path: PathBuf, extension: &str) -> PathBuf {
    let has = path.extension().is_some_and(|e| e.eq_ignore_ascii_case(extension));
    if has { path } else { let mut p = path.into_os_string(); p.push("."); p.push(extension); p.into() }
}

fn read_score(path: &Path) -> Result<String, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_SIZE { return Err("GABC files must be smaller than 4 MiB.".into()); }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Writes beside the target and renames over it, so a failed write never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let temp = dir.join(format!(".{}.{}.tmp", file_name(path), std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Ok(meta) = std::fs::metadata(path) { let _ = std::fs::set_permissions(&temp, meta.permissions()); }
        std::fs::rename(&temp, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result
}

/// The browser's name for a key (`KeyboardEvent.key`), as the shared key bindings expect.
fn dom_key(event: &KeyEvent) -> Option<String> {
    Some(match &event.key {
        Key::Text(text) => text.clone(),
        Key::Command(c) => c.to_string(),
        Key::Enter => "Enter".into(),
        Key::Backspace => "Backspace".into(),
        Key::Delete => "Delete".into(),
        Key::Left => "ArrowLeft".into(),
        Key::Right => "ArrowRight".into(),
        Key::Up => "ArrowUp".into(),
        Key::Down => "ArrowDown".into(),
        Key::Home => "Home".into(),
        Key::End => "End".into(),
        Key::PageUp => "PageUp".into(),
        Key::PageDown => "PageDown".into(),
        Key::Escape => "Escape".into(),
        Key::Tab => "Tab".into(),
        Key::Function(n) => format!("F{n}"),
        _ => return None,
    })
}

fn on_key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    let Some(key) = dom_key(event) else { return false };
    let m = event.mods;
    let (ctrl, shift, alt) = (m.cmd || m.ctrl, m.shift, m.alt);
    if let Some(dialog) = &s.dialog {
        if key == "Escape" {
            match dialog {
                Dialog::Question { .. } => s.answer(tx, "cancel"),
                Dialog::Shortcuts => s.dialog = None,
            }
            return true;
        }
        return false;
    }
    if key == "Escape" && s.menu_open {
        s.menu_open = false;
        return true;
    }
    if ctrl {
        let action = match key.to_lowercase().as_str() {
            "o" => Some("open"),
            "s" => Some(if shift { "save-as" } else { "save" }),
            "+" | "=" => Some("zoom-in"),
            "-" | "_" => Some("zoom-out"),
            _ => None,
        };
        if let Some(action) = action {
            s.action(tx, action);
            return true;
        }
    }
    if key == "F1" {
        s.dialog = Some(Dialog::Shortcuts);
        return true;
    }
    if s.score.is_none() || s.menu_open { return false; }
    if !alt && (key == "PageUp" || key == "PageDown") {
        tx.scroll_page("workspace", if key == "PageUp" { -1 } else { 1 });
        return true;
    }
    // Typed text arrives as one string; the editor takes it a character at a time.
    let keys: Vec<String> = if matches!(event.key, Key::Text(_)) { key.chars().map(String::from).collect() } else { vec![key] };
    let mut handled = false;
    let mut reveal = false;
    for key in keys {
        match s.engine.key(&key, ctrl, shift, alt) {
            Ok(r) => { handled |= r.handled; reveal |= r.reveal; }
            Err(e) => eprintln!("neumes: {e}"),
        }
    }
    if handled {
        s.refresh(tx);
        if reveal && let Some(score) = &s.score {
            tx.scroll_into_view(format!("staff-{}", score.view.cursor.staff));
        }
    }
    handled
}

fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let mut changed = false;
    if s.toast.is_some() && now >= s.toast_due {
        s.toast = None;
        changed = true;
    }
    if let Some(due) = s.zoom_due {
        if now >= due {
            s.zoom_due = None;
            s.raster_zoom = s.zoom;
            changed = true;
        } else {
            tx.wake_after(Duration::from_secs_f64(due - now));
        }
    }
    if let Some(due) = s.draft_due {
        if now >= due { s.write_draft(); } else { tx.wake_after(Duration::from_secs_f64(due - now)); }
    }
    changed
}

fn init() -> State {
    State::new()
}

fn main() {
    let spec = AppSpec {
        min_size: Some((420.0, 400.0)),
        fonts: &[
            include_bytes!("../assets/Inter-Regular.ttf"),
            include_bytes!("../assets/Inter-Medium.ttf"),
            include_bytes!("../assets/Inter-SemiBold.ttf"),
            fonts::PAGELLA[0], fonts::PAGELLA[1], fonts::PAGELLA[2], fonts::PAGELLA[3],
        ],
        families: ("Inter", "Inter"),
        poll: Some(poll),
        on_key: Some(on_key),
        ..AppSpec::new("Neumes", (1100.0, 860.0), init, view::view)
    };
    let path = std::env::args_os().skip(1).map(PathBuf::from).find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("gabc")));
    let app = rune::App::new(spec).on_close(|s: &mut State, _| s.write_draft());
    if let Some(path) = path {
        app.handle().update(move |s: &mut State, tx| s.load_path(tx, path));
    }
    app.run();
}

