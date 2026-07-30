// widgets/weather-panel/widget.js
//
// Weather card - icon, big temperature, and condition text, stacked
// vertically inside a rounded card (see icons/*.svg for the icon set,
// styled after https://github.com/konradmichalik/weather-iconic and
// https://github.com/erikflowers/weather-icons's naming conventions -
// the actual art here is original/placeholder, see icons/README.md).
// Same visual family as weather-minimal/weather-dark, but adds three
// things those don't have: a user-configurable refresh rate
// ("refreshMinutes"), an alpha-enabled background color (drag the
// color dialog's alpha slider for a translucent/transparent card), and
// a "Detect automatically" switch that re-runs IP-based auto-detect on
// demand (see _maybeAutoDetectLocation()/onSettingsChanged() below)
// rather than only on first run.
//
// Data source: Open-Meteo (https://open-meteo.com) - free, no API key or
// signup required, per https://open-meteo.com/en/features#pricing.
//
// Location comes from the "location" setting (a "lat,lon" string, e.g.
// "13.756331,100.501762"), a plain validated text field in config.json
// (see WIDGET_API.md §6.4) - matching weather-dark/weather-minimal's
// 2026-07-29 fix (see PROJECT_STATUS.md): an earlier "Place" autocomplete
// field silently didn't persist typed text unless you clicked a
// suggestion, so all three widgets now just use "location" directly.
// widget.js calls only the forecast API
// (api.open-meteo.com/v1/forecast?current=...), which returns a WMO
// weather code (0-99) + temperature + is_day for that lat/lon.
//
// WMO code -> {icon, condition text} mapping lives in _describeWeather()
// below - see https://open-meteo.com/en/docs for the full code table.
//
// Networking uses libsoup3 (Soup.Session.send_and_read_async), the
// standard HTTP client for GNOME Shell extensions in this GJS/ESM
// generation - see https://gjs.guide/extensions/overview/architecture.html.
// Every request is wrapped in try/catch; a failed fetch leaves the last
// good render on screen (or shows a "--" placeholder on first run)
// instead of throwing.
//
// Icon recoloring: the SVGs in icons/ ship with a literal `fill="#000000"`
// placeholder. At render time _getColoredIconFile() does a plain text
// substitution of that placeholder for the user's chosen iconColor and
// writes the result to a small cache file under
// GLib.get_user_cache_dir(), then points an St.Icon at that file via
// Gio.FileIcon - the standard way to show a dynamically-colored raster/
// vector icon from St without a symbolic-icon-theme lookup.

import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import {loadTranslations} from './i18n/index.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// Fallback refresh interval (minutes) if "refreshMinutes" is ever missing
// or out of the config.json dropdown's range - matches its default.
const DEFAULT_REFRESH_MINUTES = 15;

