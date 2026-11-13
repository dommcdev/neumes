//! Rasterized SVG the view draws: each staff with its chords, the sheet header and
//! the logo. The view asks for each at its current zoom, scale and theme; an image
//! is redrawn (off the UI thread) only when one of those or its content changes.

use std::cell::RefCell;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use rune::Pixels;

use crate::engine::Engine;

const LOGO: &str = include_str!("../../public/logo.svg");

#[derive(Default)]
struct Image {
    pixels: Pixels,
    generation: Arc<AtomicU64>,
    /// Content key, scale bits and theme of the last drawing.
    drawn: Option<(String, u32, bool)>,
}

impl Image {
    fn ensure(
        &mut self,
        key: &str,
        scale: f32,
        dark: bool,
        svg: impl FnOnce() -> Result<String, String>,
    ) -> Pixels {
        let wanted = (key.to_owned(), scale.to_bits(), dark);
        if self.drawn.as_ref() != Some(&wanted) {
            match svg() {
                Ok(svg) => {
                    crate::raster::rasterize_into(&self.pixels, &self.generation, svg, scale, dark)
                }
                Err(e) => eprintln!("neumes: {e}"),
            }
            self.drawn = Some(wanted);
        }
        self.pixels.clone()
    }
}

#[derive(Default)]
struct Inner {
    header: Image,
    logo: Image,
    staves: Vec<Image>,
}

#[derive(Default)]
pub struct Images {
    inner: RefCell<Inner>,
    pub header_svg: String,
}

impl Images {
    /// A new score: forget the old staves.
    pub fn reset(&mut self) {
        let inner = self.inner.get_mut();
        inner.staves.clear();
        inner.header = Image::default();
    }

    pub fn staff(
        &self,
        engine: &Engine,
        index: usize,
        key: &str,
        scale: f32,
        dark: bool,
    ) -> Pixels {
        let mut inner = self.inner.borrow_mut();
        while inner.staves.len() <= index {
            inner.staves.push(Image::default());
        }
        inner.staves[index].ensure(key, scale, dark, || engine.staff_svg(index))
    }

    pub fn header(&self, scale: f32, dark: bool) -> Pixels {
        let svg = self.header_svg.clone();
        self.inner
            .borrow_mut()
            .header
            .ensure("", scale, dark, || Ok(svg))
    }

    /// The logo at `width` points wide; its dark colours replace its light ones.
    pub fn logo(&self, scale: f32, dark: bool, width: f32) -> Pixels {
        let svg = || {
            let svg = if dark {
                LOGO.replace("#b8342a", "#e58d80")
                    .replace("#292721", "#eeece3")
            } else {
                LOGO.to_owned()
            };
            Ok(svg.replacen(
                "<svg ",
                &format!(
                    r#"<svg width="{width}" height="{}" "#,
                    width * 621.0 / 2419.0
                ),
                1,
            ))
        };
        // Its own colours: never inverted.
        self.inner
            .borrow_mut()
            .logo
            .ensure(if dark { "dark" } else { "light" }, scale, false, svg)
    }
}
