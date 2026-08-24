// Thin, defensive wrapper around GNOME Shell's own calendar event source
// (js/ui/calendar.js's DBusEventSource - the same class Shell's built-in
// date/calendar popup uses to talk to the org.gnome.evolution.dataserver
// calendar-factory over D-Bus). Bundled widgets that want to show "today's
// events" should go through this helper rather than importing
// resource:///org/gnome/shell/ui/calendar.js directly, so a renamed/missing
// export on some Shell version degrades to "no events" instead of taking
// the whole widget down.
//
// Usage (inside a widget.js):
//   import { SystemCalendarEvents } from '../../lib/systemCalendarEvents.js';
//   this._cal = new SystemCalendarEvents(() => this._render());
//   await this._cal.init();      // call once, e.g. from enable()
//   const events = this._cal.getEventsForDay(GLib.DateTime.new_now_local());
//   this._cal.destroy();         // call from disable()

export class SystemCalendarEvents {
    constructor(onChanged) {
        this._onChanged = typeof onChanged === "function" ? onChanged : () => {};
        this._source = null;
        this._changedId = null;
        this._failed = false;
        this._initPromise = null;
    }

    get available() {
        return !!this._source && !this._failed;
    }

    async init() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
            try {
                const module = await import("resource:///org/gnome/shell/ui/calendar.js");
                const EventSourceCtor = module.DBusEventSource;
                if (!EventSourceCtor) throw new Error("DBusEventSource export not found");
                this._source = new EventSourceCtor();
                this._changedId = this._source.connect("changed", () => this._onChanged());
            } catch (e) {
                this._failed = true;
                this._source = null;
            }
        })();
        return this._initPromise;
    }

    /**
     * @param {GLib.DateTime} day
     * @returns {Array<{summary: string, allDay: boolean, date: GLib.DateTime, end: GLib.DateTime}>}
     */
    getEventsForDay(day) {
        if (!this.available || !day) return [];
        try {
            const begin = day.constructor.new_local ? day.constructor.new_local(day.get_year(), day.get_month(), day.get_day_of_month(), 0, 0, 0) : day;
            const end = begin.add_days(1);
            const events = this._source.getEvents(begin, end) ?? [];
            return events.map(ev => ({
                summary: ev.summary ?? "",
                allDay: !!ev.allDay,
                date: ev.date,
                end: ev.end
            })).sort((a, b) => (a.date && b.date ? a.date.to_unix() - b.date.to_unix() : 0));
        } catch (e) {
            return [];
        }
    }

    destroy() {
        if (this._source && this._changedId) {
            try {
                this._source.disconnect(this._changedId);
            } catch (e) {
                // already gone
            }
        }
        this._source?.destroy?.();
        this._source = null;
        this._changedId = null;
        this._initPromise = null;
    }
}
