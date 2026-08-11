import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gio from "gi://Gio";

export function showReportDialog(window, title, bodyText) {
    const dialog = new Adw.MessageDialog({
        transient_for: window,
        heading: title,
        body: bodyText || "(nothing to report)",
        modal: true
    });
    dialog.add_response("close", "Close");
    dialog.present();
}

export function promptPassword(window, heading, body) {
    return new Promise(resolve => {
        const dialog = new Adw.MessageDialog({
            transient_for: window,
            heading: heading,
            body: body,
            modal: true
        });
        const entry = new Gtk.PasswordEntry({
            show_peek_icon: true,
            margin_top: 8
        });
        dialog.set_extra_child(entry);
        dialog.add_response("cancel", "Cancel");
        dialog.add_response("ok", "Continue");
        dialog.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response("ok");
        entry.connect("activate", () => dialog.response("ok"));
        dialog.connect("response", (_d, response) => {
            resolve(response === "ok" ? entry.text : null);
        });
        dialog.present();
    });
}

export function confirmOverwrite(window, heading, body, confirmLabel = "Overwrite") {
    return new Promise(resolve => {
        const dialog = new Adw.MessageDialog({
            transient_for: window,
            heading: heading,
            body: body,
            modal: true
        });
        dialog.add_response("cancel", "Cancel");
        dialog.add_response("confirm", confirmLabel);
        dialog.set_response_appearance("confirm", Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response("cancel");
        dialog.set_close_response("cancel");
        dialog.connect("response", (_d, response) => {
            resolve(response === "confirm");
        });
        dialog.present();
    });
}

export function chooseFile(window, opts) {
    return new Promise(resolve => {
        const action = opts.action === "save" ? Gtk.FileChooserAction.SAVE : opts.action === "select_folder" ? Gtk.FileChooserAction.SELECT_FOLDER : Gtk.FileChooserAction.OPEN;
        const chooser = new Gtk.FileChooserNative({
            title: opts.title,
            action: action,
            transient_for: window,
            modal: true,
            accept_label: opts.action === "save" ? "_Save" : opts.action === "select_folder" ? "_Select" : "_Open"
        });
        if (opts.initialName) chooser.set_current_name(opts.initialName);
        if (opts.initialFolder) {
            try {
                chooser.set_current_folder(Gio.File.new_for_path(opts.initialFolder));
            } catch (e) {}
        }
        if (opts.pattern) {
            const filter = new Gtk.FileFilter;
            filter.add_pattern(opts.pattern);
            filter.set_name(opts.pattern);
            chooser.add_filter(filter);
        }
        chooser.connect("response", (_c, response) => {
            const file = response === Gtk.ResponseType.ACCEPT ? chooser.get_file() : null;
            resolve(file ? file.get_path() : null);
            chooser.destroy();
        });
        chooser.show();
    });
}