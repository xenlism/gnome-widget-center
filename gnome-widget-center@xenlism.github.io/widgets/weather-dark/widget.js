// widgets/weather-dark/widget.js
//
// Wide dark weather card - big temperature + condition text on the left,
// weather icon on the right (see the reference mockup this was built
// from). Deliberately NOT a copy-paste of weather-minimal's vertical
// icon-on-top layout: this is a 21x10 block-type card (wide, short), so
// content runs horizontally instead. No date/day row at all (dropped per
// the design brief - "ไม่เอาวันที่", "don't include the date").
//
// Data source, WMO code table, and icon set are identical to
// weather-minimal/widget.js - see that file's header for the full
// rationale (Open-Meteo, libsoup3, icon recoloring via cached SVG text
// substitution). Kept as a second copy rather than a shared import
// because widgets are meant to be self-contained folders (see
// development/docs/WIDGET_API.md §1) - a widget only ever imports its
// own files, never another widget's.
//
// Centering fix: earlier layout attempts stacked children in a plain
// St.BoxLayout, which top/left-aligns by default and only looks
// "centered" by accident when a card's forced pixel size (from
// metadata['block-type'] x BlockSizeManager.BLOCK_CELL_SIZE - see
// blockSizeManager.js) happens to match the content's natural size. Any
// mismatch pushes the icon/text visibly too high or too low. Here the
// root actor is an St.Bin with `y_align: Clutter.ActorAlign.CENTER`,
// which re-centers its child every time regardless of the actor's
// allocated height - see buildActor() below.
//
// Bug fix (2026-07-28): this used to set x_align/y_align via `St.Align`
// (`.START`/`.MIDDLE`/`.END`), which was removed from GJS's St bindings
// years ago in favor of plain Clutter.ActorAlign (`St.Bin`/`St.BoxLayout`
// alignment properties have taken Clutter.ActorAlign values since
// GNOME 40) - `St.Align` is `undefined`, so `St.Align.START` threw a
// TypeError the instant buildActor() ran, and the widget never got past
// its very first line of layout code. That's why it showed up as the
// generic broken-widget placeholder (the crop-frame icon) instead of a
// weather card at all.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import {loadTranslations} from './i18n/index.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// How often to re-fetch current weather from the network.
const REFRESH_SECONDS = 15 * 60;

/**
 * WMO weather code -> {icon, condition}. Identical table to
 * weather-minimal/widget.js - see that file's _describeWeather() for the
 * full https://open-meteo.com/en/docs code reference this switches on.
 * @param {number} code
 * @param {number} isDay
 * @returns {{icon: string, condition: string}}
 */
function _describeWeather(code, isDay) {
    const day = isDay !== 0;

    switch (code) {
    case 0:
        return {icon: day ? 'weather-sun' : 'weather-moon', condition: 'Clear'};
    case 1:
        return {icon: day ? 'weather-sun' : 'weather-moon', condition: 'Mainly Clear'};
    case 2:
        return {icon: day ? 'weather-cloud-sun' : 'weather-cloud-moon', condition: 'Partly Cloudy'};
    case 3:
        return {icon: 'weather-cloud', condition: 'Overcast'};
    case 45:
    case 48:
        return {icon: 'weather-fog', condition: 'Fog'};
    case 51:
    case 53:
    case 55:
        return {icon: 'weather-cloud-drizzle', condition: 'Drizzle'};
    case 56:
    case 57:
        return {icon: 'weather-cloud-sleet', condition: 'Freezing Drizzle'};
    case 61:
    case 63:
    case 65:
        return {icon: 'weather-cloud-rain', condition: 'Rain'};
    case 66:
    case 67:
        return {icon: 'weather-cloud-sleet', condition: 'Freezing Rain'};
    case 71:
    case 73:
    case 75:
        return {icon: 'weather-cloud-snow', condition: 'Snow'};
    case 77:
        return {icon: 'weather-cloud-snow-fine', condition: 'Snow Grains'};
    case 80:
    case 81:
    case 82:
        return {icon: day ? 'weather-cloud-sun-rain' : 'weather-cloud-rain', condition: 'Rain Showers'};
    case 85:
    case 86:
        return {icon: day ? 'weather-cloud-sun-snow' : 'weather-cloud-snow', condition: 'Snow Showers'};
    case 95:
        return {icon: 'weather-cloud-lightning', condition: 'Storm'};
    case 96:
    case 99:
        return {icon: 'weather-cloud-lightning-hail', condition: 'Storm (Hail)'};
    default:
        return {icon: 'weather-wind', condition: 'Unknown'};
    }
}

