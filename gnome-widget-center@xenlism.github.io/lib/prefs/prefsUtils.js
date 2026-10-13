// prefsUtils.js - small helpers shared by the preferences UI.
import GLib from "gi://GLib";

/** Escape text for Pango markup (Adw.ActionRow titles / subtitles are markup). Use for every untrusted string. */
export function escapeMarkup(text) {
    return GLib.markup_escape_text(String(text ?? ""), -1);
}
