import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Pango from "gi://Pango";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, parseFontDescription as _parseFontDescription, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

export default class ClockModernWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._buttonPressId = null;
    }
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: "clock-modern-widget-root",
            vertical: true
        });
        this._ampmLabel = new St.Label({
            style_class: "clock-modern-widget-ampm"
        });
        this._hhLabel = new St.Label({
            style_class: "clock-modern-widget-hh"
        });
        this._mmLabel = new St.Label({
            style_class: "clock-modern-widget-mm"
        });
        this._ssLabel = new St.Label({
            style_class: "clock-modern-widget-ss"
        });
        this._actor.add_child(this._ampmLabel);
        this._actor.add_child(this._hhLabel);
        this._actor.add_child(this._mmLabel);
        this._actor.add_child(this._ssLabel);
        this._render();
        this._applyClickHandler();
        return this._actor;
    }
    enable() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
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
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            format24h: true,
            font: "Sans Bold 30",
            ampmFont: "Sans Bold 10",
            colorHH: "#1a1a1a",
            colorMM: "#1a1a1a",
            colorSS: "#1a1a1a",
            colorAmPm: "#d81f26",
            cardColor: "#ffffff",
            cornerRadius: 18,
            launchOnClick: false,
            desktopFilePath: ""
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
                this._api.logger.info(`clock-modern: could not read .desktop file at ${desktopFilePath}`);
                return;
            }
            appInfo.launch([], null);
        } catch (e) {
            this._api.logger.info(`clock-modern: failed to launch ${desktopFilePath}: ${e}`);
        }
    }
    _render() {
        const now = GLib.DateTime.new_now_local();
        const format24h = this._settings.format24h ?? true;
        const {family: fontFamily, size: fontSize} = _parseFontDescription(this._settings.font ?? "Sans Bold 30", "Sans Bold", 30);
        const {family: ampmFontFamily, size: ampmFontSize} = _parseFontDescription(this._settings.ampmFont ?? "Sans Bold 10", "Sans Bold", 10);
        const colorHH = this._settings.colorHH ?? "#1a1a1a";
        const colorMM = this._settings.colorMM ?? "#1a1a1a";
        const colorSS = this._settings.colorSS ?? "#1a1a1a";
        const colorAmPm = this._settings.colorAmPm ?? "#d81f26";
        this._actor.set_style((this._api.resolveCardCss?.() ?? _cardStyleCss(this._settings, {
            backgroundColorKey: "cardColor",
            cornerRadiusFallback: 18
        })) + "padding: 12px 12px; " + "spacing: 0px;");
        if (format24h) {
            this._ampmLabel.hide();
        } else {
            this._ampmLabel.show();
            const hour = now.get_hour();
            this._ampmLabel.set_text(hour < 12 ? "am" : "pm");
            this._ampmLabel.set_style(`color: ${colorAmPm}; font-family: ${ampmFontFamily}; ` + `font-size: ${ampmFontSize}px; font-weight: bold; text-align: center;`);
        }
        let hourText;
        if (format24h) {
            hourText = now.format("%H") ?? "";
        } else {
            let h12 = now.get_hour() % 12;
            if (h12 === 0) h12 = 12;
            hourText = String(h12).padStart(2, "0");
        }
        this._hhLabel.set_text(hourText);
        this._hhLabel.set_style(`color: ${colorHH}; font-family: ${fontFamily}; ` + `font-size: ${fontSize}px; font-weight: bold; text-align: center;`);
        this._mmLabel.set_text(now.format("%M") ?? "");
        this._mmLabel.set_style(`color: ${colorMM}; font-family: ${fontFamily}; ` + `font-size: ${fontSize}px; font-weight: bold; text-align: center;`);
        this._ssLabel.set_text(now.format("%S") ?? "");
        this._ssLabel.set_style(`color: ${colorSS}; font-family: ${fontFamily}; ` + `font-size: ${fontSize}px; font-weight: bold; text-align: center;`);
    }
}