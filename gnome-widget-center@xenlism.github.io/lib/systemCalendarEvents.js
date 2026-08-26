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
            }
        }
        this._source?.destroy?.();
        this._source = null;
        this._changedId = null;
        this._initPromise = null;
    }
}
