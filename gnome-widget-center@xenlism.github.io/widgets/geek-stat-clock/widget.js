// widgets/geek-stat-clock/widget.js
//
// Architect Widget (see lib/architectWidgetKit.js / development docs:
// XTile Architecture) for the "Geek" series: an up-to-3-line card where
// each line independently shows a Clock, a Long date, a Short date, or
// a System stat readout. Line 1 is always on; lines 2 and 3 can each be
// turned off individually (lineNEnabled in config.json - there is no
// such field for line 1, it's permanent). This class is shared verbatim
// by every Child (config-only pattern, see child/widget.js) - the ONLY
// thing that differs between the Parent and any Child is config.json
// and metadata.json's block-type, never code.
//
// Card styling (background/corner-radius/border/opacity/shadow) is
// self-painted via applyLayeredCardStyle() in _render(), same as every
// other widget (there's no more "themeable" system pulling this from a
// global theme) — it just falls back to widgetVisualKit.js's built-in
// defaults for now since this widget has no Appearance fields of its
// own in config.json yet.
//
// Per-line text shadow deliberately has NO angle field anywhere in
// config.json - textShadowCss() (lib/widgetVisualKit.js) always pulls
// the shadow angle from the single global shadow-angle value, exactly
// like every card shadow does, so every shadow on the desktop points
// the same direction. Every OTHER text shadow property (enable/color/
// opacity/distance/blur) is still fully per-line.

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

// source -> GLib.DateTime.format() spec. Keyed exactly by config.json's
// dropdown option values so _sourceText() below never needs a second
// translation table.
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
    // DDD = abbreviated weekday ("Mon"), DDDD = full weekday ("Monday") -
    // same DDD/DDDD token convention as the long/short date dropdowns
    // above, just for a standalone weekday-only line.
    DDD: "%a",
    DDDD: "%A"
};

// "2 bar / 3 bar / big bar" block-type presets offered in the + Add
// Widget dialog (XTile Architecture §9-10's Child Name prompt, extended
// with a size choice). fontOverrides become the new Child's
// configOverrides (see createChildWidgetFromParent()) so a Bar-sized
// Child starts with smaller text than a Card-sized one instead of
// everyone inheriting the Parent's own defaults verbatim. Bar (2) also
// overrides line3Enabled:false, since a 2-line preset is meant to start
// with line 3 already off (the user can still turn it back on from the
// Child's own Settings page - this is only the created default).
const BLOCK_TYPE_PRESETS = [
    { id: "barx2", label: "Bar (2)", blockType: "barx2", fontOverrides: { line1Font: "Sans Bold 14", line2Font: "Sans 11", line3Font: "Sans 11", line3Enabled: false } },
    { id: "barx3", label: "Bar (3)", blockType: "barx3", fontOverrides: { line1Font: "Sans Bold 16", line2Font: "Sans 12", line3Font: "Sans 12" } },
    { id: "barx4", label: "Big Bar (4)", blockType: "barx4", fontOverrides: { line1Font: "Sans Bold 20", line2Font: "Sans 13", line3Font: "Sans 13" } },
    { id: "3x1", label: "Card (3)", blockType: "3x1", fontOverrides: { line1Font: "Sans Bold 28", line2Font: "Sans Bold 16", line3Font: "Sans 14" } },
    { id: "4x1", label: "Big Card (4)", blockType: "4x1", fontOverrides: { line1Font: "Sans Bold 36", line2Font: "Sans Bold 18", line3Font: "Sans 15" } }
];
const DEFAULT_PRESET_ID = "3x1";

