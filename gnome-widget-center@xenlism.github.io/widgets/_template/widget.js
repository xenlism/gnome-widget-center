import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import {createLayeredCard, applyLayeredCardStyle} from "../../lib/cardLayers.js";
import {configJsonDefaults} from "../../lib/widgetConfigDefaults.js";

export default class TemplateWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "template-widget-root"
        });
        this._actor = this._layers.root;

        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._layers.content.add_child(this._content);

        this._label = new St.Label({
            style_class: "template-widget-label",
            text: "template widget",
        });
        this._content.add_child(this._label);

        this._render();
        return this._actor;
    }

    enable() {
        this._render();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._logger.info("template widget tick");
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    onSettingsChanged() {
        this._render();
    }

    _render() {
        if (!this._actor) return;
        applyLayeredCardStyle(this._layers, this._settings);
        this._label.set_text(this._settings.labelText ?? "template widget");
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
        };
    }
}
