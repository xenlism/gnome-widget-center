import GLib from "gi://GLib";

export const WEEKDAY_LABELS_SUN_START = [ "Su", "Mo", "Tu", "We", "Th", "Fr", "Sa" ];
export const WEEKDAY_LABELS_MON_START = [ "Mo", "Tu", "We", "Th", "Fr", "Sa", "Su" ];

export function buildMonthGrid(refDate, mondayStart = false) {
    const year = refDate.get_year();
    const month = refDate.get_month();
    const today = GLib.DateTime.new_now_local();
    const first = GLib.DateTime.new_local(year, month, 1, 0, 0, 0);
    const monthLabel = first.format("%B") ?? "";
    const daysInMonth = _daysInMonth(year, month);

    const firstDow = first.get_day_of_week();
    const leading = mondayStart ? firstDow - 1 : firstDow % 7;

    const prevDaysInMonth = _daysInMonth(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);

    const cells = [];
    for (let i = 0; i < leading; i++) {
        const day = prevDaysInMonth - leading + i + 1;
        cells.push({ day, inMonth: false, isToday: false, date: null });
    }
    for (let day = 1; day <= daysInMonth; day++) {
        const date = GLib.DateTime.new_local(year, month, day, 0, 0, 0);
        const isToday = date.get_year() === today.get_year() && date.get_month() === today.get_month() && date.get_day_of_month() === today.get_day_of_month();
        cells.push({ day, inMonth: true, isToday, date });
    }
    let trailingDay = 1;
    while (cells.length % 7 !== 0 || cells.length < 42) {
        cells.push({ day: trailingDay, inMonth: false, isToday: false, date: null });
        trailingDay++;
        if (cells.length >= 42) break;
    }

    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    return { year, month, monthLabel, weeks };
}

function _daysInMonth(year, month) {
    const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const lengths = [ 31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 ];
    return lengths[month - 1];
}

export function weekdayLabels(mondayStart = false) {
    return mondayStart ? WEEKDAY_LABELS_MON_START : WEEKDAY_LABELS_SUN_START;
}
