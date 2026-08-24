import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import { SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, parseFontDescription as _parseFontDescription } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const DOW_ABBREV = {
    1: "MO",
    2: "TU",
    3: "WE",
    4: "TH",
    5: "FR",
    6: "SA",
    7: "SU"
};

export default class DateModernWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._buttonPressId = null;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "date-modern-widget-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true
        });
        this._layers.content.add_child(this._content);
        this._monthLabel = new St.Label({
            style_class: "date-modern-widget-month"
        });
        this._dowLabel = new St.Label({
            style_class: "date-modern-widget-dow"
        });
        this._dayLabel = new St.Label({
            style_class: "date-modern-widget-day"
        });
        this._content.add_child(this._monthLabel);
        this._content.add_child(this._dowLabel);
        this._content.add_child(this._dayLabel);
        this._render();
        this._applyClickHandler();
        return this._actor;
    }
    enable() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }
    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._removeClickHandler();
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
        };
    }
    onSettingsChanged() {
        this._render();
        this._applyClickHandler();
    }
    _applyClickHandler() {
        this._removeClickHandler();
        const launchOnClick = this._settings.launchOnClick ?? false;
        const desktopFilePath = this._settings.desktopFilePath ?? "";
        if (!launchOnClick || !desktopFilePath) return;
        this._actor.reactive = true;
        this._buttonPressId = this._actor.connect("button-press-event", (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (event.get_state() & Clutter.ModifierType.MOD4_MASK) return Clutter.EVENT_PROPAGATE;
            this._launchApp();
            return Clutter.EVENT_STOP;
        });
    }
    _removeClickHandler() {
        if (this._buttonPressId !== null) {
            this._actor.disconnect(this._buttonPressId);
            this._buttonPressId = null;
        }
    }
    _launchApp() {
        const desktopFilePath = this._settings.desktopFilePath ?? "";
        if (!desktopFilePath) return;
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(desktopFilePath);
            if (!appInfo) {
                this._api.logger.info(`date-modern: could not read .desktop file at ${desktopFilePath}`);
                return;
            }
            appInfo.launch([], null);
        } catch (e) {
            this._api.logger.info(`date-modern: failed to launch ${desktopFilePath}: ${e}`);
        }
    }
    _render() {
        const now = GLib.DateTime.new_now_local();
        const {family: monthFontFamily, size: monthFontSize} = _parseFontDescription(this._settings.monthFont ?? "Sans Bold 14", "Sans Bold", 14);
        const {family: dowFontFamily, size: dowFontSize} = _parseFontDescription(this._settings.dowFont ?? "Sans Bold 16", "Sans Bold", 16);
        const {family: dayFontFamily, size: dayFontSize} = _parseFontDescription(this._settings.dayFont ?? "Sans Bold 30", "Sans Bold", 30);
        const colorMonth = this._settings.colorMonth ?? "#d81f26";
        const colorDow = this._settings.colorDow ?? "#1a1a1a";
        const colorDay = this._settings.colorDay ?? "#1a1a1a";
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorKey: "cardColor",
            cornerRadiusFallback: 18
        }, false);
        this._content.set_style(" padding: 12px 12px; spacing: 0px;");
        this._monthLabel.set_text(now.format("%b") ?? "");
        this._monthLabel.set_style(`color: ${colorMonth}; font-family: ${monthFontFamily}; ` + `font-size: ${monthFontSize}px; font-weight: bold; text-align: center;`);
        const dowCode = DOW_ABBREV[now.get_day_of_week()] ?? "";
        this._dowLabel.set_text(dowCode);
        this._dowLabel.set_style(`color: ${colorDow}; font-family: ${dowFontFamily}; ` + `font-size: ${dowFontSize}px; font-weight: bold; text-align: center;`);
        this._dayLabel.set_text(now.format("%d") ?? "");
        this._dayLabel.set_style(`color: ${colorDay}; font-family: ${dayFontFamily}; ` + `font-size: ${dayFontSize}px; font-weight: bold; text-align: center;`);
    }
}