// widgets/weather-minimal/widget.js
//
// Minimal weather card - icon, condition text and temperature, stacked
// vertically (see icons/*.svg for the icon set, styled after
// https://github.com/konradmichalik/weather-iconic's naming conventions -
// the actual art here is original/placeholder, see icons/README.md).
//
// Data source: Open-Meteo (https://open-meteo.com) - free, no API key or
// signup required, per https://open-meteo.com/en/features#pricing.
//
// Location comes from the "location" setting (a "lat,lon" string, e.g.
// "13.756331,100.501762"), picked via config.json's "location"/"place"
// autocomplete fields (see WIDGET_API.md §6.4 and
// widgets/weather-minimal/autocomplete.js) - so widget.js itself never
// calls the geocoding API, only the forecast API
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

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// How often to re-fetch current weather from the network.
const REFRESH_SECONDS = 15 * 60;

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

export default class WeatherMinimalWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
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
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-widget-center', 'weather-minimal']));
    }

    // Must never throw, even with empty settings - getDefaultSettings()
    // below always backfills every key this widget reads, but the ??
    // fallbacks in _render() cost nothing and keep this widget robust on
    // its own too.
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'weather-minimal-widget-root',
            vertical: true,
        });

        this._iconBin = new St.Bin({style_class: 'weather-minimal-widget-icon'});
        this._conditionLabel = new St.Label({style_class: 'weather-minimal-widget-condition'});
        this._tempLabel = new St.Label({style_class: 'weather-minimal-widget-temp'});

        this._actor.add_child(this._iconBin);
        this._actor.add_child(this._conditionLabel);
        this._actor.add_child(this._tempLabel);

        this._render();
        this._refresh();
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
            place: 'Bangkok, Thailand',
            location: '13.756331,100.501762',

            cardColor: '#ffffff',
            cornerRadius: 18,

            iconColor: '#1a1a1a',
            iconSize: 64,

            conditionFont: 'Sans Bold 16',
            conditionColor: '#1a1a1a',

            tempFont: 'Sans Bold 34',
            tempColor: '#1a1a1a',
            tempUnit: 'celsius',
        };
    }

    // Cross-process live update: re-render immediately for anything
    // font/color/card related, and re-fetch if the location just changed
    // (picking a new place in the Location Picker shouldn't wait for the
    // next REFRESH_SECONDS tick). "place" itself is display-only in
    // settings - only "location" (the "lat,lon" pair) drives the fetch.
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
        const match = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(value.trim());
        if (!match)
            return null;

        const latitude = parseFloat(match[1]);
        const longitude = parseFloat(match[2]);
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)
            return null;

        return {latitude, longitude};
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
            this._api.logger.info(`weather-minimal: refresh failed: ${e}`);
            // Keep whatever _weather already holds (stale-but-present beats
            // blank); first-run failures leave it null and _render() below
            // shows a "--" placeholder instead.
        }

        this._render();
    }

    /** @private */
    _getColoredIconFile(iconKey, colorHex) {
        if (!this._iconDir)
            return null;

        const srcFile = this._iconDir.get_child(`${iconKey}.svg`);
        if (!srcFile.query_exists(null))
            return null;

        try {
            const safeColor = colorHex.replace(/[^#0-9a-fA-F]/g, '');
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
            this._api.logger.info(`weather-minimal: failed to recolor icon "${iconKey}": ${e}`);
            return srcFile;
        }
    }

    /** @private */
    _render() {
        const cardColor = this._settings.cardColor ?? '#ffffff';
        const cornerRadius = this._settings.cornerRadius ?? 18;
        const iconColor = this._settings.iconColor ?? '#1a1a1a';
        const iconSize = this._settings.iconSize ?? 64;
        const conditionColor = this._settings.conditionColor ?? '#1a1a1a';
        const tempColor = this._settings.tempColor ?? '#1a1a1a';
        const tempUnit = this._settings.tempUnit ?? 'celsius';

        const {family: conditionFontFamily, size: conditionFontSize} =
            _parseFontDescription(this._settings.conditionFont ?? 'Sans Bold 16', 'Sans Bold', 16);
        const {family: tempFontFamily, size: tempFontSize} =
            _parseFontDescription(this._settings.tempFont ?? 'Sans Bold 34', 'Sans Bold', 34);

        this._actor.set_style(
            `background-color: ${cardColor}; ` +
            `border-radius: ${cornerRadius}px; ` +
            'padding: 14px 14px; ' +
            'spacing: 6px;'
        );

        const iconKey = this._weather?.icon ?? 'weather-cloud';
        const iconFile = this._getColoredIconFile(iconKey, iconColor);
        if (iconFile) {
            const gicon = new Gio.FileIcon({file: iconFile});
            this._iconBin.set_child(new St.Icon({gicon, icon_size: iconSize}));
        } else {
            this._iconBin.set_child(null);
        }

        this._conditionLabel.set_text(this._weather?.condition ?? '--');
        this._conditionLabel.set_style(
            `color: ${conditionColor}; font-family: ${conditionFontFamily}; ` +
            `font-size: ${conditionFontSize}px; font-weight: bold; text-align: center;`
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
            `font-size: ${tempFontSize}px; font-weight: bold; text-align: center;`
        );
    }
}
