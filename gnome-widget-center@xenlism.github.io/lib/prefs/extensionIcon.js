// extensionIcon.js - the symbolic "extension" (puzzle piece) icon used wherever a widget has no cover / screenshot.
// A ThemedIcon with several names uses the first one the current icon theme actually has.
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

const NAMES = [ "extension-symbolic", "puzzle-piece-symbolic", "application-x-addon-symbolic" ];

export function newExtensionIcon(pixelSize = 48, cssClasses = [ "dim-label" ]) {
    return new Gtk.Image({
        gicon: Gio.ThemedIcon.new_from_names(NAMES),
        pixel_size: pixelSize,
        hexpand: true,
        vexpand: true,
        css_classes: cssClasses
    });
}
