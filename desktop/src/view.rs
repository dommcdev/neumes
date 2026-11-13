//! The window: the same workspace, menu and dialogs as the web app (`src/main.ts`,
//! `src/styles.css`), drawn by Rune. Staves are images of the engine's SVG.

use rune::{col, el, icon, row, spacer, text, Cursor, Cx, Drag, El, Phase, TextStyle, Tx};

use crate::engine::BLEED;
use crate::palette::{self, Palette};
use crate::{Dialog, State, Style, Theme};

const SCORE_WIDTH: f32 = 522.0;
const LOGO_RATIO: f32 = 621.0 / 2419.0;
const MAC: bool = cfg!(target_os = "macos");

fn style(size: f32, weight: f32) -> TextStyle {
    TextStyle::new(size, weight)
}

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let env = cx.env();
    let dark = s.dark(env.system_dark);
    let p = Palette::new(dark);
    let mut root = el()
        .key("root")
        .w_full()
        .h_full()
        .fill(p.background)
        .on_layout(|s: &mut State, r| {
            if s.window_width != r[2] {
                s.window_width = r[2]
            }
        })
        .on_drop_files(|s: &mut State, files, tx| s.drop_files(tx, files))
        .accepts_extensions(&["gabc"])
        .on_drop_hover(|s: &mut State, over, _| s.drop_hover = over)
        .child(match &s.score {
            Some(_) => workspace(s, &p, env.scale, dark),
            None => empty(s, &p, env.scale, dark),
        })
        .child(file_label(s, &p))
        .child(menu_trigger(s, &p));
    if s.menu_open {
        root = root.child(menu(s, &p, env.scale, dark));
    }
    if let Some(message) = &s.toast {
        root = root.child(toast(message, &p));
    }
    if s.drop_hover {
        root = root.child(
            el().key("drop-cover")
                .absolute(0.0, 0.0)
                .w_full()
                .h_full()
                .padding(12.0)
                .child(
                    el().w_full()
                        .h_full()
                        .radius(20.0)
                        .fill(p.drop_background)
                        .border(2.0, p.accent)
                        .border_dash(8.0, 6.0),
                ),
        );
    }
    if let Some(dialog) = &s.dialog {
        root = root.child(
            el().key("scrim")
                .absolute(0.0, 0.0)
                .w_full()
                .h_full()
                .fill(p.backdrop),
        );
        root = root.child(
            el().key("dialog-layer")
                .absolute(0.0, 0.0)
                .w_full()
                .h_full()
                .padding(20.0)
                .center()
                .child(match dialog {
                    Dialog::Question {
                        title,
                        text,
                        choices,
                        ..
                    } => question(&p, title, text, choices),
                    Dialog::Shortcuts => shortcuts(s, &p),
                }),
        );
    }
    root
}

fn empty(s: &State, p: &Palette, scale: f32, dark: bool) -> El {
    col()
        .key("empty")
        .w_full()
        .h_full()
        .center()
        .pb(40.0)
        .child(
            el().key("logo")
                .size(260.0, 260.0 * LOGO_RATIO)
                .mb(36.0)
                .pixels(&s.images.logo(scale, dark, 260.0)),
        )
        .child(
            row()
                .key("empty-open")
                .gap(9.0)
                .pl(16.0)
                .pr(20.0)
                .py(11.0)
                .radius(10.0)
                .items_center()
                .fill(p.accent)
                .hover(p.accent_hover)
                .cursor(Cursor::Pointer)
                .shadow(2.0, 8.0, p.accent.alpha(0.15))
                .role("button")
                .label("Open a .gabc file")
                .child(icon(&palette::OPEN, 18.0).color(p.on_accent))
                .child(
                    text("Open a .gabc file")
                        .font(style(14.0, 500.0))
                        .color(p.on_accent),
                )
                .on_press_tx(|s: &mut State, tx: &mut Tx| s.action(tx, "open")),
        )
        .child(
            text("or drag and drop one anywhere on this window")
                .font(style(13.0, 400.0))
                .color(p.subtle)
                .mt(14.0),
        )
}

