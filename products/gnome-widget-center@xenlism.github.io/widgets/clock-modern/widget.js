// widgets/clock-modern/widget.js
//
// "Modern" vertical clock card, built from widgets/calendar-modern/widget.js
// (card shell + inline St `style` rendering, since - as documented there and
// in widgets/clock/stylesheet.css - the host does not yet load a widget's
// own stylesheet.css into the Shell's theme context) and
// widgets/clock/widget.js (timer/enable()/disable()/onSettingsChanged()
// pattern, 24h/12h formatting).
//
// Layout is 4 stacked rows, top to bottom:
//   AM/PM  (only shown in 12-hour mode)
//   HH
//   MM
//   SS
//
// HH/MM/SS always share one Pango font-description string ("Sans Bold
// 30" - face + point size together, see `font` in config.json and
// _parseFontDescription() below) but each has its own separate color
// (colorHH/colorMM/colorSS). AM/PM has its own separate font-description
// string (`ampmFont`) and its own separate color (colorAmPm).
//
// Storing one combined font string per role (rather than a family field
// + a size field) matches xenlism's own `showtime` extension's prefs.js,
// which stores its clock/date fonts as one GSettings string each via
// Gtk.FontButton and applies them with Pango's `font_desc=` markup
// attribute directly - no separate parsing needed on that side because
// it renders through Pango markup, not raw CSS. This widget instead
// paints with St's CSS-like `set_style()` (font-family/font-size as two
// separate properties, per WIDGET_API.md's inline-styling convention), so
// _parseFontDescription() below splits the one stored string back into
// those two pieces at render time using Pango.FontDescription itself
// (not string-splitting by hand) so anything Pango's parser accepts -
// quoted family names, "Bold Italic", etc - round-trips correctly.
//
// Optional "launch on click": if launchOnClick is on and desktopFilePath
// points at a valid .desktop file, a plain click (no modifier - Super+drag
// is reserved for repositioning, see lib/dragController.js) launches that
// app via Gio.DesktopAppInfo, the same way GNOME Shell itself launches
// .desktop entries (no shelling out to a raw command string).

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

/**
 * Splits a combined Pango font-description string ("Sans Bold 30") into
 * the two pieces this widget's CSS-style `set_style()` calls need
 * separately: a `font-family` value that still carries the face/style
 * words ("Sans Bold", not just "Sans" - matches how this widget's CSS has
 * always used a single descriptive face name rather than a strict
 * family+font-weight split) and a `font-size` pixel number.
 * @param {string} fontStr
 * @param {string} fallbackFamily
 * @param {number} fallbackSize
 * @returns {{family: string, size: number}}
 */
function _parseFontDescription(fontStr, fallbackFamily, fallbackSize) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr);
        const rawSize = desc.get_size();
        const size = rawSize > 0 ? Math.round(rawSize / Pango.SCALE) : fallbackSize;

        // Drop just the point-size field and re-serialize - whatever's
        // left (family + weight/style words Pango recognized) is exactly
        // what used to be typed into the old separate "font face" field.
        desc.unset_fields(Pango.FontMask.SIZE);
        const family = desc.to_string().trim();

        return {family: family || fallbackFamily, size};
    } catch (e) {
        return {family: fallbackFamily, size: fallbackSize};
    }
}

