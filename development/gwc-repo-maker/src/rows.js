// rows.js - Adw.ActionRow that never parses its title/subtitle as Pango markup. Setting `use_markup: false` in the constructor is
// not enough: GObject applies construct properties in its own order, so the title may be parsed before the flag is cleared
// (text such as "<key>" or "a && b" then logs a markup warning and renders wrongly).
import Adw from "gi://Adw?version=1";

export function aRow(props = {}) {
    const { title, subtitle, use_markup: _ignored, ...rest } = props;
    const r = new Adw.ActionRow(rest);
    r.set_use_markup(false);
    if (title !== undefined) r.set_title(title);
    if (subtitle !== undefined) r.set_subtitle(subtitle);
    return r;
}