fn workspace(s: &State, p: &Palette, scale: f32, dark: bool) -> El {
    let score = s.score.as_ref().unwrap();
    let view = &score.view;
    let z = s.zoom;
    let raster = scale * s.raster_zoom;
    let image = |height: f32, pixels: &rune::Pixels| {
        el().absolute(-BLEED * z, -BLEED * z)
            .size((SCORE_WIDTH + 2.0 * BLEED) * z, (height + 2.0 * BLEED) * z)
            .pixels(pixels)
    };
    let mut paper = col()
        .key("paper")
        .w(612.0 * z)
        .fill(p.surface)
        .border(1.0, p.paper_border)
        .shadow(2.0, 14.0, p.shadow)
        .pt(28.8 * z)
        .px(44.0 * z)
        .pb(46.8 * z)
        .child(
            el().key("sheet-header")
                .w(SCORE_WIDTH * z)
                .h(score.header_height * z)
                .child(image(score.header_height, &s.images.header(raster, dark))),
        );
    for (index, staff) in view.staves.iter().enumerate() {
        let pixels = s.images.staff(&s.engine, index, &staff.key, raster, dark);
        let mut el = el()
            .key(format!("staff-{index}"))
            .w(SCORE_WIDTH * z)
            .h(staff.height * z)
            .mb(staff.gap * z)
            .cursor(Cursor::Crosshair)
            .child(image(staff.height, &pixels))
            .on_drag(move |s: &mut State, d: &mut Drag, tx: &mut Tx| {
                let z = s.zoom;
                match d.phase {
                    Phase::Down => s.press(tx, index, d.x / z, d.y / z, d.clicks, tx.mods().cmd),
                    Phase::Move => {
                        let (staff, x) = s.staff_at(index, d.x / z, d.y / z);
                        s.drag_to(tx, staff, x, (d.dx, d.dy));
                    }
                    Phase::Up => s.release(),
                }
            });
        if let Some(sel) = view.selected.filter(|sel| sel.staff == index) {
            el = el.child(
                el_rect(
                    sel.x - 3.0,
                    sel.top - 3.0 + staff.pad,
                    sel.width + 6.0,
                    sel.bottom - sel.top + 6.0,
                    z,
                )
                .radius(3.0 * z)
                .fill(p.selected)
                .border(0.7 * z, p.selected_border),
            );
        }
        let cursor = view.cursor;
        if cursor.staff == index {
            el = el.child(
                el_rect(
                    cursor.x - 2.0,
                    cursor.note_y - 6.0 + staff.pad,
                    11.0,
                    12.0,
                    z,
                )
                .radius(2.0 * z)
                .fill(p.cursor_fill)
                .border(1.3 * z, p.accent),
            );
            if view.selected.is_none() {
                el = el.child(
                    el_rect(cursor.x - 0.65, cursor.y - 12.0 + staff.pad, 1.3, 15.0, z)
                        .fill(p.accent),
                );
            }
        }
        paper = paper.child(el);
    }
    let narrow = s.window_width < 650.0;
    el().key("workspace")
        .w_full()
        .h_full()
        .scroll_xy()
        .on_magnify(|s: &mut State, e, tx| {
            s.magnify(tx, e.delta);
            true
        })
        .child(
            col()
                .items_center()
                .pt(if narrow { 85.0 } else { 95.0 })
                .pb(if narrow { 70.0 } else { 85.0 })
                .px(if narrow { 12.0 } else { 40.0 })
                .child(paper),
        )
}

/// A box at staff points (x, y, w, h), drawn at zoom `z`.
fn el_rect(x: f32, y: f32, w: f32, h: f32, z: f32) -> El {
    el().absolute(x * z, y * z).size(w * z, h * z)
}

fn file_label(s: &State, p: &Palette) -> El {
    let mut label = row()
        .key("file-label")
        .absolute(0.0, 0.0)
        .w_full()
        .pt(32.0)
        .pl(115.0)
        .pr(24.0)
        .justify_end();
    if let Some(score) = &s.score {
        let mut line = row().gap(4.0).min_w(0.0);
        if s.unsaved() {
            line = line.child(text("●").font(style(12.0, 400.0)).color(p.accent));
        }
        label = label.child(
            line.child(
                text(score.name.clone())
                    .font(style(12.0, 400.0))
                    .color(p.muted)
                    .truncate(),
            ),
        );
    }
    label
}

