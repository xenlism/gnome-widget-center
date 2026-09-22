import St from "gi://St";
import Clutter from "gi://Clutter";
import Gio from "gi://Gio";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";
import { toCssColor as _toCssColor } from "../../lib/widgetVisualKit.js";

const WIDTH = 368;
const HEIGHT = 176;

export default class ChatGptWideWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "chatgpt-wide-root"
        });
        this._actor = this._layers.root;
        this._actor.width = WIDTH;
        this._actor.height = HEIGHT;

        const outer = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true
        });
        outer.set_style("padding: 16px;");
        this._layers.content.add_child(outer);

        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true
        });

        this._mark = new St.Label({ text: "GPT" });
        this._title = new St.Label({ text: "ChatGPT" });
        this._title.set_x_expand(true);

        header.add_child(this._mark);
        header.add_child(this._title);
        outer.add_child(header);

        this._hint = new St.Label({
            text: "Ask anything"
        });
        outer.add_child(this._hint);

        const row = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true
        });
        row.set_style("spacing: 8px; margin-top: 8px;");

        this._entry = new St.Entry({
            hint_text: "Type a prompt…",
            can_focus: true,
            x_expand: true
        });
        this._entry.clutter_text.connect("activate", () => this._openPrompt());

        this._button = new St.Button({
            label: "Ask"
        });
        this._button.connect("clicked", () => this._openPrompt());

        row.add_child(this._entry);
        row.add_child(this._button);
        outer.add_child(row);

        this._render();
        return this._actor;
    }

    enable() {}

    disable() {}

    onSettingsChanged() {
        this._render();
    }

    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            cornerRadiusFallback: 18
        }, false);

        const accent = _toCssColor(this._settings.accentColor ?? "#FFFFFF", "#FFFFFF");
        this._mark.set_style(
            `font-size: 25px; font-weight: 800; color: ${accent}; margin-right: 10px;`
        );
        this._title.set_style("font-size: 16px; font-weight: 650; padding-top: 5px;");
        this._hint.set_style("font-size: 12px; opacity: 0.65; margin-top: 4px;");
        this._entry.set_style(
            "padding: 9px 10px; border-radius: 10px; background-color: rgba(255,255,255,0.08);"
        );
        this._button.set_style(
            `padding: 9px 12px; border-radius: 10px; background-color: rgba(255,255,255,0.12); color: ${accent}; font-weight: 700;`
        );
    }

    _openPrompt() {
        const prompt = this._entry.get_text().trim();
        let url = "https://chatgpt.com/";

        if (prompt.length > 0) {
            url += `?q=${encodeURIComponent(prompt)}`;
        }

        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
            this._entry.set_text("");
        } catch (e) {
            this._api.logger?.error?.(`chatgpt-wide: failed to open ChatGPT: ${e}`);
        }
    }
}