/**
 * WMO weather code -> {icon, condition}. See
 * https://open-meteo.com/en/docs for the full code table this switches
 * on. `isDay` (1/0 from the API's `is_day` field) picks the day/night
 * icon variant where one exists.
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
 * clock-modern/widget.js and date-modern/widget.js - see either for the
 * full rationale.
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

export default class WeatherPanelWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._armedRefreshMinutes = null;
        this._httpSession = null;

        // Last parsed location + fetched weather, kept around so a render
        // can happen immediately from cache while a refresh is in flight,
        // and so a failed refresh doesn't blank out a previously good
        // reading.
        this._coords = null; // {latitude, longitude}, parsed from settings.location
        this._resolvedLocation = ''; // the "lat,lon" string _coords came from
        this._weather = null; // {tempC, tempF, icon, condition}

        this._iconDir = this._api.path?.me
            ? Gio.File.new_for_path(this._api.path.me).get_child('icons')
            : null;
        this._cacheDir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-widget-center', 'weather-panel']));

        // i18n (2026-07-26): translates the condition text this widget
        // itself generates at runtime (_describeWeather()'s "Clear",
        // "Rain", etc - config.json's own labels/descriptions are
        // translated separately, by widgetConfigUI.js, using this same
        // i18n/ folder). Starts empty and fills in once the dynamic
        // import() resolves - see buildActor()'s call to _loadI18n().
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

    // Must never throw, even with empty settings - getDefaultSettings()
    // below always backfills every key this widget reads, but the ??
    // fallbacks in _render() cost nothing and keep this widget robust on
    // its own too.
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'weather-panel-widget-root',
            vertical: true,
        });

        this._iconBin = new St.Bin({style_class: 'weather-panel-widget-icon'});
        this._conditionLabel = new St.Label({style_class: 'weather-panel-widget-condition'});
        this._tempLabel = new St.Label({style_class: 'weather-panel-widget-temp'});

        this._actor.add_child(this._iconBin);
        this._actor.add_child(this._tempLabel);
        this._actor.add_child(this._conditionLabel);

        this._render();
        this._refresh();
        this._loadI18n();
        this._maybeAutoDetectLocation().catch(() => {});
        return this._actor;
    }

    enable() {
        this._armRefreshTimer();
    }

    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._httpSession = null;
    }

    /**
     * @private (Re)starts the refresh timer at the current
     * "refreshMinutes" setting. Safe to call whenever that setting
     * changes - always clears any previous timer first, so there's
     * never more than one in flight.
     */
    _armRefreshTimer() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        const minutes = Number(this._settings.refreshMinutes) || DEFAULT_REFRESH_MINUTES;
        this._armedRefreshMinutes = minutes;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    getDefaultSettings() {
        return {
            location: '13.756331,100.501762',
            locationAutoDetected: false,
            detectNow: false,

            refreshMinutes: DEFAULT_REFRESH_MINUTES,

            cardColor: '#000000ff',
            cornerRadius: 18,

            iconColor: '#ffffff',
            iconSize: 48,

            conditionFont: 'Sans 14',
            conditionColor: '#e6e6e6',

            tempFont: 'Sans Bold 32',
            tempColor: '#ffffff',
            tempUnit: 'celsius',
        };
    }

    // Cross-process live update: re-render immediately for anything
    // font/color/card related, re-fetch if the location just changed
    // (typing a new "location" shouldn't wait for the next scheduled
    // tick), re-arm the timer if the refresh rate changed, and honor a
    // manual "Detect automatically" toggle.
    onSettingsChanged() {
        this._render();

        if (this._settings.detectNow) {
            // Momentary-button pattern (same trick as
            // "locationAutoDetected" below): flip it straight back off so
            // this reads as an action, not a persistent state, then run
            // the same IP lookup _maybeAutoDetectLocation() uses on first
            // run - but unconditionally, since the user explicitly asked.
            this._settings.detectNow = false;
            this._fetchIpLocation().then(coords => {
                if (!coords)
                    return;
                this._settings.location = `${coords.latitude},${coords.longitude}`;
                this._resolvedLocation = '';
                this._refresh();
            }).catch(() => {});
        }

        if (Number(this._settings.refreshMinutes) !== this._armedRefreshMinutes)
            this._armRefreshTimer();

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
     * Parses this widget's "location" setting - a plain "lat,lon" string
     * (matching config.json's `pattern` for that field, and what the
     * Location Picker/autocomplete fields in the Control Center write) -
     * into {latitude, longitude}. Deliberately re-validates the range
     * even though config.json's pattern already constrains the general
     * shape, since a hand-edited settings file could still contain an
     * out-of-range pair the regex wouldn't catch (e.g. "95,200").
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
     * Identical to weather-dark/widget.js's method of the same name -
     * see that file for the full rationale.
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
                this._api.logger.info(`weather-panel: ip geolocation via ${url} failed: ${e}`);
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
            this._api.logger.info(`weather-panel: refresh failed: ${e}`);
            // Keep whatever _weather already holds (stale-but-present beats
            // blank); first-run failures leave it null and _render() below
            // shows a "--" placeholder instead.
        }

        this._render();
    }

    /**
     * @private Accepts "#rrggbb"/"#rgb" as-is; also tolerates
     * "rgb(r,g,b)"/"rgba(r,g,b,a)" (the format widgetConfigUI.js's
     * colorpicker saved before its 2026-07-26 bug fix — see that file's
     * _colorRow() comment) so a settings.json written by the old buggy
     * version still recolors correctly here without the user having to
     * reopen the color picker just to "re-save" it.
     * @param {string} value
     * @returns {string} "#rrggbb", or the 2026-07-25 default if unparseable
     */
    _normalizeHexColor(value) {
        const fallback = '#1a1a1a';
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
            this._api.logger.info(`weather-panel: failed to recolor icon "${iconKey}": ${e}`);
            return srcFile;
        }
    }

    /** @private */
    _render() {
        const cardColor = this._settings.cardColor ?? '#000000ff';
        const cornerRadius = this._settings.cornerRadius ?? 18;
        const iconColor = this._settings.iconColor ?? '#ffffff';
        const iconSize = this._settings.iconSize ?? 48;
        const conditionColor = this._settings.conditionColor ?? '#e6e6e6';
        const tempColor = this._settings.tempColor ?? '#ffffff';
        const tempUnit = this._settings.tempUnit ?? 'celsius';

        const {family: conditionFontFamily, size: conditionFontSize} =
            _parseFontDescription(this._settings.conditionFont ?? 'Sans 14', 'Sans', 14);
        const {family: tempFontFamily, size: tempFontSize} =
            _parseFontDescription(this._settings.tempFont ?? 'Sans Bold 32', 'Sans Bold', 32);

        this._actor.set_style(
            `background-color: ${cardColor}; ` +
            `border-radius: ${cornerRadius}px; ` +
            'padding: 10px 14px; ' +
            'spacing: 4px;'
        );

        const iconKey = this._weather?.icon ?? 'weather-cloud';
        const iconFile = this._getColoredIconFile(iconKey, iconColor);
        if (iconFile) {
            const gicon = new Gio.FileIcon({file: iconFile});
            this._iconBin.set_child(new St.Icon({gicon, icon_size: iconSize}));
        } else {
            this._iconBin.set_child(null);
        }

        this._conditionLabel.set_text(this._weather ? this._trCondition(this._weather.condition) : '--');
        this._conditionLabel.set_style(
            `color: ${conditionColor}; font-family: ${conditionFontFamily}; ` +
            `font-size: ${conditionFontSize}px; text-align: center;`
        );

        let tempText = '--';
        if (this._weather) {
            const value = tempUnit === 'fahrenheit' ? this._weather.tempF : this._weather.tempC;
            if (typeof value === 'number')
                tempText = `${Math.round(value)}°`;
        }
        this._tempLabel.set_text(tempText);
        this._tempLabel.set_style(
            `color: ${tempColor}; font-family: ${tempFontFamily}; ` +
            `font-size: ${tempFontSize}px; text-align: center;`
        );
    }
}