fn menu_trigger(s: &State, p: &Palette) -> El {
    let active = s.menu_open;
    let narrow = s.window_width < 650.0;
    let at = if narrow { 14.0 } else { 20.0 };
    el().key("menu-trigger")
        .absolute(at, at)
        .size(46.0, 46.0)
        .radius(13.0)
        .center()
        .fill(if active { p.soft } else { p.surface })
        .border(1.0, if active { p.accent_border } else { p.border })
        .shadow(2.0, 8.0, p.shadow.alpha(0.05))
        .hover(p.soft)
        .cursor(Cursor::Pointer)
        .role("button")
        .label("Main menu")
        .expanded(active)
        .child(icon(&palette::MENU, 20.0).color(p.text))
        .on_press(|s: &mut State| s.menu_open = !s.menu_open)
}

fn menu(s: &State, p: &Palette, scale: f32, dark: bool) -> El {
    let has = s.score.is_some();
    let mod_ = if MAC { "⌘" } else { "Ctrl " };
    let shift = if MAC { "⇧" } else { "Shift " };
    let item = |action: &'static str,
                label: &str,
                glyph: &'static rune::Icon,
                shortcut: String,
                enabled: bool| {
        let mut r = row()
            .key(format!("menu-{action}"))
            .w_full()
            .gap(12.0)
            .px(12.0)
            .py(10.0)
            .radius(8.0)
            .items_center()
            .role("menuitem")
            .label(label.to_string())
            .child(icon(glyph, 20.0).color(p.text))
            .child(
                text(label.to_string())
                    .font(style(13.0, 400.0))
                    .color(p.text),
            )
            .child(spacer())
            .child(text(shortcut).font(style(11.0, 400.0)).color(p.subtle));
        if enabled {
            r = r
                .hover(p.soft)
                .cursor(Cursor::Pointer)
                .on_press_tx(move |s: &mut State, tx: &mut Tx| s.action(tx, action));
        } else {
            r = r.opacity(0.4).disabled(true);
        }
        r
    };
    let hr = || el().h(1.0).w_full().fill(p.divider).my(8.0);
    let (undo, redo) = s
        .score
        .as_ref()
        .map_or((false, false), |s| (s.view.can_undo, s.view.can_redo));
    let theme_button = |theme: Theme, glyph: &'static rune::Icon, name: &str| {
        let on = s.theme == theme;
        el().key(format!("theme-{name}"))
            .size(36.0, 34.0)
            .radius(8.0)
            .center()
            .cursor(Cursor::Pointer)
            .fill(if on { p.accent } else { p.surface })
            .hover(if on { p.accent } else { p.soft })
            .role("button")
            .label(format!("{} theme", capitalize(name)))
            .checked(on)
            .child(icon(glyph, 20.0).color(if on { p.on_accent } else { p.accent }))
            .on_press(move |s: &mut State| s.set_theme(theme))
    };
    let narrow = s.window_width < 650.0;
    col()
        .key("menu")
        .absolute(
            if narrow { 14.0 } else { 20.0 },
            if narrow { 68.0 } else { 76.0 },
        )
        .w(284.0)
        .padding(12.0)
        .fill(p.surface)
        .border(1.0, p.border)
        .radius(15.0)
        .shadow(8.0, 32.0, p.shadow)
        .role("menu")
        .label("Main menu")
        .modal(true, |s: &mut State| s.menu_open = false)
        .child(
            el().pt(5.0).px(16.0).pb(12.0).child(
                el().size(140.0, 140.0 * LOGO_RATIO)
                    .pixels(&s.images.logo(scale, dark, 260.0)),
            ),
        )
        .child(item(
            "open",
            "Open…",
            &palette::OPEN,
            format!("{mod_}O"),
            true,
        ))
        .child(item(
            "save",
            "Save to file",
            &palette::SAVE,
            format!("{mod_}S"),
            has,
        ))
        .child(item(
            "save-as",
            "Save as…",
            &palette::SAVE,
            format!("{mod_}{shift}S"),
            has,
        ))
        .child(item(
            "export-pdf",
            "Export to PDF…",
            &palette::PDF,
            String::new(),
            has,
        ))
        .child(hr())
        .child(item(
            "undo",
            "Undo",
            &palette::UNDO,
            format!("{mod_}Z"),
            undo,
        ))
        .child(item(
            "redo",
            "Redo",
            &palette::REDO,
            format!("{mod_}{shift}Z"),
            redo,
        ))
        .child(hr())
        .child(item(
            "zoom-in",
            "Zoom in",
            &palette::PLUS,
            format!("{mod_}+"),
            has,
        ))
        .child(item(
            "zoom-out",
            "Zoom out",
            &palette::MINUS,
            format!("{mod_}−"),
            has,
        ))
        .child(hr())
        .child(
            row()
                .w_full()
                .px(12.0)
                .py(4.0)
                .items_center()
                .justify_between()
                .child(text("Theme").font(style(13.0, 400.0)).color(p.text))
                .child(
                    row()
                        .gap(3.0)
                        .padding(3.0)
                        .border(1.0, p.border)
                        .radius(12.0)
                        .child(theme_button(Theme::Light, &palette::LIGHT, "light"))
                        .child(theme_button(Theme::Dark, &palette::DARK, "dark"))
                        .child(theme_button(Theme::System, &palette::SYSTEM, "system")),
                ),
        )
        .child(hr())
        .child(item(
            "shortcuts",
            "Keyboard shortcuts",
            &palette::HELP,
            "F1".into(),
            true,
        ))
        .child(item(
            "about",
            "About Neumes",
            &palette::ABOUT,
            String::new(),
            true,
        ))
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars
        .next()
        .map_or_else(String::new, |c| c.to_uppercase().chain(chars).collect())
}

