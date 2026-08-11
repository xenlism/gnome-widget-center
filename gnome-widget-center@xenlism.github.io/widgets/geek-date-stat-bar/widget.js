import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Clutter from "gi://Clutter";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, TEXT_SHADOW_DEFAULTS, textShadowCss as _textShadowCss, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

export default class GeekDateStatBarWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
        this._metrics = new SystemMetricsService;
    }
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: "geek-date-stat-bar-widget-root",
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._dateLabel = new St.Label({
            style_class: "geek-date-stat-bar-widget-date",
            x_expand: true
        });
        this._statLabel = new St.Label({
            style_class: "geek-date-stat-bar-widget-stats",
            x_expand: true
        });
        this._actor.add_child(this._dateLabel);
        this._actor.add_child(this._statLabel);
        this._render();
        return this._actor;
    }
    enable() {
        this._logger.info("geek-date-stat-bar enabled");
        this._render();
        this._setupTimer();
    }
    disable() {
        this._logger.info("geek-date-stat-bar disabled");
        this._destroyTimer();
    }
    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...TEXT_SHADOW_DEFAULTS,
            textShadowEnabled: true,
            textShadowDistance: 2,
            textShadowBlur: 4,
            updateInterval: 2,
            diskPath: "/",
            dateFont: "Sans Bold 22",
            dateColor: "#ffffff",
            systemFont: "Sans Bold 12",
            systemColor: "#e6e6e6",
            backgroundColor: "#FFFFFF00",
            textAlign: "center",
            cornerRadius: 18,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS
        };
    }
    onSettingsChanged() {
        this._render();
        this._destroyTimer();
        this._setupTimer();
    }
    _setupTimer() {
        const interval = Math.max(1, this._settings.updateInterval ?? 2);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _destroyTimer() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }
    _getDiskUsage(path) {
        try {
            const file = Gio.File.new_for_path(path);
            const info = file.query_filesystem_info("filesystem::size,filesystem::free", null);
            const totalBytes = info.get_attribute_uint64("filesystem::size");
            const freeBytes = info.get_attribute_uint64("filesystem::free");
            const usedBytes = Math.max(0, totalBytes - freeBytes);
            const percent = totalBytes > 0 ? usedBytes / totalBytes * 100 : 0;
            return {
                percent: percent
            };
        } catch (e) {
            this._logger.info(`geek-date-stat-bar: could not read disk usage for ${path}: ${e}`);
            return {
                percent: 0
            };
        }
    }
    _render() {
        const now = GLib.DateTime.new_now_local();
        const {family: dateFontFamily, size: dateFontSize} = _parseFontDescription(this._settings.dateFont ?? "Sans Bold 22", "Sans Bold", 22);
        const {family: systemFontFamily, size: systemFontSize} = _parseFontDescription(this._settings.systemFont ?? "Sans Bold 12", "Sans Bold", 12);
        const dateColor = this._settings.dateColor ?? "#ffffff";
        const systemColor = this._settings.systemColor ?? "#e6e6e6";
        const textAlign = [ "left", "center", "right" ].includes(this._settings.textAlign) ? this._settings.textAlign : "center";
        const textShadowCss = _textShadowCss(this._settings);
        this._actor.set_style((this._api.resolveCardCss?.() ?? _cardStyleCss(this._settings, {
            cornerRadiusFallback: 18
        })) + "padding: 8px 18px; " + "spacing: 2px;");
        const dateText = (now.format("%d %B %Y") ?? "").toUpperCase();
        this._dateLabel.set_text(dateText);
        this._dateLabel.set_style(`color: ${dateColor}; font-family: ${dateFontFamily}; ` + `font-size: ${dateFontSize}px; font-weight: bold; text-align: ${textAlign}; ` + `${textShadowCss}`);
        const {cpu: cpu, memory: memory} = this._metrics.sample();
        const disk = this._getDiskUsage(this._settings.diskPath ?? "/");
        const statsText = `CPU ${Math.round(cpu.percent)}%   ` + `MEM ${Math.round(memory.percent)}%   ` + `DISK ${Math.round(disk.percent)}%`;
        this._statLabel.set_text(statsText);
        this._statLabel.set_style(`color: ${systemColor}; font-family: ${systemFontFamily}; ` + `font-size: ${systemFontSize}px; text-align: ${textAlign}; ` + `${textShadowCss}`);
    }
}