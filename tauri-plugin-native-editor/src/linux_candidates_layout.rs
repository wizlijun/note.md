//! Candidate presentation only. Indices always refer to the original Fcitx list;
//! local pages never change the engine's numbering or the document buffer.

use unicode_segmentation::UnicodeSegmentation;

const MAX_ROWS: usize = 4;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Candidate {
    pub index: i32,
    pub label: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Placement {
    pub index: i32,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Layout {
    pub placements: Vec<Placement>,
    pub rows: usize,
    /// Half-open slice positions, not engine candidate indices.
    pub page_start: usize,
    pub page_end: usize,
}

/// `measure` must use the editor's actual Pango font and logical pixel units.
/// A nonnegative cursor selects its local page. Pass -1 when explicitly paging
/// without moving the engine cursor; `requested_page_start` selects that page.
/// `max_rows` is the number fitting in the actual viewport (clamped to 1..=4).
/// The caller must fall back to the system panel when even one row cannot fit.
pub(super) fn layout(
    candidates: &[Candidate],
    cursor_index: i32,
    requested_page_start: usize,
    available_width: f64,
    line_pitch: f64,
    gap: f64,
    max_rows: usize,
    mut measure: impl FnMut(&str) -> f64,
) -> Layout {
    if candidates.is_empty() {
        return Layout::default();
    }
    let width = available_width.max(1.0);
    let pitch = line_pitch.max(1.0);
    let gap = gap.max(0.0);
    let max_rows = max_rows.clamp(1, MAX_ROWS);
    let selected = candidates
        .iter()
        .position(|candidate| cursor_index >= 0 && candidate.index == cursor_index)
        .unwrap_or(requested_page_start.min(candidates.len() - 1));
    let mut page = Layout::default();
    let mut x = 0.0;
    let mut row = 0;
    for (position, candidate) in candidates.iter().enumerate() {
        let full = if candidate.label.is_empty() {
            candidate.text.clone()
        } else {
            format!("{} {}", candidate.label, candidate.text)
        };
        let (text, measured) = ellipsize(&full, width, &mut measure);
        if !page.placements.is_empty() && x + measured > width {
            row += 1;
            x = 0.0;
        }
        if row == max_rows {
            page.page_end = position;
            if selected < position {
                return page;
            }
            page = Layout {
                page_start: position,
                ..Layout::default()
            };
            row = 0;
        }
        page.placements.push(Placement {
            index: candidate.index,
            text,
            x,
            y: row as f64 * pitch,
            width: measured,
        });
        page.rows = row + 1;
        x += measured + gap;
    }
    page.page_end = candidates.len();
    page
}

fn ellipsize(text: &str, width: f64, measure: &mut impl FnMut(&str) -> f64) -> (String, f64) {
    let measured = measure(text);
    if measured <= width {
        return (text.into(), measured);
    }
    let ellipsis_width = measure("…");
    if ellipsis_width > width {
        // No glyph fits. Keep the indexed placement so keyboard selection and
        // pagination still cover the candidate even in a temporarily tiny view.
        return (String::new(), 0.0);
    }
    for (end, _) in text.grapheme_indices(true).rev() {
        let display = format!("{}…", &text[..end]);
        let measured = measure(&display);
        if measured <= width {
            return (display, measured);
        }
    }
    ("…".into(), ellipsis_width)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Mode {
    Focus,
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Geometry {
    pub input_top: f64,
    pub candidates_top: f64,
    pub candidates_height: f64,
    /// Positive values scroll existing content upward. GTK applies this to its
    /// adjustment; do not translate drawing alone, which would break IME/clicks.
    pub scroll_delta: f64,
}

/// Coordinates are relative to the editor viewport, with its existing bottom
/// inset already removed. `caret_top` is the current input row's actual top.
pub(super) fn geometry(
    mode: Mode,
    viewport_height: f64,
    caret_top: f64,
    line_pitch: f64,
    candidate_rows: usize,
) -> Geometry {
    let pitch = line_pitch.max(1.0);
    let candidates_height = candidate_rows.min(MAX_ROWS) as f64 * pitch;
    let input_top = match mode {
        Mode::Focus => caret_top,
        Mode::Bottom => (viewport_height - pitch - candidates_height).max(0.0),
    };
    Geometry {
        input_top,
        candidates_top: input_top + pitch,
        candidates_height,
        scroll_delta: caret_top - input_top,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidates(count: usize) -> Vec<Candidate> {
        (0..count)
            .map(|i| Candidate {
                index: (i * 3) as i32,
                label: format!("{}.", i + 1),
                text: "汉字".into(),
            })
            .collect()
    }

    // The closure deliberately has variable Unicode widths: byte/character
    // counts cannot substitute for measurements from the editor's Pango layout.
    fn measure(text: &str) -> f64 {
        text.chars()
            .map(|c| match c {
                '汉' | '字' | '😀' => 20.0,
                '\u{301}' => 0.0,
                _ => 5.0,
            })
            .sum()
    }

    #[test]
    fn rows_use_measured_width_and_start_at_left() {
        let page = layout(&candidates(5), -1, 0, 120.0, 32.0, 10.0, 4, measure);
        assert_eq!(page.rows, 3);
        assert_eq!(page.page_end, 5);
        assert_eq!(page.placements[0].text, "1. 汉字");
        assert_eq!(page.placements[0].width, 55.0);
        assert_eq!(page.placements[1].x, 65.0);
        assert_eq!(page.placements[2].x, 0.0);
        assert_eq!(page.placements[2].y, 32.0);
    }

    #[test]
    fn long_unicode_words_are_ellipsized_without_changing_identity() {
        let entries = vec![Candidate {
            index: 23,
            label: "7.".into(),
            text: "汉字😀e\u{301}".into(),
        }];
        let page = layout(&entries, 23, 0, 45.0, 32.0, 10.0, 4, measure);
        assert_eq!(page.placements[0].index, 23);
        assert_eq!(page.placements[0].text, "7. 汉…");
        assert!(page.placements[0].width <= 45.0);
        assert_eq!(entries[0].text, "汉字😀e\u{301}");
    }

    #[test]
    fn four_row_limit_paginates_without_losing_candidates() {
        let entries = candidates(11);
        let mut start = 0;
        let mut seen = Vec::new();
        while start < entries.len() {
            let page = layout(&entries, -1, start, 55.0, 32.0, 10.0, 4, measure);
            assert!(page.rows <= MAX_ROWS);
            assert_eq!(page.page_start, start);
            assert!(page.page_end > start);
            seen.extend(page.placements.iter().map(|p| p.index));
            start = page.page_end;
        }
        assert_eq!(seen, entries.iter().map(|c| c.index).collect::<Vec<_>>());
    }

    #[test]
    fn cursor_uses_real_index_and_automatically_reveals_its_page() {
        let page = layout(&candidates(11), 27, 0, 55.0, 32.0, 10.0, 4, measure);
        assert_eq!((page.page_start, page.page_end), (8, 11));
        assert!(page.placements.iter().any(|p| p.index == 27));
        let previous = layout(&candidates(11), -1, 4, 55.0, 32.0, 10.0, 4, measure);
        assert_eq!((previous.page_start, previous.page_end), (4, 8));
    }

    #[test]
    fn viewport_row_limit_pages_the_selected_candidate_without_clipping() {
        let page = layout(&candidates(11), 27, 0, 55.0, 32.0, 10.0, 2, measure);
        assert_eq!((page.page_start, page.page_end), (8, 10));
        assert_eq!(page.rows, 2);
        assert_eq!(page.placements.last().unwrap().index, 27);
        let one = layout(&candidates(11), 27, 0, 55.0, 32.0, 10.0, 0, measure);
        assert_eq!((one.page_start, one.page_end), (9, 10));
        assert_eq!(one.rows, 1);
        let capped = layout(&candidates(11), 27, 0, 55.0, 32.0, 10.0, 9, measure);
        assert!(capped.rows <= 4);
    }

    #[test]
    fn ellipsis_preserves_combining_emoji_and_flag_graphemes() {
        for word in ["👩🏽‍💻", "🇨🇳", "e\u{301}"] {
            let entries = vec![Candidate {
                index: 17,
                label: String::new(),
                text: format!("A{word}ZZ"),
            }];
            let page = layout(&entries, 17, 0, 3.0, 32.0, 0.0, 4, |value| {
                value.graphemes(true).count() as f64
            });
            assert_eq!(page.placements[0].text, format!("A{word}…"));
            assert_eq!(page.placements[0].width, 3.0);
        }
    }

    #[test]
    fn narrow_windows_and_empty_lists_still_terminate() {
        assert_eq!(
            layout(&[], -1, 0, 0.0, 0.0, 0.0, 4, measure),
            Layout::default()
        );
        let page = layout(&candidates(9), 24, 0, 1.0, 32.0, 10.0, 4, measure);
        assert_eq!(page.page_end, 9);
        assert_eq!(page.placements[0].index, 24);
        assert_eq!(page.placements[0].width, 0.0);
        assert_eq!(page.rows, 1);
    }

    #[test]
    fn focus_candidates_start_on_next_input_row() {
        let geometry = geometry(Mode::Focus, 700.0, 320.0, 32.0, 4);
        assert_eq!(geometry.input_top, 320.0);
        assert_eq!(geometry.candidates_top, 352.0);
        assert_eq!(geometry.candidates_height, 128.0);
        assert_eq!(geometry.scroll_delta, 0.0);
    }

    #[test]
    fn bottom_input_and_candidates_move_up_as_rows_expand() {
        let single = geometry(Mode::Bottom, 700.0, 350.0, 32.0, 1);
        let expanded = geometry(Mode::Bottom, 700.0, 350.0, 32.0, 4);
        assert_eq!(single.input_top, 636.0);
        assert_eq!(expanded.input_top, 540.0);
        assert_eq!(expanded.candidates_top + expanded.candidates_height, 700.0);
        assert_eq!(expanded.scroll_delta - single.scroll_delta, 96.0);
        let idle = geometry(Mode::Bottom, 700.0, 350.0, 32.0, 0);
        assert_eq!(idle.input_top, 668.0);
    }
}