fn toast(message: &str, p: &Palette) -> El {
    col()
        .key("toast-layer")
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .justify_end()
        .items_center()
        .pb(50.0)
        .child(
            el().key("toast")
                .max_w(600.0)
                .px(18.0)
                .py(12.0)
                .fill(p.surface)
                .border(1.0, p.border)
                .radius(10.0)
                .shadow(4.0, 24.0, p.shadow)
                .role("alert")
                .child(
                    text(message.to_string())
                        .font(style(13.0, 400.0).lh(19.5))
                        .color(p.text)
                        .wrap(),
                ),
        )
}

fn button(p: &Palette, label: &str, style_: Style) -> El {
    let (fill, color, border) = match style_ {
        Style::Plain => (p.surface, p.text, p.border),
        Style::Primary => (p.accent, p.on_accent, p.accent),
        Style::Danger => (p.danger_background, p.danger, p.accent_border),
    };
    el().px(14.0)
        .py(9.0)
        .radius(8.0)
        .fill(fill)
        .border(1.0, border)
        .hover(p.soft.alpha(0.35))
        .cursor(Cursor::Pointer)
        .role("button")
        .label(label.to_string())
        .child(
            text(label.to_string())
                .font(style(13.0, 400.0))
                .color(color),
        )
}

fn question(
    p: &Palette,
    title: &str,
    body: &str,
    choices: &[(&'static str, &'static str, Style)],
) -> El {
    let mut actions = row().gap(9.0).justify_end().w_full().mt(22.0);
    for &(id, label, style_) in choices {
        actions = actions.child(
            button(p, label, style_)
                .key(format!("choice-{id}"))
                .on_press_tx(move |s: &mut State, tx: &mut Tx| s.answer(tx, id)),
        );
    }
    col()
        .key("dialog")
        .w_full()
        .max_w(520.0)
        .padding(28.0)
        .radius(18.0)
        .fill(p.surface)
        .border(1.0, p.border)
        .shadow(20.0, 80.0, p.shadow)
        .role("dialog")
        .label(title.to_string())
        .modal_tx(false, |s: &mut State, tx: &mut Tx| s.answer(tx, "cancel"))
        .child(
            text(title.to_string())
                .font(style(19.0, 600.0).tracking(-0.4))
                .color(p.heading)
                .mb(12.0),
        )
        .child(
            text(body.to_string())
                .font(style(14.0, 400.0).lh(22.4))
                .color(p.muted)
                .wrap(),
        )
        .child(actions)
}

