import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { ModalDialog } from "resource:///org/gnome/shell/ui/modalDialog.js";
import { SystemMetricsService } from "../../lib/systemMetricsApi.js";
import { parseFontDescription as _parseFontDescription, toCssColor as _toCssColor, textShadowCss as _textShadowCss } from "../../lib/widgetVisualKit.js";
import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";
import { readTextFile, writeJsonFile } from "../../lib/fsUtils.js";
import { createChildWidgetFromParent } from "../../lib/architectWidgetKit.js";

const CLOCK_FORMATS = {
    "HH:MM:SS": { 24: "%H:%M:%S", 12: "%I:%M:%S %p" },
    "HH:MM": { 24: "%H:%M", 12: "%I:%M %p" }
};
const LONG_DATE_FORMATS = {
    "DD MMM YYYY": "%d %b %Y",
    "MMM DD YYYY": "%b %d %Y",
    "DD MMMM YYYY": "%d %B %Y",
    "MMMM DD YYYY": "%B %d %Y"
};
const SHORT_DATE_FORMATS = {
    "DD-MM-YY": "%d-%m-%y",
    "MM-DD-YY": "%m-%d-%y",
    "DD-MMM-YY": "%d-%b-%y",
    "MMM-DD-YY": "%b-%d-%y"
};
const DAY_OF_WEEK_FORMATS = {
    DDD: "%a",
    DDDD: "%A"
};

const BLOCK_TYPE_PRESETS = [
    { id: "barx2", label: "Tiny 2", blockType: "barx2", fontOverrides: { line1Font: "Sans Bold 30", line2Font: "Sans 11", line3Font: "Sans 11", line3Enabled: false } },
    { id: "barx3", label: "Tiny 3", blockType: "barx3", fontOverrides: { line1Font: "Sans Bold 30", line2Font: "Sans 12", line3Font: "Sans 12" } },
    { id: "barx4", label: "Tiny 4", blockType: "barx4", fontOverrides: { line1Font: "Sans Bold 30", line2Font: "Sans 13", line3Font: "Sans 13" } },
    { id: "2x1", label: "Base 2x1", blockType: "2x1", fontOverrides: { line1Font: "Sans Bold 40", line2Font: "Sans Bold 16", line3Font: "Sans 14" } },
    { id: "3x1", label: "Bay 3x1", blockType: "3x1", fontOverrides: { line1Font: "Sans Bold 60", line2Font: "Sans Bold 16", line3Font: "Sans 14" } },
    { id: "4x1", label: "Big 4x1", blockType: "4x1", fontOverrides: { line1Font: "Sans Bold 60", line2Font: "Sans Bold 18", line3Font: "Sans 15" } }
];
const DEFAULT_PRESET_ID = "3x1";

