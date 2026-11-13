//! The engraving fonts the web app serves from `public/fonts`, built in, and text
//! measurement that answers as a browser canvas's `measureText` does.

use std::sync::{Arc, OnceLock};

use resvg::usvg::fontdb;

pub const PAGELLA: [&[u8]; 4] = [
    include_bytes!("../../public/fonts/texgyrepagella-regular.otf"),
    include_bytes!("../../public/fonts/texgyrepagella-bold.otf"),
    include_bytes!("../../public/fonts/texgyrepagella-italic.otf"),
    include_bytes!("../../public/fonts/texgyrepagella-bolditalic.otf"),
];
pub const GARAMOND: [&[u8]; 2] = [
    include_bytes!("../../public/fonts/EBGaramond.ttf"),
    include_bytes!("../../public/fonts/EBGaramond-Italic.ttf"),
];

/// Fonts for SVG text: only the bundled ones, so staves look the same on every machine.
pub fn database() -> Arc<fontdb::Database> {
    static DB: OnceLock<Arc<fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = fontdb::Database::new();
        for data in PAGELLA.iter().chain(&GARAMOND) {
            db.load_font_data(data.to_vec());
        }
        db.set_serif_family("TeX Gyre Pagella");
        db.set_sans_serif_family("TeX Gyre Pagella");
        Arc::new(db)
    })
    .clone()
}

/// What `CanvasRenderingContext2D.measureText` reports, in CSS pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Metrics {
    pub width: f64,
    pub left: f64,
    pub ascent: f64,
    pub descent: f64,
}

struct Font {
    italic: bool,
    bold: bool,
    face: rustybuzz::Face<'static>,
}

fn faces() -> &'static [(Family, Vec<Font>)] {
    static FACES: OnceLock<Vec<(Family, Vec<Font>)>> = OnceLock::new();
    FACES.get_or_init(|| {
        let face =
            |data: &'static [u8]| rustybuzz::Face::from_slice(data, 0).expect("bundled font");
        let pagella = PAGELLA
            .iter()
            .enumerate()
            .map(|(i, data)| Font {
                bold: i % 2 == 1,
                italic: i >= 2,
                face: face(data),
            })
            .collect();
        // EB Garamond is variable: bold is its 700 instance.
        let mut garamond = Vec::new();
        for (italic, data) in [(false, GARAMOND[0]), (true, GARAMOND[1])] {
            for bold in [false, true] {
                let mut f = face(data);
                f.set_variations(&[rustybuzz::Variation {
                    tag: rustybuzz::ttf_parser::Tag::from_bytes(b"wght"),
                    value: if bold { 700.0 } else { 400.0 },
                }]);
                garamond.push(Font {
                    bold,
                    italic,
                    face: f,
                });
            }
        }
        vec![(Family::Pagella, pagella), (Family::Garamond, garamond)]
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Family {
    Pagella,
    Garamond,
}

/// A CSS font shorthand as Exsurge and the core write them:
/// `[italic] [small-caps] [bold] <size>px <family>[, fallback]`.
fn parse(font: &str) -> (bool, bool, f64, Family) {
    let (mut italic, mut bold, mut size) = (false, false, 10.0);
    let mut rest = font;
    while let Some((word, tail)) = rest.trim_start().split_once(' ') {
        match word {
            "italic" | "oblique" => italic = true,
            "bold" | "700" | "800" | "900" => bold = true,
            "normal" | "small-caps" | "400" => {}
            px if px.ends_with("px") => {
                size = px.trim_end_matches("px").parse().unwrap_or(size);
                rest = tail;
                break;
            }
            _ => break,
        }
        rest = tail;
    }
    let first = rest
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(['"', '\'']);
    let family = if first.eq_ignore_ascii_case("EB Garamond") {
        Family::Garamond
    } else {
        Family::Pagella
    };
    (italic, bold, size, family)
}

/// Shapes `text` with kerning and default features, as Chromium's canvas does with
/// `textRendering = geometricPrecision` (unrounded advances).
pub fn measure(font: &str, text: &str) -> Metrics {
    let (italic, bold, size, family) = parse(font);
    let fonts = &faces().iter().find(|(f, _)| *f == family).unwrap().1;
    let font = fonts
        .iter()
        .find(|f| f.italic == italic && f.bold == bold)
        .unwrap_or(&fonts[0]);
    let face = &font.face;
    let scale = size / face.units_per_em() as f64;
    let mut buffer = rustybuzz::UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.set_direction(rustybuzz::Direction::LeftToRight);
    let shaped = rustybuzz::shape(face, &[], buffer);
    let (mut pen, mut min_x, mut max_y, mut min_y) =
        (0.0f64, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY);
    for (info, pos) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
        let glyph = rustybuzz::ttf_parser::GlyphId(info.glyph_id as u16);
        if let Some(b) = face.glyph_bounding_box(glyph) {
            let x = pen + pos.x_offset as f64;
            let y = pos.y_offset as f64;
            min_x = min_x.min(x + b.x_min as f64);
            max_y = max_y.max(y + b.y_max as f64);
            min_y = min_y.min(y + b.y_min as f64);
        }
        pen += pos.x_advance as f64;
    }
    if !min_x.is_finite() {
        return Metrics {
            width: pen * scale,
            ..Metrics::default()
        };
    }
    Metrics {
        width: pen * scale,
        left: -min_x * scale,
        ascent: max_y * scale,
        descent: -min_y * scale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exsurge_and_core_fonts() {
        assert_eq!(
            parse("bold 9px \"TeX Gyre Pagella\", serif"),
            (false, true, 9.0, Family::Pagella)
        );
        assert_eq!(
            parse("italic bold 19.92px \"EB Garamond\", serif"),
            (true, true, 19.92, Family::Garamond)
        );
        assert_eq!(parse("53.8px \"EB Garamond\", serif").3, Family::Garamond);
    }

    #[test]
    fn measures_like_a_canvas() {
        // Widths from the CLI's Skia canvas (@napi-rs/canvas), which rounds ink bounds to pixels.
        let skia = [
            ("bold 9px \"TeX Gyre Pagella\", serif", "Am", 15.0, 7.0),
            ("bold 9px \"TeX Gyre Pagella\", serif", "F♯m7", 22.55, 7.0),
            ("19.92px \"TeX Gyre Pagella\", serif", "Sal-", 32.83, 15.0),
            ("19.92px \"TeX Gyre Pagella\", serif", "AVe", 34.81, 14.0),
            ("53.8px \"EB Garamond\", serif", "S", 25.02, 36.0),
            ("italic 19.92px \"TeX Gyre Pagella\", serif", "gloria", 45.74, 15.0),
        ];
        for (font, text, width, ascent) in skia {
            let m = measure(font, text);
            assert!((m.width - width).abs() < 0.05, "{text}: {m:?}");
            assert!((m.ascent - ascent).abs() < 1.0, "{text}: {m:?}");
        }
        assert_eq!(measure("20px \"TeX Gyre Pagella\"", " ").ascent, 0.0);
    }
}
