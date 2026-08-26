import St from "gi://St";

import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import { SHADOW_DEFAULTS, BLUR_DEFAULTS, BORDER_DEFAULTS, OPACITY_DEFAULTS, cardStyleCss, toCssColor, parseFontDescription } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle, applyCardBlur } from "../../lib/cardLayers.js";

import { buildMonthGrid, weekdayLabels } from "../../lib/calendarGridKit.js";

import { SystemCalendarEvents } from "../../lib/systemCalendarEvents.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
export default class CalendarEventsWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._calSource = null;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "calendar-events-widget-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: false
        });
        this._layers.content.add_child(this._content);

        this._calendarCol = new St.BoxLayout({ vertical: true, x_expand: true });
        this._headerLabel = new St.Label({ style_class: "calendar-events-widget-month" });
        this._weekHeaderRow = new St.BoxLayout({ vertical: false });
        this._gridBox = new St.BoxLayout({ vertical: true });
        this._calendarCol.add_child(this._headerLabel);
        this._calendarCol.add_child(this._weekHeaderRow);
        this._calendarCol.add_child(this._gridBox);

        this._eventsCol = new St.BoxLayout({ vertical: true, x_expand: true });

        this._content.add_child(this._calendarCol);
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
        this._content.set_style("padding: 14px; spacing: 14px;");

        this._renderCalendar();
        this._renderEvents();
    }

    _renderCalendar() {
        const s = this._settings;
        const mondayStart = !!s.mondayStart;
        const { family: fontFamily, size: fontSize } = parseFontDescription(s.calendarFont ?? "Cantarell 11", "Cantarell", 11);
        const now = GLib.DateTime.new_now_local();
        const grid = buildMonthGrid(now, mondayStart);

        this._headerLabel.set_text((grid.monthLabel ?? "").toUpperCase() + ` ${grid.year}`);
        this._headerLabel.set_style(`color: ${s.calendarTextColor ?? "#1A1A1A"}; font-family: ${fontFamily}; font-size: ${fontSize + 2}px; font-weight: bold; margin-bottom: 6px;`);

        this._weekHeaderRow.destroy_all_children();
        this._weekHeaderRow.set_style("spacing: 2px;");
        for (const label of weekdayLabels(mondayStart)) {
            this._weekHeaderRow.add_child(new St.Label({
                text: label,
                x_expand: true,
                style: `color: ${s.weekdayHeaderColor ?? "#8E8E93"}; font-family: ${fontFamily}; font-size: ${Math.max(9, fontSize - 2)}px; text-align: center; width: 22px;`
            }));
        }

        this._gridBox.destroy_all_children();
        this._gridBox.set_style("spacing: 2px;");
        for (const week of grid.weeks) {
            const row = new St.BoxLayout({ vertical: false, style: "spacing: 2px;" });
            for (const cell of week) {
                const isHighlighted = cell.inMonth && cell.isToday;
                const cellStyle = isHighlighted ? `color: ${s.highlightDayTextColor ?? "#FFFFFF"}; background-color: ${s.highlightDayColor ?? "#3B82F6"}; border-radius: 999px;` : `color: ${cell.inMonth ? s.calendarTextColor ?? "#1A1A1A" : (s.weekdayHeaderColor ?? "#8E8E93") + "80"};`;
                row.add_child(new St.Label({
                    text: `${cell.day}`,
                    x_expand: true,
                    style: `${cellStyle} font-family: ${fontFamily}; font-size: ${fontSize}px; text-align: center; width: 22px; height: 22px;`
                }));
            }
            this._gridBox.add_child(row);
        }
    }

    _renderEvents() {
        const s = this._settings;
        this._eventsCol.destroy_all_children();
        const spacing = Number.isFinite(s.eventCardSpacing) ? s.eventCardSpacing : 8;
        this._eventsCol.set_style(`spacing: ${spacing}px;`);

        const now = GLib.DateTime.new_now_local();
        const events = this._calSource?.getEventsForDay(now) ?? [];
        const maxEvents = Number.isFinite(s.maxEvents) ? s.maxEvents : 4;
        const visible = events.slice(0, Math.max(1, maxEvents));

        if (visible.length === 0) {
            this._eventsCol.add_child(this._buildEventCard(s.noEventsText ?? "No events today", null));
            return;
        }

        for (const ev of visible) {
            const timeText = ev.allDay ? "All day" : `${ev.date?.format("%l:%M %p")?.trim() ?? ""} - ${ev.end?.format("%l:%M %p")?.trim() ?? ""}`;
            this._eventsCol.add_child(this._buildEventCard(ev.summary || "(untitled event)", timeText));
        }
    }

    _buildEventCard(title, subtitle) {
        const s = this._settings;
        const { family: fontFamily, size: fontSize } = parseFontDescription(s.eventFont ?? "Cantarell 11", "Cantarell", 11);
        const bg = toCssColor(s.eventCardBgColor ?? "#FFFFFFFF", "#FFFFFFFF");
        const cornerRadius = Number.isFinite(s.eventCardCornerRadius) ? s.eventCardCornerRadius : 14;

        const cardOuter = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            x_expand: true,
            style: `background-color: ${bg}; border-radius: ${cornerRadius}px;`
        });
        if (s.eventCardBlurEnabled) {
            const inset = cornerRadius + 2;
            const cardBlurInset = new St.Widget({
                x_expand: true,
                y_expand: true,
                style: `background-color: ${bg}; margin: ${inset}px;`
            });
            applyCardBlur(cardBlurInset, {
                blurEnabled: true,
                blurRadius: Number.isFinite(s.eventCardBlurRadius) ? s.eventCardBlurRadius : 16
            });
            cardOuter.add_child(cardBlurInset);
        }

        const card = new St.BoxLayout({ vertical: true, x_expand: true, style: "padding: 8px 10px;" });
        cardOuter.add_child(card);
        const titleLabel = new St.Label({
            text: title,
            x_expand: true,
            style: `color: ${s.eventTextColor ?? "#1A1A1A"}; font-family: ${fontFamily}; font-size: ${fontSize}px; font-weight: bold;`
        });
        titleLabel.clutter_text.set_line_wrap(false);
        card.add_child(titleLabel);
        if (subtitle) {
            const subtitleLabel = new St.Label({
                text: subtitle,
                x_expand: true,
                style: `color: ${s.eventTextColor ?? "#1A1A1A"}; font-family: ${fontFamily}; font-size: ${Math.max(9, fontSize - 2)}px; opacity: 0.75;`
            });
            subtitleLabel.clutter_text.set_line_wrap(false);
            card.add_child(subtitleLabel);
        }
        return cardOuter;
    }
}
