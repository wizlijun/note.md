//! Linux presentation for the plugin's single, privately owned Close menu.
use gtk::prelude::*;

pub(super) fn hide_private_close_menu(container: &gtk::Box) -> Result<(), String> {
    let mut bars = container
        .children()
        .into_iter()
        .filter_map(|child| child.downcast::<gtk::MenuBar>().ok());
    let bar = bars.next().ok_or("plugin Close menu bar is missing")?;
    if bars.next().is_some() {
        return Err("plugin has more than one menu bar".into());
    }
    let children = bar.children();
    let [child] = children.as_slice() else {
        return Err("plugin Close menu must contain exactly one item".into());
    };
    let item = child
        .downcast_ref::<gtk::MenuItem>()
        .ok_or("plugin Close menu has an unexpected item type")?;
    // GTK normally disables accelerators on hidden menu items. The caller
    // verifies this is the private Close ID before granting this exception.
    item.connect_can_activate_accel(|item, _| item.is_sensitive());
    bar.show_all();
    bar.set_no_show_all(true);
    bar.hide();
    Ok(())
}