fn shortcuts(s: &State, p: &Palette) -> El {
    let mod_ = if MAC { "⌘" } else { "Ctrl" };
    let row_ = |label: &str, alternatives: &[&[&str]]| {
        let mut keys = row().gap(4.0).items_center();
        for (i, combination) in alternatives.iter().enumerate() {
            if i > 0 {
                keys = keys.child(text("or").font(style(11.0, 400.0)).color(p.muted).mx(5.0));
            }
            for key in *combination {
                let key = if *key == "Ctrl" { mod_ } else { key };
                keys = keys.child(
                    el().min_w(23.0)
                        .h(27.0)
                        .px(7.0)
                        .radius(6.0)
                        .fill(p.key_background)
                        .center()
                        .child(
                            text(key.to_string())
                                .font(style(10.0, 400.0))
                                .color(p.key_text),
                        ),
                );
            }
        }
        row()
            .w_full()
            .items_center()
            .justify_between()
            .pl(12.0)
            .pr(12.0)
            .py(6.0)
            .min_h(39.0)
            .child(
                text(label.to_string())
                    .font(style(12.0, 400.0))
                    .color(p.text),
            )
            .child(keys)
    };
    let section = |title: &str, rows: Vec<El>| {
        let mut table = col()
            .w_full()
            .border(1.0, p.divider)
            .radius(8.0)
            .clip_rounded(8.0);
        for (i, r) in rows.into_iter().enumerate() {
            if i > 0 {
                table = table.child(el().h(1.0).w_full().fill(p.divider));
            }
            table = table.child(r);
        }
        col()
            .grow(1.0)
            .min_w(0.0)
            .child(
                text(title.to_string())
                    .font(style(14.0, 600.0))
                    .color(p.heading)
                    .mb(12.0),
            )
            .child(table)
    };
    let chords = section(
        "Chords",
        vec![
            row_("Add or replace a chord", &[&["Click", "Type"]]),
            row_("Edit existing text", &[&["F2"], &["Double-click"]]),
            row_("Finish typing", &[&["Enter"], &["Esc"]]),
            row_("Next note", &[&["Tab"], &["→"], &["↓"]]),
            row_("Previous note", &[&["Shift", "Tab"], &["←"], &["↑"]]),
            row_("Move to adjacent note", &[&["Ctrl", "← / →"]]),
            row_("Move to adjacent staff", &[&["Ctrl", "↑ / ↓"]]),
            row_("Nudge position (0.5)", &[&["Shift", "Arrow key"]]),
            row_("Nudge position (5)", &[&["Ctrl", "Shift", "Arrow key"]]),
            row_("Snap to another note", &[&["Drag"]]),
            row_("Move text freely", &[&["Ctrl", "Drag"]]),
            row_("Reset manual offsets", &[&["Ctrl", "R"]]),
            row_("Erase text / delete chord", &[&["Backspace"]]),
            row_("Delete chord", &[&["Delete"]]),
        ],
    );
    let editor = section(
        "Editor",
        vec![
            row_("Open file", &[&["Ctrl", "O"]]),
            row_("Save file", &[&["Ctrl", "S"]]),
            row_("Save as", &[&["Ctrl", "Shift", "S"]]),
            row_("Undo", &[&["Ctrl", "Z"]]),
            row_("Redo", &[&["Ctrl", "Shift", "Z"], &["Ctrl", "Y"]]),
            row_("First note", &[&["Home"]]),
            row_("Last note", &[&["End"]]),
            row_("Scroll up", &[&["Page Up"]]),
            row_("Scroll down", &[&["Page Down"]]),
            row_("Zoom in", &[&["Ctrl", "+"]]),
            row_("Zoom out", &[&["Ctrl", "−"]]),
            row_("Keyboard shortcuts", &[&["F1"]]),
        ],
    );
    let wide = s.window_width >= 780.0;
    let grid = if wide {
        row().w_full().gap(24.0).items_start()
    } else {
        col().w_full().gap(24.0)
    };
    col()
        .key("shortcuts")
        .w_full()
        .max_w(960.0)
        .radius(12.0)
        .fill(p.surface)
        .border(1.0, p.border)
        .shadow(20.0, 80.0, p.shadow)
        .role("dialog")
        .label("Keyboard shortcuts")
        .modal(true, |s: &mut State| s.dialog = None)
        .child(
            el().w_full().child(
                col()
                    .w_full()
                    .pt(32.0)
                    .px(36.0)
                    .pb(36.0)
                    .child(
                        row()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .pb(20.0)
                            .child(
                                text("Keyboard shortcuts")
                                    .font(style(19.0, 600.0))
                                    .color(p.heading),
                            )
                            .child(
                                el().key("shortcuts-close")
                                    .size(32.0, 32.0)
                                    .radius(7.0)
                                    .center()
                                    .hover(p.soft)
                                    .cursor(Cursor::Pointer)
                                    .role("button")
                                    .label("Close keyboard shortcuts")
                                    .child(icon(&palette::CLOSE, 20.0).color(p.muted))
                                    .on_press(|s: &mut State| s.dialog = None),
                            ),
                    )
                    .child(el().h(1.0).w_full().fill(p.divider).mb(22.0))
                    .child(grid.child(chords).child(editor)),
            ),
        )
}
