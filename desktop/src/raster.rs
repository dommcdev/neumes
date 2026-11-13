//! SVG to pixels (staff images, the logo) and SVG pages to PDF.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use resvg::{tiny_skia, usvg};

fn options() -> usvg::Options<'static> {
    let mut options = usvg::Options {
        fontdb: crate::fonts::database(),
        ..usvg::Options::default()
    };
    // Lyric markup is untrusted: never read files or URLs named by the score.
    options.image_href_resolver = usvg::ImageHrefResolver {
        resolve_data: Box::new(|_, _, _| None),
        resolve_string: Box::new(|_, _| None),
    };
    options
}

pub fn parse(svg: &str) -> Result<usvg::Tree, String> {
    usvg::Tree::from_str(svg, &options()).map_err(|e| e.to_string())
}

/// Straight-alpha sRGB RGBA at `scale` pixels per SVG unit. `dark` draws ink light, as the
/// web app's `invert(1) brightness(.9)` filter does.
pub fn rasterize(svg: &str, scale: f32, dark: bool) -> Result<(u32, u32, Vec<u8>), String> {
    let tree = parse(svg)?;
    let size = tree.size();
    let (w, h) = (
        (size.width() * scale).ceil().max(1.0) as u32,
        (size.height() * scale).ceil().max(1.0) as u32,
    );
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or("image too large")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for pixel in pixmap.pixels() {
        let c = pixel.demultiply();
        let ink = |v: u8| {
            if dark {
                ((255 - v) as f32 * 0.9).round() as u8
            } else {
                v
            }
        };
        rgba.extend_from_slice(&[ink(c.red()), ink(c.green()), ink(c.blue()), c.alpha()]);
    }
    Ok((w, h, rgba))
}

/// Draws into `pixels` off the UI thread; a newer request for the same pixels wins.
pub fn rasterize_into(
    pixels: &rune::Pixels,
    generation: &Arc<AtomicU64>,
    svg: String,
    scale: f32,
    dark: bool,
) {
    let id = generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (pixels, generation) = (pixels.clone(), generation.clone());
    std::thread::spawn(move || {
        if generation.load(Ordering::SeqCst) != id {
            return;
        }
        match rasterize(&svg, scale, dark) {
            Ok((w, h, rgba)) if generation.load(Ordering::SeqCst) == id => pixels.set(w, h, rgba),
            Ok(_) => {}
            Err(e) => eprintln!("neumes: could not draw a staff: {e}"),
        }
    });
}

/// One PDF page per SVG page (sizes in points).
pub fn pdf(pages: &[String]) -> Result<Vec<u8>, String> {
    use krilla::geom::Size;
    use krilla::page::PageSettings;
    use krilla_svg::{SurfaceExt, SvgSettings};
    let mut document = krilla::Document::new();
    for svg in pages {
        let tree = parse(svg)?;
        let size = tree.size();
        let mut page = document.start_page_with(
            PageSettings::from_wh(size.width(), size.height()).ok_or("bad page size")?,
        );
        let mut surface = page.surface();
        surface.draw_svg(
            &tree,
            Size::from_wh(size.width(), size.height()).ok_or("bad page size")?,
            SvgSettings::default(),
        );
        surface.finish();
        page.finish();
    }
    document.finish().map_err(|e| format!("{e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_text_with_the_bundled_fonts() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text x="2" y="15" font-family="TeX Gyre Pagella" font-weight="bold" font-size="12">Am♯</text></svg>"#;
        let (w, h, rgba) = rasterize(svg, 2.0, false).unwrap();
        assert_eq!((w, h), (80, 40));
        assert!(rgba.chunks(4).any(|p| p[3] > 200 && p[0] < 50), "ink");
        let (_, _, dark) = rasterize(svg, 2.0, true).unwrap();
        assert!(
            dark.chunks(4).any(|p| p[3] > 200 && p[0] > 200),
            "light ink when dark"
        );
    }

    #[test]
    fn ignores_external_images() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image href="/etc/hostname" width="10" height="10"/></svg>"#;
        let (_, _, rgba) = rasterize(svg, 1.0, false).unwrap();
        assert!(rgba.chunks(4).all(|p| p[3] == 0));
    }
}
