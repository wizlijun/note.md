//! Initial plugin window geometry in logical desktop coordinates.

#[derive(Clone, Copy, Debug)]
pub(super) struct WorkArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl WorkArea {
    pub(super) fn from_physical(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Self {
        Self {
            x: f64::from(x) / scale,
            y: f64::from(y) / scale,
            width: f64::from(width) / scale,
            height: f64::from(height) / scale,
        }
    }
}

#[derive(Debug, PartialEq)]
pub(super) struct Layout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub minimum: Option<(f64, f64)>,
}

pub(super) fn fit(
    width: f64,
    height: f64,
    minimum: Option<(f64, f64)>,
    work: WorkArea,
    titlebar_height: f64,
) -> Layout {
    let max_width = (work.width - 32.0).max(1.0);
    let max_height = (work.height - titlebar_height - 32.0).max(1.0);
    let minimum = minimum.map(|(w, h)| (w.min(max_width), h.min(max_height)));
    let (min_width, min_height) = minimum.unwrap_or((1.0, 1.0));
    let width = width.max(min_width).min(max_width);
    let height = height.max(min_height).min(max_height);
    Layout {
        x: work.x + ((work.width - width) / 2.0).max(0.0),
        // Even an unusually tall titlebar must not put its top above the work area.
        y: work.y + ((work.height - height - titlebar_height) / 2.0).max(0.0),
        width,
        height,
        minimum,
    }
}

/// Preserve the Sumi canvas proportions while using the current logical work area.
pub(super) fn fit_sumi(width: f64, height: f64, minimum: Option<(f64, f64)>,
    work: WorkArea, titlebar_height: f64) -> Layout {
    let scale = (work.width * 0.8 / width)
        .min((work.height - titlebar_height).max(1.0) * 0.85 / height);
    fit(width * scale, height * scale, minimum, work, titlebar_height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_content_and_titlebar_inside_work_area() {
        let layout = fit(
            960.0,
            720.0,
            None,
            WorkArea::from_physical(0, 24, 1920, 1056, 1.0),
            47.0,
        );
        assert_eq!(
            layout,
            Layout {
                x: 480.0,
                y: 168.5,
                width: 960.0,
                height: 720.0,
                minimum: None
            }
        );
    }

    #[test]
    fn low_height_clamps_manifest_minimum_as_well_as_content() {
        let layout = fit(
            960.0,
            720.0,
            Some((640.0, 600.0)),
            WorkArea::from_physical(0, 24, 800, 300, 1.0),
            47.0,
        );
        assert_eq!(
            layout,
            Layout {
                x: 16.0,
                y: 40.0,
                width: 768.0,
                height: 221.0,
                minimum: Some((640.0, 221.0))
            }
        );
        assert_eq!(layout.y + layout.height + 47.0 + 16.0, 324.0);
    }

    #[test]
    fn physical_scale_and_negative_monitor_origin_are_applied_once() {
        let layout = fit(
            960.0,
            720.0,
            None,
            WorkArea::from_physical(-1920, -240, 1920, 1200, 2.0),
            47.0,
        );
        assert_eq!(
            layout,
            Layout {
                x: -944.0,
                y: -104.0,
                width: 928.0,
                height: 521.0,
                minimum: None
            }
        );
    }

    #[test]
    fn requested_size_respects_a_larger_minimum_without_overflowing() {
        let layout = fit(
            300.0,
            200.0,
            Some((640.0, 480.0)),
            WorkArea::from_physical(0, 0, 1920, 1080, 1.0),
            47.0,
        );
        assert_eq!((layout.width, layout.height), (640.0, 480.0));
        assert_eq!(layout.minimum, Some((640.0, 480.0)));
    }

    #[test]
    fn tiny_work_area_never_places_titlebar_above_visible_origin() {
        let layout = fit(
            960.0,
            720.0,
            Some((640.0, 480.0)),
            WorkArea::from_physical(-20, 10, 20, 30, 1.0),
            47.0,
        );
        assert_eq!((layout.x, layout.y), (-10.5, 10.0));
        assert_eq!((layout.width, layout.height), (1.0, 1.0));
        assert_eq!(layout.minimum, Some((1.0, 1.0)));
    }
    #[test]
    fn sumi_scales_proportionally_on_current_logical_monitor() {
        let small = fit_sumi(960., 720., Some((640., 480.)),
            WorkArea::from_physical(0, 24, 1440, 876, 1.), 28.);
        let large = fit_sumi(960., 720., Some((640., 480.)),
            WorkArea::from_physical(0, 24, 1920, 1176, 1.), 28.);
        assert!(large.width > small.width && large.height > small.height);
        assert!((large.width / large.height - 4. / 3.).abs() < 0.001);
        let retina = fit_sumi(960., 720., Some((640., 480.)),
            WorkArea::from_physical(0, 48, 2880, 1752, 2.), 28.);
        assert_eq!(retina, small);
    }
    #[test]
    fn sumi_small_external_work_area_clamps_minimum_and_stays_visible() {
        let layout = fit_sumi(960., 720., Some((640., 600.)),
            WorkArea::from_physical(-1600, 80, 1600, 600, 2.), 28.);
        assert!(layout.x >= -800. && layout.x + layout.width <= 0.);
        assert!(layout.y >= 40. && layout.y + layout.height + 28. <= 340.);
        assert!(layout.minimum.unwrap().1 <= layout.height);
    }

}