/**
 * Splits a combined Pango font-description string into the family+size
 * pieces St's `set_style()` needs separately. Identical helper to
 * weather-minimal/widget.js - see there for the full rationale.
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

        desc.unset_fields(Pango.FontMask.SIZE);
        const family = desc.to_string().trim();

        return {family: family || fallbackFamily, size};
    } catch (e) {
        return {family: fallbackFamily, size: fallbackSize};
    }
}

export default class WeatherDarkWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._httpSession = null;

        this._coords = null; // {latitude, longitude}, parsed from settings.location
        this._resolvedLocation = ''; // the "lat,lon" string _coords came from
        this._weather = null; // {tempC, tempF, icon, condition}

        this._iconDir = this._api.path?.me
            ? Gio.File.new_for_path(this._api.path.me).get_child('icons')
            : null;
        this._cacheDir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-widget-center', 'weather-dark']));

        // i18n (2026-07-26) - see weather-minimal/widget.js's identical
        // comment on its own constructor for the full rationale.
        this._translations = {};
    }

    /** @private kicks off the (async) load of this widget's own i18n/ table, then re-renders once it resolves. */
    _loadI18n() {
        if (!this._api.path?.me)
            return;
        loadTranslations(GLib.build_filenamev([this._api.path.me, 'i18n'])).then(translations => {
            this._translations = translations;
            this._render();
        }).catch(() => {});
    }

    /** @private this._translations["condition.<english>"] if present, else `english` unchanged. */
    _trCondition(english) {
        const value = this._translations[`condition.${english}`];
        return typeof value === 'string' && value.length > 0 ? value : english;
    }

    buildActor() {
        // Root: St.Bin, not St.BoxLayout - see this file's header for why
        // this specific choice is what keeps content vertically centered
        // no matter the card's forced block-type pixel height.
        this._actor = new St.Bin({
            style_class: 'weather-dark-widget-root',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._content = new St.BoxLayout({vertical: false});
        this._actor.set_child(this._content);

        this._textBox = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._tempLabel = new St.Label({style_class: 'weather-dark-widget-temp'});
        this._conditionLabel = new St.Label({style_class: 'weather-dark-widget-condition'});
        this._textBox.add_child(this._tempLabel);
        this._textBox.add_child(this._conditionLabel);

        this._iconBin = new St.Bin({
            style_class: 'weather-dark-widget-icon',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._content.add_child(this._textBox);
        this._content.add_child(this._iconBin);

        this._render();
        this._refresh();
        this._loadI18n();
        this._maybeAutoDetectLocation().catch(() => {});
        return this._actor;
    }

    enable() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._httpSession = null;
    }

    getDefaultSettings() {
        return {
            location: '13.756331,100.501762',
            locationAutoDetected: false,

            cardColor: '#1c1f26',
            cornerRadius: 18,

            iconColor: '#f2b544',
            iconSize: 72,

            conditionFont: 'Sans 18',
            conditionColor: '#e6e6e6',

            tempFont: 'Sans Bold 40',
            tempColor: '#ffffff',
            tempUnit: 'celsius',
        };
    }

    // Cross-process live update - same pattern as weather-minimal.
    onSettingsChanged() {
        this._render();

        const location = this._settings.location ?? '';
        if (location !== this._resolvedLocation)
            this._refresh();
    }

    /** @private */
    _getHttpSession() {
        if (!this._httpSession)
            this._httpSession = new Soup.Session();
        return this._httpSession;
    }

    /** @private */
    async _fetchJson(url) {
        const session = this._getHttpSession();
        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new Error(`invalid URL: ${url}`);

        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()} for ${url}`);

        const text = new TextDecoder('utf-8').decode(bytes.get_data());
        return JSON.parse(text);
    }

    /**
     * Parses this widget's "location" setting - identical to
     * weather-minimal's _parseLocation().
     * @param {string} value
     * @returns {{latitude: number, longitude: number}|null}
     */
    _parseLocation(value) {
        const match = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(value.trim());
        if (!match)
            return null;

        const latitude = parseFloat(match[1]);
        const longitude = parseFloat(match[2]);
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)
            return null;

        return {latitude, longitude};
    }

    /**
     * @private One-time-only (gated by settings.locationAutoDetected):
     * if the user has never touched "location" (still whatever
     * getDefaultSettings() shipped), try to fill in a real default from
     * the user's approximate IP-based location instead of the hardcoded
     * Bangkok fallback. Tries each endpoint below in order and stops at
     * the first one that returns usable coordinates; failure of all
     * three just leaves the hardcoded default in place. Marks
     * locationAutoDetected = true regardless of outcome so this never
     * retries on every widget reload - see this._settings write below.
     *
     * Runs entirely from widget.js (the Shell process), same as this
     * widget's existing Open-Meteo calls - unlike the old "place"
     * autocomplete field, this isn't a prefs-page lookup, so it needs no
     * GTK/Adw and no per-keystroke UI at all.
     */
    async _maybeAutoDetectLocation() {
        if (this._settings.locationAutoDetected)
            return;
        this._settings.locationAutoDetected = true;

        const location = this._settings.location ?? '';
        if (location && location !== '13.756331,100.501762')
            return; // user (or a prior session) already set a real value

        const coords = await this._fetchIpLocation();
        if (!coords)
            return;

        this._settings.location = `${coords.latitude},${coords.longitude}`;
        this._resolvedLocation = ''; // force _refresh() to treat this as a change
        this._refresh();
    }

    /**
     * @private Tries, in order: ip-api.com, freeipapi.com, ipwhois.io.
     * Each is a free, no-API-key IP-geolocation lookup that resolves the
     * caller's own public IP server-side - no argument needed.
     * @returns {Promise<{latitude: number, longitude: number}|null>}
     */
    async _fetchIpLocation() {
        const endpoints = [
            {url: 'http://ip-api.com/json/', parse: d => ({latitude: d.lat, longitude: d.lon})},
            {url: 'https://freeipapi.com/api/json', parse: d => ({latitude: d.latitude, longitude: d.longitude})},
            {url: 'https://ipwhois.io/json/', parse: d => ({latitude: d.latitude, longitude: d.longitude})},
        ];

        for (const {url, parse} of endpoints) {
            try {
                const data = await this._fetchJson(url);
                const {latitude, longitude} = parse(data) ?? {};
                if (typeof latitude === 'number' && typeof longitude === 'number' &&
                    Number.isFinite(latitude) && Number.isFinite(longitude))
                    return {latitude, longitude};
            } catch (e) {
                this._api.logger.info(`weather-dark: ip geolocation via ${url} failed: ${e}`);
            }
        }
        return null;
    }

    /** @private */
    async _refresh() {
        const location = this._settings.location ?? '13.756331,100.501762';

        try {
            const coords = this._parseLocation(location);
            if (!coords)
                throw new Error(`invalid "location" setting: "${location}" (expected "lat,lon")`);

            this._coords = coords;
            this._resolvedLocation = location;

            const {latitude, longitude} = coords;
            const url = `${FORECAST_URL}?latitude=${latitude}&longitude=${longitude}` +
                '&current=temperature_2m,weather_code,is_day&timezone=auto';
            const data = await this._fetchJson(url);
            const current = data.current ?? {};

            const tempC = current.temperature_2m;
            const {icon, condition} = _describeWeather(current.weather_code, current.is_day ?? 1);

            this._weather = {
                tempC,
                tempF: typeof tempC === 'number' ? tempC * 9 / 5 + 32 : null,
                icon,
                condition,
            };
        } catch (e) {
            this._api.logger.info(`weather-dark: refresh failed: ${e}`);
            // Keep whatever _weather already holds - see weather-minimal's
            // _refresh() for the full rationale (stale-but-present beats
            // blank).
        }

        this._render();
    }

    /**
     * @private Accepts "#rrggbb"/"#rgb" as-is; also tolerates
     * "rgb(r,g,b)"/"rgba(r,g,b,a)" - see widgetConfigUI.js's _colorRow()
     * bug-fix note (2026-07-26) for why any settings.json saved by an
     * older Control Center build might contain that format.
     * @param {string} value
     * @returns {string} "#rrggbb", or the default icon color if unparseable
     */
    _normalizeHexColor(value) {
        const fallback = '#f2b544';
        if (typeof value !== 'string')
            return fallback;

        const trimmed = value.trim();
        if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(trimmed))
            return trimmed;

        const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
        if (match) {
            const toHex = n => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
            return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
        }

        return fallback;
    }

    /** @private */
    _getColoredIconFile(iconKey, colorHex) {
        if (!this._iconDir)
            return null;

        const srcFile = this._iconDir.get_child(`${iconKey}.svg`);
        if (!srcFile.query_exists(null))
            return null;

        try {
            const safeColor = this._normalizeHexColor(colorHex);
            const cacheFile = this._cacheDir.get_child(`${iconKey}-${safeColor.replace('#', '')}.svg`);
            if (cacheFile.query_exists(null))
                return cacheFile;

            const [, contents] = srcFile.load_contents(null);
            const svgText = new TextDecoder('utf-8').decode(contents);
            const recolored = svgText.replaceAll('#000000', safeColor);

            GLib.mkdir_with_parents(this._cacheDir.get_path(), 0o700);
            GLib.file_set_contents(cacheFile.get_path(), recolored);
            return cacheFile;
        } catch (e) {
            this._api.logger.info(`weather-dark: failed to recolor icon "${iconKey}": ${e}`);
            return srcFile;
        }
    }

    /** @private */
    _render() {
        const cardColor = this._settings.cardColor ?? '#1c1f26';
        const cornerRadius = this._settings.cornerRadius ?? 18;
        const iconColor = this._settings.iconColor ?? '#f2b544';
        const iconSize = this._settings.iconSize ?? 72;
        const conditionColor = this._settings.conditionColor ?? '#e6e6e6';
        const tempColor = this._settings.tempColor ?? '#ffffff';
        const tempUnit = this._settings.tempUnit ?? 'celsius';

        const {family: conditionFontFamily, size: conditionFontSize} =
            _parseFontDescription(this._settings.conditionFont ?? 'Sans 18', 'Sans', 18);
        const {family: tempFontFamily, size: tempFontSize} =
            _parseFontDescription(this._settings.tempFont ?? 'Sans Bold 40', 'Sans Bold', 40);

        this._actor.set_style(
            `background-color: ${cardColor}; ` +
            `border-radius: ${cornerRadius}px; ` +
            'padding: 20px 26px;'
        );
        this._content.set_style('spacing: 20px;');
        this._textBox.set_style('spacing: 4px;');

        const iconKey = this._weather?.icon ?? 'weather-cloud';
        const iconFile = this._getColoredIconFile(iconKey, iconColor);
        if (iconFile) {
            const gicon = new Gio.FileIcon({file: iconFile});
            this._iconBin.set_child(new St.Icon({gicon, icon_size: iconSize}));
        } else {
            this._iconBin.set_child(null);
        }

        let tempText = '--';
        if (this._weather) {
            const value = tempUnit === 'fahrenheit' ? this._weather.tempF : this._weather.tempC;
            if (typeof value === 'number')
                tempText = `${Math.round(value)}°`;
        }
        this._tempLabel.set_text(tempText);
        this._tempLabel.set_style(
            `color: ${tempColor}; font-family: ${tempFontFamily}; ` +
            `font-size: ${tempFontSize}px; font-weight: bold;`
        );

        this._conditionLabel.set_text(this._weather ? this._trCondition(this._weather.condition) : '--');
        this._conditionLabel.set_style(
            `color: ${conditionColor}; font-family: ${conditionFontFamily}; ` +
            `font-size: ${conditionFontSize}px;`
        );
    }
}
