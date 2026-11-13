//! The web app's colours (`src/styles.css`) and icons (`src/main.ts`).

use rune::{Color, Icon};

pub struct Palette {
    pub accent: Color,
    pub soft: Color,
    pub border: Color,
    pub background: Color,
    pub surface: Color,
    pub text: Color,
    pub heading: Color,
    pub muted: Color,
    pub subtle: Color,
    pub accent_border: Color,
    pub accent_hover: Color,
    pub on_accent: Color,
    pub divider: Color,
    pub paper_border: Color,
    pub selected: Color,
    pub selected_border: Color,
    pub cursor_fill: Color,
    pub key_background: Color,
    pub key_text: Color,
    pub danger: Color,
    pub danger_background: Color,
    pub drop_background: Color,
    pub backdrop: Color,
    pub shadow: Color,
}

fn c(hex: &str) -> Color {
    rune::color::hex(hex).unwrap_or_else(|| panic!("bad colour {hex}"))
}

impl Palette {
    pub fn new(dark: bool) -> Palette {
        if dark {
            Palette {
                accent: c("#e58d80"),
                soft: c("#41332f"),
                border: c("#3d3f38"),
                background: c("#171816"),
                surface: c("#262724"),
                text: c("#e1dfd6"),
                heading: c("#eeece3"),
                muted: c("#b6b3a8"),
                subtle: c("#aaa79d"),
                accent_border: c("#735047"),
                accent_hover: c("#efa294"),
                on_accent: c("#30221e"),
                divider: c("#383a34"),
                paper_border: c("#353730"),
                selected: c("#e58d8029"),
                selected_border: c("#e58d8099"),
                cursor_fill: c("#e58d8020"),
                key_background: c("#503a34"),
                key_text: c("#f0b9ae"),
                danger: c("#f0a296"),
                danger_background: c("#45322e"),
                drop_background: c("#41332fed"),
                backdrop: c("#25221d35"),
                shadow: c("#00000030"),
            }
        } else {
            Palette {
                accent: c("#b8342a"),
                soft: c("#f8ecea"),
                border: c("#e5e3dd"),
                background: c("#f6f5f1"),
                surface: c("#ffffff"),
                text: c("#36352f"),
                heading: c("#24231f"),
                muted: c("#7d7a70"),
                subtle: c("#8d8b85"),
                accent_border: c("#edd2cd"),
                accent_hover: c("#a42d24"),
                on_accent: c("#ffffff"),
                divider: c("#ebe9e3"),
                paper_border: c("#eeede6"),
                selected: c("#b8342a1f"),
                selected_border: c("#b8342a70"),
                cursor_fill: c("#b8342a14"),
                key_background: c("#f6e0dc"),
                key_text: c("#5c302b"),
                danger: c("#b14c42"),
                danger_background: c("#fff2f0"),
                drop_background: c("#f8eceaed"),
                backdrop: c("#25221d35"),
                shadow: c("#26241e14"),
            }
        }
    }
}

macro_rules! icons {
    ($($name:ident = $body:literal;)*) => {
        $(pub static $name: Icon = Icon {
            name: stringify!($name),
            view: 24.0,
            body: concat!(r#"<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">"#, $body, "</g>"),
        };)*
    };
}

icons! {
    MENU = r#"<path d="M4 6h16M4 12h16M4 18h16"/>"#;
    OPEN = r#"<path d="M3 7V5h6l2 3h10l-3 12H3V7Z"/>"#;
    SAVE = r#"<path d="M4 3h13l3 3v15H4V3Zm3 0v6h9V3M7 21v-8h10v8"/>"#;
    PDF = r#"<path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6"/>"#;
    UNDO = r#"<path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14"/>"#;
    REDO = r#"<path d="m16 4 5 5-5 5M21 9H11a7 7 0 0 0 0 14"/>"#;
    PLUS = r#"<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6M10 7v6"/>"#;
    MINUS = r#"<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6"/>"#;
    HELP = r#"<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10"/>"#;
    LIGHT = r#"<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>"#;
    DARK = r#"<path d="M20.5 13A9 9 0 0 1 11 3.5 9 9 0 1 0 20.5 13Z"/>"#;
    SYSTEM = r#"<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8M12 17v4"/>"#;
    ABOUT = r#"<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>"#;
    CLOSE = r#"<path d="m6 6 12 12M18 6 6 18"/>"#;
}
