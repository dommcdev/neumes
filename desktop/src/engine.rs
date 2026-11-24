//! The shared core (`src/core`) and Exsurge, running in QuickJS. All musical
//! parsing, chord edits, layout and serialization happen there, exactly as in
//! the browser; this side only passes JSON across.

use rquickjs::{CatchResultExt, Context, Function, Runtime};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

const EXSURGE: &str = include_str!("../../public/vendor/exsurge.js");
const ENGINE: &str = include_str!(concat!(env!("OUT_DIR"), "/engine.js"));
const PRELUDE: &str = r#"
globalThis.structuredClone ??= value => JSON.parse(JSON.stringify(value));
globalThis.__call = (method, args) => {
  const result = globalThis.neumes[method](...JSON.parse(args));
  return JSON.stringify(result === undefined ? null : result);
};
"#;

/// Margin around each staff image for ink outside Exsurge's box (`BLEED` in engine.ts).
pub const BLEED: f32 = 12.0;

pub struct Engine {
    _runtime: Runtime,
    context: Context,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Opened {
    pub header: String,
    #[serde(rename = "headerHeight")]
    pub header_height: f32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
pub struct View {
    /// `gabc`, or `ly` for LilyPond, whose staves are pages.
    pub kind: String,
    /// Width of the staves (or pages) in points.
    pub width: f32,
    pub dirty: bool,
    #[serde(rename = "canUndo")]
    pub can_undo: bool,
    #[serde(rename = "canRedo")]
    pub can_redo: bool,
    pub editing: bool,
    pub cursor: Cursor,
    pub selected: Option<Selected>,
    pub staves: Vec<Staff>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Default)]
pub struct Cursor {
    pub staff: usize,
    pub x: f32,
    pub y: f32,
    #[serde(rename = "noteY")]
    pub note_y: f32,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Selected {
    pub staff: usize,
    pub x: f32,
    pub top: f32,
    pub bottom: f32,
    pub width: f32,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Staff {
    /// Height including the room above for raised chords.
    pub height: f32,
    /// Space below, to the next staff.
    pub gap: f32,
    pub pad: f32,
    /// Changes whenever the staff's image does.
    pub key: String,
    /// For LilyPond pages, changes whenever the page's chord image (`chord_svg`) does.
    pub chords: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct KeyResult {
    pub handled: bool,
    pub reveal: bool,
}

impl Engine {
    pub fn new() -> Result<Engine, String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_memory_limit(512 << 20);
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        context.with(|ctx| -> Result<(), String> {
            let measure = Function::new(ctx.clone(), |font: String, text: String| {
                let m = crate::fonts::measure(&font, &text);
                vec![m.width, m.left, m.ascent, m.descent]
            })
            .map_err(|e| e.to_string())?;
            ctx.globals()
                .set("nativeMeasure", measure)
                .map_err(|e| e.to_string())?;
            for (name, source) in [
                ("prelude", PRELUDE),
                ("exsurge.js", EXSURGE),
                ("engine.js", ENGINE),
            ] {
                ctx.eval::<(), _>(source)
                    .catch(&ctx)
                    .map_err(|e| format!("{name}: {e}"))?;
            }
            Ok(())
        })?;
        Ok(Engine {
            _runtime: runtime,
            context,
        })
    }

    /// Calls `neumes[method](...args)` in the engine. Errors are the thrown message.
    pub fn call<T: DeserializeOwned>(&self, method: &str, args: Value) -> Result<T, String> {
        let args = serde_json::to_string(&args).map_err(|e| e.to_string())?;
        let out: String = self.context.with(|ctx| {
            let call: Function = ctx.globals().get("__call").map_err(|e| e.to_string())?;
            call.call::<_, String>((method, args))
                .catch(&ctx)
                .map_err(|e| match e {
                    rquickjs::CaughtError::Exception(e) => {
                        e.message().unwrap_or_else(|| e.to_string())
                    }
                    other => other.to_string(),
                })
        })?;
        serde_json::from_str(&out).map_err(|e| format!("{method}: {e}"))
    }

    pub fn open(&self, source: &str) -> Result<Opened, String> {
        self.call("open", json!([source]))
    }
    pub fn view(&self) -> Result<View, String> {
        self.call("view", json!([]))
    }
    pub fn staff_svg(&self, index: usize) -> Result<String, String> {
        self.call("staffSvg", json!([index]))
    }
    pub fn chord_svg(&self, index: usize) -> Result<String, String> {
        self.call("chordSvg", json!([index]))
    }
    pub fn lily_music(&self, source: &str) -> Result<String, String> {
        self.call("lilyMusic", json!([source]))
    }
    pub fn open_lily(&self, source: &str, name: &str, engraved: &crate::lily::Engraved) -> Result<Opened, String> {
        self.call("openLily", json!([source, name, engraved.geometry, engraved.file, engraved.display]))
    }
    pub fn serialize(&self) -> Result<String, String> {
        self.call("serialize", json!([]))
    }
    pub fn pages(&self) -> Result<Vec<String>, String> {
        self.call("pages", json!([]))
    }

    /// Runs a command with no result (`undo`, `finish`, …).
    pub fn run(&self, method: &str, args: Value) -> Result<(), String> {
        self.call::<Value>(method, args).map(|_| ())
    }

    pub fn key(&self, key: &str, ctrl: bool, shift: bool, alt: bool) -> Result<KeyResult, String> {
        self.call(
            "key",
            json!([{ "key": key, "ctrl": ctrl, "shift": shift, "alt": alt }]),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCORE: &str = include_str!("../../tests/fixtures/salve-regina.gabc");

    #[test]
    fn opens_edits_and_saves_through_the_shared_core() {
        let engine = Engine::new().unwrap();
        engine.open(SCORE).unwrap();
        // Unchanged open/save is byte-for-byte identical.
        assert_eq!(engine.serialize().unwrap(), SCORE);
        let view = engine.view().unwrap();
        assert!(!view.dirty && view.staves.len() > 3, "{view:?}");
        assert!(engine.staff_svg(0).unwrap().starts_with("<svg"));

        for key in ["A", "m"] {
            assert!(engine.key(key, false, false, false).unwrap().handled);
        }
        engine.key("Enter", false, false, false).unwrap();
        let view = engine.view().unwrap();
        assert!(
            view.dirty && view.can_undo && view.selected.is_some(),
            "{view:?}"
        );
        let saved = engine.serialize().unwrap();
        assert!(saved.contains("Am") && saved.len() > SCORE.len());

        engine.run("undo", json!([])).unwrap();
        assert_eq!(engine.serialize().unwrap(), SCORE);
        let pages = engine.pages().unwrap();
        assert!(!pages.is_empty());
        let pdf = crate::raster::pdf(&pages).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
    }

    #[test]
    fn edits_lilypond_scores_without_engraving_again() {
        if !crate::lily::tests::available() {
            eprintln!("skipped: LilyPond is not installed");
            return;
        }
        let source = "\\version \"2.24.0\"\n\\header { title = \"Test\" }\n\\relative c' { d4 e^\"Am\" <f a>2 \\repeat unfold 2 { g4 } }\n";
        let engine = Engine::new().unwrap();
        let music = engine.lily_music(source).unwrap();
        assert!(!music.contains("Am"));
        let engraved = crate::lily::engrave(&music, None).unwrap();
        engine.open_lily(source, "test.ly", &engraved).unwrap();
        assert_eq!(engine.serialize().unwrap(), source);
        let view = engine.view().unwrap();
        assert_eq!((view.kind.as_str(), view.staves.len(), view.dirty), ("ly", 1, false));
        assert!(view.staves[0].chords.contains("Am"));
        assert!(engine.staff_svg(0).unwrap().contains("<svg"));

        // The <f a> chord is one target: type a chord on it.
        for key in ["Tab", "Tab", "G", "7", "Enter"] {
            engine.key(key, false, false, false).unwrap();
        }
        let view = engine.view().unwrap();
        assert!(view.dirty && view.staves[0].chords.contains("G7"));
        assert!(engine.chord_svg(0).unwrap().contains("G7"));
        let saved = engine.serialize().unwrap();
        assert!(saved.contains("<f a>2^\\markup \\bold \"G7\""), "{saved}");
        assert_eq!(engine.lily_music(&saved).unwrap(), music);
        engine.run("saved", json!([saved])).unwrap();
        assert!(!engine.view().unwrap().dirty);
        assert!(crate::lily::pdf(&saved, None).unwrap().starts_with(b"%PDF"));
    }

    #[test]
    fn reports_bad_scores() {
        let engine = Engine::new().unwrap();
        let error = engine.open("name: x;\n(c4) a(g)").unwrap_err();
        assert!(error.contains("%%"), "{error}");
    }
}