export default class GeekStatClockWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
        this._metrics = new SystemMetricsService;
        // Read once here rather than via a JSON module import - see the
        // same pattern/rationale in widgets/_architect_template_/widget.js.
        this._metadata = JSON.parse(readTextFile(GLib.build_filenamev([ api.path.me, "metadata.json" ])));
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "geek-stat-clock-widget-root"
        });
        this._actor = this._layers.root;

        // R1: content always matches blocksize (createLayeredCard()
        // already wires the BindConstraint + clip_to_allocation for us
        // on this._layers.content, the outermost layer here).
        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            // No overflow, ever: this widget lets the user pick
            // arbitrarily large fonts per line, and a line's natural
            // (unclipped) height/width can exceed what's left inside
            // the card once padding + the other 1-2 lines take their
            // share. this._layers.content already clips at the card's
            // outer edge (R1/R4), but clip_to_allocation only clips
            // PAINT, not layout - an St.BoxLayout still hands each
            // non-expanding child its own natural request size even
            // when the sum exceeds what's available, so without a
            // clip here too, an oversized line's paint can bleed past
            // its own row and visually overlap a neighboring line
            // before ever reaching the card's outer edge. Clipping
            // right here as well means any part of ANY line that
            // doesn't fit is simply cut off (never ellipsis, never
            // spilling into another line or past the card) regardless
            // of how large the chosen font is.
            clip_to_allocation: true
        });
        this._layers.content.add_child(this._content);

        // R5: padding/spacing lives on a child wrapper, not on _content
        // itself. Same "no overflow" reasoning as above - clipped too.
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

        // Only the top-level Architect (no "parent" field in its own
        // metadata.json) offers "+ Add Widget" - a generated Child runs
        // this exact same class (config-only pattern) but must not be
        // able to spawn grandchildren of its own.
        if (!this._metadata.parent) {
            this._addButton = new St.Button({
                style_class: "geek-stat-clock-widget-add-button",
                reactive: true,
                can_focus: true,
                track_hover: true,
                label: "+ Add Widget"
            });
            this._addButton.connect("clicked", () => this._addChild());
            this._innerPad.add_child(this._addButton);
        }

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
        // Default 1s (not the older geek-week-stat-*'s 2s) since a
        // Clock line showing HH:MM:SS needs per-second updates - the
        // user can raise it in Settings if every line on this instance
        // is a date/stat line that doesn't need second-level ticking.
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
        // Line 1 has no lineEnabled field at all (config.json) - it can
        // never be turned off. Lines 2/3 default to enabled (true) when
        // the field is simply absent (e.g. an older Child created
        // before this field existed).
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
        // Every text-shadow property here is per-line EXCEPT angle -
        // there is no lineNShadowAngle field in config.json at all;
        // textShadowCss() always resolves the angle from the shared
        // global Force Settings value (see widgetVisualKit.js).
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
        // Every widget always paints its own card now — this one never
        // had its own Appearance settings (background/corner-radius/
        // shadow/border/opacity), it relied on ThemeService for that
        // while themeable:true. Falls back to widgetVisualKit.js's
        // built-in card defaults until per-widget Appearance fields get
        // added to config.json (tracked for later, not blocking).
        applyLayeredCardStyle(this._layers, this._settings);
        this._innerPad.set_style("padding: 18px; " + `spacing: ${Math.max(0, Math.round(this._settings.lineSpacing ?? 6))}px;`);
        const now = GLib.DateTime.new_now_local();
        this._renderLine(this._line1, 1, now);
        this._renderLine(this._line2, 2, now);
        this._renderLine(this._line3, 3, now);
    }

    // widget_add_child() from XTile Architecture §9, extended with a
    // block-type/size choice (createChildWidgetFromParent() itself only
    // ever touches id/parent/name/config - it never picks a
    // block-type - so the chosen preset's block-type is patched into
    // the new Child's metadata.json separately, right after creation).
    async _addChild() {
        const result = await this._promptChildOptions();
        if (!result) return;
        const preset = BLOCK_TYPE_PRESETS.find(p => p.id === result.presetId) ?? BLOCK_TYPE_PRESETS.find(p => p.id === DEFAULT_PRESET_ID);
        try {
            const { id: id, path: path } = createChildWidgetFromParent(this._api, this._metadata, result.name, {
                configOverrides: { ...preset.fontOverrides },
                // Rescan once ourselves, after the block-type patch
                // below, so the Child is placed with its real size the
                // very first time it's discovered instead of briefly
                // appearing at the template's default 3x1 and resizing.
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

    // Minimal GNOME Shell modal prompt: Child Name + a vertical list of
    // preset buttons for the block-type/size choice (was a cramped
    // horizontal row before - see stylesheet.css's header comment for why
    // that row's CSS spacing never actually applied). Returns
    // {name, presetId} or null on Cancel/empty name - same shape
    // _addChild() above expects.
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
            // Vertical list, not a horizontal button row: widgets/geek-stat-clock/
            // stylesheet.css is documentation-only (this host doesn't load a
            // widget's stylesheet.css into the Shell theme context - see that
            // file's header comment), so every visual here has to be an inline
            // St style, not a CSS class/pseudo-class rule.
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
