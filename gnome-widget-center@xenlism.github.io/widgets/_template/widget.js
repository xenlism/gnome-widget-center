import St from "gi://St";

import GLib from "gi://GLib";

export default class TemplateWidget {
    constructor(api) {
        this._api = api;
    }
    buildActor() {
        this._actor = new St.Label({
            style_class: "template-widget-label",
            text: "template widget"
        });
        return this._actor;
    }
    enable() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._api.logger.info("template widget tick");
            return GLib.SOURCE_CONTINUE;
        });
    }
    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }
    getDefaultSettings() {
        return {};
    }
}