import St from "gi://St";

import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import Pango from "gi://Pango";

import { SHADOW_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

// Hardcoded, no network access required (see WIDGET_API.md §3 - this
// widget never calls _fetchJson/Soup at all).
const QUOTES = [
    "Small steps, taken daily, outrun big plans taken never.",
    "Done is better than perfect - ship it, then improve it.",
    "The best time to start was yesterday. The next best time is now.",
    "Focus is choosing what to ignore.",
    "Discipline is remembering what you wanted.",
    "A calm mind sees more than a busy one.",
    "Progress hides inside boring, repeated effort.",
    "You don't need more time - you need fewer distractions.",
    "Every expert was once a beginner who kept going.",
    "Rest is part of the work, not a break from it.",
    "Clarity comes from action, not thought alone.",
    "Consistency beats intensity over the long run.",
    "Simplify first. Optimize later.",
    "What you practice, you become.",
    "Slow progress is still progress."
];

export default class DailyQuoteWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._quoteIndex = null;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "daily-quote-widget-root"
        });
        this._actor = this._layers.root;
        this._quoteLabel = new St.Label({
            text: "",
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        // Unlike most single-line labels in this codebase, a quote is
        // long enough that clipping it at the card edge (the usual
        // convention - see widgets/calendar-events/widget.js) would make
        // it unreadable, so this label wraps and centers instead.
        this._quoteLabel.clutter_text.set_line_wrap(true);
        this._quoteLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._quoteLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this._quoteLabel.clutter_text.set_justify(true);
        this._layers.content.add_child(this._quoteLabel);
        if (this._quoteIndex === null) this._quoteIndex = this._randomIndex();
        this._render();
        return this._actor;
    }
    enable() {
        this._restartTimer();
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
            ...SHADOW_DEFAULTS
        };
    }
    onSettingsChanged() {
        this._restartTimer();
        this._render();
    }
    _randomIndex() {
        if (QUOTES.length <= 1) return 0;
        let next = Math.floor(Math.random() * QUOTES.length);
        // Avoid repeating the same quote back-to-back when rotating.
        if (next === this._quoteIndex) next = (next + 1) % QUOTES.length;
        return next;
    }
    _restartTimer() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        const autoRotate = this._settings.autoRotate ?? true;
        if (!autoRotate) return;
        const minutesRaw = this._settings.refreshInterval;
        const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? minutesRaw : 30;
        const seconds = Math.max(60, Math.round(minutes * 60));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._quoteIndex = this._randomIndex();
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _render() {
        const fontSize = Number.isFinite(this._settings.fontSize) ? this._settings.fontSize : 18;
        const textColor = this._settings.textColor ?? "#ffffff";
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorKey: "backgroundColor",
            backgroundColorFallback: "#1c1f26F5",
            cornerRadiusFallback: 18
        }, false);
        this._layers.content.set_style("padding: 18px 24px;");
        const index = this._quoteIndex ?? 0;
        this._quoteLabel.set_text(QUOTES[index] ?? "");
        this._quoteLabel.set_style(`color: ${textColor}; font-size: ${fontSize}px; ` + "font-family: Sans; text-align: center;");
    }
}
