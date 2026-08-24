import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Clutter from "gi://Clutter";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, TEXT_SHADOW_DEFAULTS, textShadowCss as _textShadowCss, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
export default class GeekWeekStatBigWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
        this._metrics = new SystemMetricsService;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "geek-week-stat-big-widget-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._layers.content.add_child(this._content);
        this._topLabel = new St.Label({
            style_class: "geek-week-stat-big-widget-top",
            x_expand: true
        });
        this._bottomLabel = new St.Label({
            style_class: "geek-week-stat-big-widget-bottom",
            x_expand: true
        });
        this._content.add_child(this._topLabel);
        this._content.add_child(this._bottomLabel);
        this._render();
        return this._actor;
    }
    enable() {
        this._logger.info("geek-week-stat-big enabled");
        this._render();
        this._setupTimer();
    }
    disable() {
        this._logger.info("geek-week-stat-big disabled");
        this._destroyTimer();
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...TEXT_SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
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
            this._logger.info(`geek-week-stat-big: could not read disk usage for ${path}: ${e}`);
            return {
                percent: 0
            };
        }
    }
    _render() {
        const now = GLib.DateTime.new_now_local();
        const {family: weekFontFamily, size: weekFontSize} = _parseFontDescription(this._settings.weekFont ?? "Sans Bold 44", "Sans Bold", 44);
        const {family: systemFontFamily, size: systemFontSize} = _parseFontDescription(this._settings.systemFont ?? "Sans Bold 20", "Sans Bold", 20);
        const weekColor = this._settings.weekColor ?? "#ffffff";
        const systemColor = this._settings.systemColor ?? "#e6e6e6";
        const textAlign = [ "left", "center", "right" ].includes(this._settings.textAlign) ? this._settings.textAlign : "center";
        const textShadowCss = _textShadowCss(this._settings);
        const {cpu: cpu, memory: memory} = this._metrics.sample();
        const disk = this._getDiskUsage(this._settings.diskPath ?? "/");
        const statsText = `CPU ${Math.round(cpu.percent)}%   ` + `MEM ${Math.round(memory.percent)}%   ` + `DISK ${Math.round(disk.percent)}%`;
        applyLayeredCardStyle(this._layers, this._settings, {
            cornerRadiusFallback: 18
        }, false);
        this._content.set_style("padding: 20px 28px; " + "spacing: 8px;");
        const topText = (now.format(this._settings.weekFormat === "DDD" ? "%a" : "%A") ?? "").toUpperCase();
        this._topLabel.set_text(topText);
        this._topLabel.set_style(`color: ${weekColor}; font-family: ${weekFontFamily}; ` + `font-size: ${weekFontSize}px; font-weight: bold; text-align: ${textAlign}; ` + `${textShadowCss}`);
        this._bottomLabel.set_text(statsText);
        this._bottomLabel.set_style(`color: ${systemColor}; font-family: ${systemFontFamily}; ` + `font-size: ${systemFontSize}px; text-align: ${textAlign}; ` + `${textShadowCss}`);
    }
}