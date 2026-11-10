//! A native Wayland subsurface keeps caret animation off the WebKit backing
//! surface. GTK still owns allocation, scaling, mapping and window destruction.
use gtk::{gdk, glib, prelude::*, subclass::prelude::*};

glib::wrapper! {
    pub struct Area(ObjectSubclass<imp::Area>)
        @extends gtk::DrawingArea, gtk::Widget,
        @implements gtk::Buildable;
}

pub(super) fn new() -> gtk::DrawingArea {
    glib::Object::new::<Area>().upcast()
}

mod imp {
    use super::*;

    fn position(widget: &super::Area, window: &gdk::Window, parent: &gdk::Window) {
        let (_, px, py) = parent.origin();
        let (_, tx, ty) = parent.effective_toplevel().origin();
        let allocation = widget.allocation();
        window.move_(px - tx + allocation.x(), py - ty + allocation.y());
    }

    #[derive(Default)]
    pub struct Area;

    #[glib::object_subclass]
    impl ObjectSubclass for Area {
        const NAME: &'static str = "SumiCaretArea";
        type Type = super::Area;
        type ParentType = gtk::DrawingArea;
    }
    impl ObjectImpl for Area {}
    impl DrawingAreaImpl for Area {}
    impl WidgetImpl for Area {
        fn realize(&self) {
            let widget = self.obj();
            let Some(parent) = widget.parent_window() else {
                return self.parent_realize();
            };
            if widget.display().type_().name() != "GdkWaylandDisplay"
                || parent.effective_toplevel().window_type() == gdk::WindowType::Offscreen
            {
                return self.parent_realize();
            }
            let allocation = widget.allocation();
            widget.set_realized(true);
            // GDK's frame API starts/ends a native paint only for root children.
            // The Wayland parent is supplied separately by transient_for.
            let window = gdk::Window::new(
                None,
                &gdk::WindowAttr {
                    window_type: gdk::WindowType::Subsurface,
                    x: Some(allocation.x()),
                    y: Some(allocation.y()),
                    width: allocation.width().max(1),
                    height: allocation.height().max(1),
                    visual: widget.visual(),
                    event_mask: gdk::EventMask::EXPOSURE_MASK,
                    ..Default::default()
                },
            );
            window.set_transient_for(&parent.effective_toplevel());
            position(&widget, &window, &parent);
            window.set_pass_through(true);
            window.input_shape_combine_region(&gtk::cairo::Region::create(), 0, 0);
            widget.register_window(&window);
            widget.set_window(window);
        }

        fn size_allocate(&self, allocation: &gtk::Allocation) {
            self.parent_size_allocate(allocation);
            let widget = self.obj();
            if let (Some(window), Some(parent)) = (widget.window(), widget.parent_window()) {
                if window.window_type() == gdk::WindowType::Subsurface {
                    position(&widget, &window, &parent);
                }
            }
        }
    }
}
