import St from "gi://St";

import GLib from "gi://GLib";

import Clutter from "gi://Clutter";

import { SHADOW_DEFAULTS, BLUR_DEFAULTS, BORDER_DEFAULTS, OPACITY_DEFAULTS, cardStyleCss, parseFontDescription } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import { buildMonthGrid, weekdayLabels } from "../../lib/calendarGridKit.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
export default class CalendarPlainWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "calendar-plain-widget-root"
        });
        this._actor = this._layers.root;

        this._innerColumn = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._layers.content.add_child(this._innerColumn);

        this._headerRow = new St.BoxLayout({ vertical: false });
        this._monthLabel = new St.Label({ style_class: "calendar-plain-widget-month", x_expand: true });
        this._headerRow.add_child(this._monthLabel);

        this._weekHeaderRow = new St.BoxLayout({ vertical: false });
        this._gridBox = new St.BoxLayout({ vertical: true });

        this._innerColumn.add_child(this._headerRow);
        this._innerColumn.add_child(this._weekHeaderRow);
        this._innerColumn.add_child(this._gridBox);

        this._render();
        return this._actor;
    }

    enable() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BLUR_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
        };
    }

    onSettingsChanged() {
        this._render();
    }

    _render() {
        if (!this._actor) return;
        const s = this._settings;

        applyLayeredCardStyle(this._layers, s, {
            backgroundColorKey: "cardColor",
            cornerRadiusFallback: 24
        }, false);
        this._innerColumn.set_style("padding: 18px; spacing: 10px;");

        const mondayStart = !!s.mondayStart;
        const { family: fontFamily, size: fontSize } = parseFontDescription(s.calendarFont ?? "Cantarell 13", "Cantarell", 13);
        const now = GLib.DateTime.new_now_local();
        const grid = buildMonthGrid(now, mondayStart);

        this._monthLabel.set_text(`${grid.monthLabel ?? ""} ${grid.year}`);
        this._monthLabel.set_style(`color: ${s.monthHeaderColor ?? "#1A1A1A"}; font-family: ${fontFamily}; font-size: ${fontSize + 4}px; font-weight: bold;`);

        this._weekHeaderRow.destroy_all_children();
        this._weekHeaderRow.set_style("spacing: 4px;");
        for (const label of weekdayLabels(mondayStart)) {
            this._weekHeaderRow.add_child(new St.Label({
                text: label,
                x_expand: true,
                style: `color: ${s.weekdayHeaderColor ?? "#8E8E93"}; font-family: ${fontFamily}; font-size: ${fontSize}px; text-align: center; width: 30px;`
            }));
        }

        this._gridBox.destroy_all_children();
        this._gridBox.set_style("spacing: 4px;");
        for (const week of grid.weeks) {
            const row = new St.BoxLayout({ vertical: false, style: "spacing: 4px;" });
            for (const cell of week) {
                const isHighlighted = cell.inMonth && cell.isToday;
                let cellStyle;
                if (isHighlighted) {
                    cellStyle = `color: ${s.highlightDayTextColor ?? "#FFFFFF"}; background-color: ${s.highlightDayColor ?? "#FF3B30"}; border-radius: 999px;`;
                } else if (cell.inMonth) {
                    cellStyle = `color: ${s.calendarTextColor ?? "#1A1A1A"};`;
                } else {
                    cellStyle = `color: ${s.outOfMonthColor ?? "#C7C7CC"};`;
                }
                row.add_child(new St.Label({
                    text: `${cell.day}`,
                    x_expand: true,
                    style: `${cellStyle} font-family: ${fontFamily}; font-size: ${fontSize}px; text-align: center; width: 30px; height: 30px;`
                }));
            }
            this._gridBox.add_child(row);
        }
    }
}