export default class GeekStatClockWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
        this._metrics = new SystemMetricsService;
        this._metadata = JSON.parse(readTextFile(GLib.build_filenamev([ api.path.me, "metadata.json" ])));

        if (this._metadata.parent) this._addChild = undefined;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "geek-stat-clock-widget-root"
        });
        this._actor = this._layers.root;

        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true
        });
        this._layers.content.add_child(this._content);

        this._innerPad = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true
        });
        this._content.add_child(this._innerPad);

        this._line1 = new St.Label({ style_class: "geek-stat-clock-widget-line1", x_align: Clutter.ActorAlign.CENTER });
        this._line2 = new St.Label({ style_class: "geek-stat-clock-widget-line2", x_align: Clutter.ActorAlign.CENTER });
        this._line3 = new St.Label({ style_class: "geek-stat-clock-widget-line3", x_align: Clutter.ActorAlign.CENTER });
        this._innerPad.add_child(this._line1);
        this._innerPad.add_child(this._line2);
        this._innerPad.add_child(this._line3);

        this._render();
        return this._actor;
    }

    enable() {
        this._logger.info("geek-stat-clock enabled");
        this._render();
        this._setupTimer();
    }

    disable() {
        this._logger.info("geek-stat-clock disabled");
        this._destroyTimer();
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url)
        };
    }

    onSettingsChanged() {
        this._render();
        this._destroyTimer();
        this._setupTimer();
    }

    _setupTimer() {
        const interval = Math.max(1, Math.round(this._settings.updateInterval ?? 1));
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
            return { percent: totalBytes > 0 ? usedBytes / totalBytes * 100 : 0 };
        } catch (e) {
            this._logger.info(`geek-stat-clock: could not read disk usage for ${path}: ${e}`);
            return { percent: 0 };
        }
    }

    _formatRate(bytesPerSec) {
        const units = [ "B/s", "KB/s", "MB/s", "GB/s" ];
        let value = Math.max(0, Number.isFinite(bytesPerSec) ? bytesPerSec : 0);
        let i = 0;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i++;
        }
        const decimals = i > 0 && value < 10 ? 1 : 0;
        return `${value.toFixed(decimals)} ${units[i]}`;
    }

    _statText() {
        const { cpu: cpu, memory: memory, network: network } = this._metrics.sample();
        const disk = this._getDiskUsage(this._settings.diskPath ?? "/");
        const netDown = this._formatRate(network?.totalRxBytesPerSec ?? 0);
        const netUp = this._formatRate(network?.totalTxBytesPerSec ?? 0);
        return `CPU ${Math.round(cpu.percent)}%   ` + `MEM ${Math.round(memory.percent)}%   ` + `DISK ${Math.round(disk.percent)}%   ` + `NET ↓${netDown} ↑${netUp}`;
    }

    _sourceText(source, now) {
        switch (source) {
          case "clock":
            {
                const hourStyle = this._settings.hourStyle === "12" ? 12 : 24;
                const fmt = CLOCK_FORMATS[this._settings.clockFormat]?.[hourStyle] ?? CLOCK_FORMATS["HH:MM:SS"][24];
                return now.format(fmt) ?? "";
            }

          case "longDate":
            {
                const fmt = LONG_DATE_FORMATS[this._settings.longDateFormat] ?? LONG_DATE_FORMATS["DD MMM YYYY"];
                return (now.format(fmt) ?? "").toUpperCase();
            }

          case "shortDate":
            {
                const fmt = SHORT_DATE_FORMATS[this._settings.shortDateFormat] ?? SHORT_DATE_FORMATS["DD-MM-YY"];
                return now.format(fmt) ?? "";
            }

          case "dayOfWeek":
            {
                const fmt = DAY_OF_WEEK_FORMATS[this._settings.dayOfWeekFormat] ?? DAY_OF_WEEK_FORMATS.DDDD;
                return now.format(fmt) ?? "";
            }

          case "stat":
            return this._statText();

          default:
            return "";
        }
    }

    _renderLine(label, index, now) {
        const s = this._settings;
        const enabled = index === 1 || (s[`line${index}Enabled`] ?? true);
        if (!enabled) {
            label.hide();
            return;
        }
        label.show();
        const source = s[`line${index}Source`] ?? "clock";
        const { family: family, size: size } = _parseFontDescription(s[`line${index}Font`] ?? "Sans 16", "Sans", 16);
        const color = _toCssColor(s[`line${index}Color`], "#ffffffff");
        const textAlign = [ "left", "center", "right" ].includes(s.textAlign) ? s.textAlign : "center";
        const shadowCss = _textShadowCss({
            textShadowEnabled: s[`line${index}ShadowEnabled`],
            textShadowColor: s[`line${index}ShadowColor`],
            textShadowOpacity: s[`line${index}ShadowOpacity`],
            textShadowDistance: s[`line${index}ShadowDistance`],
            textShadowBlur: s[`line${index}ShadowBlur`]
        });
        label.set_text(this._sourceText(source, now));
        label.set_style(`color: ${color}; font-family: ${family}; ` + `font-size: ${size}px; text-align: ${textAlign}; ` + `${shadowCss}`);
    }

    _render() {
        if (!this._actor) return;
        applyLayeredCardStyle(this._layers, this._settings);
        this._innerPad.set_style("padding: 18px; " + `spacing: ${Math.max(0, Math.round(this._settings.lineSpacing ?? 6))}px;`);
        const now = GLib.DateTime.new_now_local();
        this._renderLine(this._line1, 1, now);
        this._renderLine(this._line2, 2, now);
        this._renderLine(this._line3, 3, now);
    }

    async _addChild() {
        const result = await this._promptChildOptions();
        if (!result) return;
        const preset = BLOCK_TYPE_PRESETS.find(p => p.id === result.presetId) ?? BLOCK_TYPE_PRESETS.find(p => p.id === DEFAULT_PRESET_ID);
        try {
            const { id: id, path: path } = createChildWidgetFromParent(this._api, this._metadata, result.name, {
                configOverrides: { ...preset.fontOverrides },
                rescan: false
            });
            this._patchChildBlockType(path, preset.blockType);
            this._api.host?.rescan?.();
            this._logger.info(`geek-stat-clock: created child "${id}" (${preset.blockType})`);
        } catch (e) {
            this._logger.error(`geek-stat-clock: failed to create child: ${e.message}`);
        }
    }

    _patchChildBlockType(childPath, blockType) {
        const metaPath = GLib.build_filenamev([ childPath, "metadata.json" ]);
        const meta = JSON.parse(readTextFile(metaPath));
        meta["block-type"] = blockType;
        writeJsonFile(metaPath, meta);
    }

    _promptChildOptions() {
        return new Promise(resolve => {
            const dialog = new ModalDialog({ styleClass: "geek-stat-clock-widget-dialog" });
            const entry = new St.Entry({
                style_class: "geek-stat-clock-widget-name-entry",
                style: "min-width: 260px;",
                hint_text: "Child name",
                can_focus: true
            });
            dialog.contentLayout.add_child(entry);
            const sizeLabel = new St.Label({
                style_class: "geek-stat-clock-widget-preset-label",
                style: "margin-top: 12px; margin-bottom: 4px; color: #cccccc;",
                text: "Size"
            });
            dialog.contentLayout.add_child(sizeLabel);
            const UNSELECTED_STYLE = "padding: 10px 14px; border-radius: 8px; color: #e6e6e6; background-color: rgba(255, 255, 255, 0.06);";
            const SELECTED_STYLE = "padding: 10px 14px; border-radius: 8px; color: #ffffff; background-color: rgba(90, 160, 255, 0.55); font-weight: bold;";
            const presetList = new St.BoxLayout({
                style_class: "geek-stat-clock-widget-preset-row",
                style: "spacing: 4px; margin-top: 2px;",
                vertical: true,
                x_expand: true
            });
            let selectedId = DEFAULT_PRESET_ID;
            const presetButtons = [];
            const refreshSelection = () => {
                for (const entry of presetButtons) {
                    entry.button.set_style(entry.preset.id === selectedId ? SELECTED_STYLE : UNSELECTED_STYLE);
                }
            };
            for (const preset of BLOCK_TYPE_PRESETS) {
                const btn = new St.Button({
                    style_class: "geek-stat-clock-widget-preset-button",
                    label: preset.label,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.START,
                    reactive: true,
                    can_focus: true,
                    track_hover: true
                });
                btn.connect("clicked", () => {
                    selectedId = preset.id;
                    refreshSelection();
                });
                presetList.add_child(btn);
                presetButtons.push({
                    preset: preset,
                    button: btn
                });
            }
            refreshSelection();
            dialog.contentLayout.add_child(presetList);
            let resolved = false;
            const finish = value => {
                if (resolved) return;
                resolved = true;
                dialog.close();
                resolve(value);
            };
            const finishFromEntry = () => {
                const name = entry.get_text()?.trim();
                finish(name ? {
                    name: name,
                    presetId: selectedId
                } : null);
            };
            dialog.setButtons([ {
                label: "Cancel",
                action: () => finish(null),
                key: Clutter.KEY_Escape
            }, {
                label: "Add",
                action: finishFromEntry,
                default: true
            } ]);
            entry.clutter_text.connect("activate", finishFromEntry);
            dialog.open();
        });
    }
}