export default class ClockModernWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._buttonPressId = null;
    }

    // Must never throw, even with empty settings - getDefaultSettings()
    // below always backfills every key this widget reads before this runs,
    // but `??` fallbacks in _render()/_applyClickHandler() cost nothing and
    // keep this widget robust on its own too.
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'clock-modern-widget-root',
            vertical: true,
        });

        this._ampmLabel = new St.Label({style_class: 'clock-modern-widget-ampm'});
        this._hhLabel = new St.Label({style_class: 'clock-modern-widget-hh'});
        this._mmLabel = new St.Label({style_class: 'clock-modern-widget-mm'});
        this._ssLabel = new St.Label({style_class: 'clock-modern-widget-ss'});

        this._actor.add_child(this._ampmLabel);
        this._actor.add_child(this._hhLabel);
        this._actor.add_child(this._mmLabel);
        this._actor.add_child(this._ssLabel);

        this._render();
        this._applyClickHandler();
        return this._actor;
    }

    enable() {
        // Seconds are always shown, so this always ticks every second -
        // unlike widgets/clock, there's no "showSeconds off -> tick every
        // minute" option here.
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._removeClickHandler();
    }

    getDefaultSettings() {
        return {
            format24h: true,

            font: 'Sans Bold 30',
            ampmFont: 'Sans Bold 10',

            colorHH: '#1a1a1a',
            colorMM: '#1a1a1a',
            colorSS: '#1a1a1a',
            colorAmPm: '#d81f26',
            cardColor: '#ffffff',
            cornerRadius: 18,

            launchOnClick: false,
            desktopFilePath: '',
        };
    }

    // Cross-process live update (see widgets/clock/widget.js for the same
    // hook): re-render immediately so a font/color/format change made in
    // the Control Center shows up right away, and re-wire the click
    // handler in case launchOnClick/desktopFilePath just changed (mirrors
    // how widgets/clock re-wires its timer when showSeconds changes).
    onSettingsChanged() {
        this._render();
        this._applyClickHandler();
    }

    /** @private */
    _applyClickHandler() {
        this._removeClickHandler();

        const launchOnClick = this._settings.launchOnClick ?? false;
        const desktopFilePath = this._settings.desktopFilePath ?? '';
        if (!launchOnClick || !desktopFilePath)
            return;

        // Layer leaves actors non-reactive by default (see
        // lib/widgetLayer.js init()); opt in here the same way
        // lib/dragController.js does before connecting its own
        // button-press-event handler on the same actor. Both handlers can
        // coexist: dragController only consumes the event when Super is
        // held (a drag), so a plain click still reaches this handler.
        this._actor.reactive = true;
        this._buttonPressId = this._actor.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            if (event.get_state() & Clutter.ModifierType.MOD4_MASK)
                return Clutter.EVENT_PROPAGATE; // Super held - let dragController handle it

            this._launchApp();
            return Clutter.EVENT_STOP;
        });
    }

    /** @private */
    _removeClickHandler() {
        if (this._buttonPressId !== null) {
            this._actor.disconnect(this._buttonPressId);
            this._buttonPressId = null;
        }
    }

    /** @private */
    _launchApp() {
        const desktopFilePath = this._settings.desktopFilePath ?? '';
        if (!desktopFilePath)
            return;

        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(desktopFilePath);
            if (!appInfo) {
                this._api.logger.info(`clock-modern: could not read .desktop file at ${desktopFilePath}`);
                return;
            }
            appInfo.launch([], null);
        } catch (e) {
            this._api.logger.info(`clock-modern: failed to launch ${desktopFilePath}: ${e}`);
        }
    }

    /** @private */
    _render() {
        const now = GLib.DateTime.new_now_local();

        const format24h = this._settings.format24h ?? true;
        const {family: fontFamily, size: fontSize} =
            _parseFontDescription(this._settings.font ?? 'Sans Bold 30', 'Sans Bold', 30);
        const {family: ampmFontFamily, size: ampmFontSize} =
            _parseFontDescription(this._settings.ampmFont ?? 'Sans Bold 10', 'Sans Bold', 10);
        const colorHH = this._settings.colorHH ?? '#1a1a1a';
        const colorMM = this._settings.colorMM ?? '#1a1a1a';
        const colorSS = this._settings.colorSS ?? '#1a1a1a';
        const colorAmPm = this._settings.colorAmPm ?? '#d81f26';
        const cardColor = this._settings.cardColor ?? '#ffffff';
        const cornerRadius = this._settings.cornerRadius ?? 18;

        this._actor.set_style(
            `background-color: ${cardColor}; ` +
            `border-radius: ${cornerRadius}px; ` +
            'padding: 12px 12px; ' +
            'spacing: 0px;'
        );

        if (format24h) {
            this._ampmLabel.hide();
        } else {
            this._ampmLabel.show();
            const hour = now.get_hour();
            this._ampmLabel.set_text(hour < 12 ? 'am' : 'pm');
            this._ampmLabel.set_style(
                `color: ${colorAmPm}; font-family: ${ampmFontFamily}; ` +
                `font-size: ${ampmFontSize}px; font-weight: bold; text-align: center;`
            );
        }

        let hourText;
        if (format24h) {
            hourText = now.format('%H') ?? '';
        } else {
            let h12 = now.get_hour() % 12;
            if (h12 === 0)
                h12 = 12;
            hourText = String(h12).padStart(2, '0');
        }

        this._hhLabel.set_text(hourText);
        this._hhLabel.set_style(
            `color: ${colorHH}; font-family: ${fontFamily}; ` +
            `font-size: ${fontSize}px; font-weight: bold; text-align: center;`
        );

        this._mmLabel.set_text(now.format('%M') ?? '');
        this._mmLabel.set_style(
            `color: ${colorMM}; font-family: ${fontFamily}; ` +
            `font-size: ${fontSize}px; font-weight: bold; text-align: center;`
        );

        this._ssLabel.set_text(now.format('%S') ?? '');
        this._ssLabel.set_style(
            `color: ${colorSS}; font-family: ${fontFamily}; ` +
            `font-size: ${fontSize}px; font-weight: bold; text-align: center;`
        );
    }
}
