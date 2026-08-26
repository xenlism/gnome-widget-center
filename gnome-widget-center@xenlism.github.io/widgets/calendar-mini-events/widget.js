import St from "gi://St";

import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import { SHADOW_DEFAULTS, BLUR_DEFAULTS, BORDER_DEFAULTS, OPACITY_DEFAULTS, cardStyleCss, toCssColor, parseFontDescription } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle, applyCardBlur } from "../../lib/cardLayers.js";

import { SystemCalendarEvents } from "../../lib/systemCalendarEvents.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
export default class CalendarMiniEventsWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._calSource = null;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "calendar-mini-events-widget-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true
        });
        this._layers.content.add_child(this._content);

        this._weekdayLabel = new St.Label({ style_class: "calendar-mini-events-widget-weekday" });
        this._dayLabel = new St.Label({ style_class: "calendar-mini-events-widget-day" });
        this._eventsCol = new St.BoxLayout({ vertical: true });

        this._content.add_child(this._weekdayLabel);
        this._content.add_child(this._dayLabel);
        this._content.add_child(this._eventsCol);

        this._render();
        return this._actor;
    }

    enable() {
        this._calSource = new SystemCalendarEvents(() => this._render());
        this._calSource.init().then(() => this._render());

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
        this._calSource?.destroy();
        this._calSource = null;
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
            cornerRadiusFallback: 20
        }, false);
        this._content.set_style("padding: 14px; spacing: 8px;");

        const now = GLib.DateTime.new_now_local();
        const { family: weekFamily, size: weekSize } = parseFontDescription(s.weekFont ?? "Cantarell Bold 12", "Cantarell Bold", 12);
        const { family: dateFamily, size: dateSize } = parseFontDescription(s.dateFont ?? "Cantarell Bold 34", "Cantarell Bold", 34);

        this._weekdayLabel.set_text((now.format("%A") ?? "").toUpperCase());
        this._weekdayLabel.set_style(`color: ${s.weekTextColor ?? "#FF9F0A"}; font-family: ${weekFamily}; font-size: ${weekSize}px; font-weight: bold;`);

        this._dayLabel.set_text(`${now.get_day_of_month()}`);
        this._dayLabel.set_style(`color: ${s.dateTextColor ?? "#FFFFFF"}; font-family: ${dateFamily}; font-size: ${dateSize}px; font-weight: bold; margin-bottom: 4px;`);

        this._renderEvents(now);
    }

    _renderEvents(now) {
        const s = this._settings;
        this._eventsCol.destroy_all_children();
        const spacing = Number.isFinite(s.eventCardSpacing) ? s.eventCardSpacing : 8;
        this._eventsCol.set_style(`spacing: ${spacing}px;`);

        const events = this._calSource?.getEventsForDay(now) ?? [];
        const maxEvents = Number.isFinite(s.maxEvents) ? s.maxEvents : 3;
        const visible = events.slice(0, Math.max(1, maxEvents));

        if (visible.length === 0) {
            this._eventsCol.add_child(this._buildEventRow(s.noEventsText ?? "No events today", null));
            return;
        }

        for (const ev of visible) {
            const timeText = ev.allDay ? "All day" : `${ev.date?.format("%l:%M %p")?.trim() ?? ""} - ${ev.end?.format("%l:%M %p")?.trim() ?? ""}`;
            this._eventsCol.add_child(this._buildEventRow(ev.summary || "(untitled event)", timeText));
        }
    }

    _buildEventRow(title, timeText) {
        const s = this._settings;
        const { family: fontFamily, size: fontSize } = parseFontDescription(s.eventFont ?? "Cantarell 11", "Cantarell", 11);
        const bg = toCssColor(s.eventCardBgColor ?? "#2C2C2EFF", "#2C2C2EFF");
        const cornerRadius = Number.isFinite(s.eventCardCornerRadius) ? s.eventCardCornerRadius : 12;

        const rowOuter = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            x_expand: true,
            style: `background-color: ${bg}; border-radius: ${cornerRadius}px;`
        });
        if (s.eventCardBlurEnabled) {
            const inset = cornerRadius + 2;
            const rowBlurInset = new St.Widget({
                x_expand: true,
                y_expand: true,
                style: `background-color: ${bg}; margin: ${inset}px;`
            });
            applyCardBlur(rowBlurInset, {
                blurEnabled: true,
                blurRadius: Number.isFinite(s.eventCardBlurRadius) ? s.eventCardBlurRadius : 12
            });
            rowOuter.add_child(rowBlurInset);
        }

        const row = new St.BoxLayout({ vertical: false, x_expand: true, style: "padding: 6px 10px;" });
        rowOuter.add_child(row);

        const tab = new St.Widget({
            style: `background-color: ${s.tabColor ?? "#FF9F0A"}; border-radius: 3px; width: 3px;`,
            style_class: "calendar-mini-events-widget-tab",
            y_expand: true
        });
        row.add_child(tab);

        const textCol = new St.BoxLayout({ vertical: true, x_expand: true, style: "margin-left: 8px;" });
        if (timeText) {
            textCol.add_child(new St.Label({
                text: timeText,
                style: `color: ${s.eventTextColor ?? "#FFFFFF"}; font-family: ${fontFamily}; font-size: ${Math.max(9, fontSize - 1)}px; opacity: 0.7;`
            }));
        }
        textCol.add_child(new St.Label({
            text: title,
            style: `color: ${s.eventTextColor ?? "#FFFFFF"}; font-family: ${fontFamily}; font-size: ${fontSize}px;`
        }));
        row.add_child(textCol);

        return rowOuter;
    }
}
