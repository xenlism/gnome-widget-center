import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Soup from "gi://Soup?version=3.0";

import { loadTranslations } from "./i18n/index.js";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, parseFontDescription as _parseFontDescription, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';

import { readTextFileAsync, writeTextFileAsync } from "../../lib/fsUtils.js";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const DEFAULT_REFRESH_MINUTES = 15;

function _describeWeather(code, isDay) {
    const day = isDay !== 0;
    switch (code) {
      case 0:
        return {
            icon: day ? "weather-sun" : "weather-moon",
            condition: "Clear"
        };

      case 1:
        return {
            icon: day ? "weather-sun" : "weather-moon",
            condition: "Mainly Clear"
        };

      case 2:
        return {
            icon: day ? "weather-cloud-sun" : "weather-cloud-moon",
            condition: "Partly Cloudy"
        };

      case 3:
        return {
            icon: "weather-cloud",
            condition: "Overcast"
        };

      case 45:
      case 48:
        return {
            icon: "weather-fog",
            condition: "Fog"
        };

      case 51:
      case 53:
      case 55:
        return {
            icon: "weather-cloud-drizzle",
            condition: "Drizzle"
        };

      case 56:
      case 57:
        return {
            icon: "weather-cloud-sleet",
            condition: "Freezing Drizzle"
        };

      case 61:
      case 63:
      case 65:
        return {
            icon: "weather-cloud-rain",
            condition: "Rain"
        };

      case 66:
      case 67:
        return {
            icon: "weather-cloud-sleet",
            condition: "Freezing Rain"
        };

      case 71:
      case 73:
      case 75:
        return {
            icon: "weather-cloud-snow",
            condition: "Snow"
        };

      case 77:
        return {
            icon: "weather-cloud-snow-fine",
            condition: "Snow Grains"
        };

      case 80:
      case 81:
      case 82:
        return {
            icon: day ? "weather-cloud-sun-rain" : "weather-cloud-rain",
            condition: "Rain Showers"
        };

      case 85:
      case 86:
        return {
            icon: day ? "weather-cloud-sun-snow" : "weather-cloud-snow",
            condition: "Snow Showers"
        };

      case 95:
        return {
            icon: "weather-cloud-lightning",
            condition: "Storm"
        };

      case 96:
      case 99:
        return {
            icon: "weather-cloud-lightning-hail",
            condition: "Storm (Hail)"
        };

      default:
        return {
            icon: "weather-wind",
            condition: "Unknown"
        };
    }
}

export default class WeatherPanelWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._armedRefreshMinutes = null;
        this._httpSession = null;
        this._coords = null;
        this._resolvedLocation = "";
        this._weather = null;
        this._iconDir = this._api.path?.me ? Gio.File.new_for_path(this._api.path.me).get_child("icons") : null;
        this._cacheDir = Gio.File.new_for_path(GLib.build_filenamev([ GLib.get_user_cache_dir(), "gnome-widget-center", "weather-panel" ]));
        this._translations = {};
    }
    _loadI18n() {
        if (!this._api.path?.me) return;
        loadTranslations(GLib.build_filenamev([ this._api.path.me, "i18n" ]), this._api.hostLanguage).then(translations => {
            this._translations = translations;
            this._render();
        }).catch(() => {});
    }
    onHostLanguageChanged() {
        this._loadI18n();
    }
    _trCondition(english) {
        const value = this._translations[`condition.${english}`];
        return typeof value === "string" && value.length > 0 ? value : english;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "weather-panel-widget-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true
        });
        this._layers.content.add_child(this._content);
        this._iconBin = new St.Bin({
            style_class: "weather-panel-widget-icon"
        });
        this._conditionLabel = new St.Label({
            style_class: "weather-panel-widget-condition"
        });
        this._tempLabel = new St.Label({
            style_class: "weather-panel-widget-temp"
        });
        this._content.add_child(this._iconBin);
        this._content.add_child(this._tempLabel);
        this._content.add_child(this._conditionLabel);
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
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            locationAutoDetected: false,
        };
    }
    onSettingsChanged() {
        this._render();
        if (Number(this._settings.refreshMinutes) !== this._armedRefreshMinutes) this._armRefreshTimer();
        const location = this._settings.location ?? "";
        if (location !== this._resolvedLocation) this._refresh();
    }
    _getHttpSession() {
        if (!this._httpSession) this._httpSession = new Soup.Session;
        return this._httpSession;
    }
    async _fetchJson(url) {
        const session = this._getHttpSession();
        const message = Soup.Message.new("GET", url);
        if (!message) throw new Error(`invalid URL: ${url}`);
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()} for ${url}`);
        const text = new TextDecoder("utf-8").decode(bytes.get_data());
        return JSON.parse(text);
    }
    _parseLocation(value) {
        const match = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(value.trim());
        if (!match) return null;
        const latitude = parseFloat(match[1]);
        const longitude = parseFloat(match[2]);
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
        return {
            latitude: latitude,
            longitude: longitude
        };
    }
    async _maybeAutoDetectLocation() {
        if (this._settings.locationAutoDetected) return;
        this._settings.locationAutoDetected = true;
        const location = this._settings.location ?? "";
        if (location && location !== "13.756331,100.501762") return;
        const coords = await this._fetchIpLocation();
        if (!coords) return;
        this._settings.location = `${coords.latitude},${coords.longitude}`;
        this._resolvedLocation = "";
        this._refresh();
    }
    async _fetchIpLocation() {
        const endpoints = [ {
            url: "https://freeipapi.com/api/json",
            parse: d => ({
                latitude: d.latitude,
                longitude: d.longitude
            })
        }, {
            url: "https://ipwhois.io/json/",
            parse: d => ({
                latitude: d.latitude,
                longitude: d.longitude
            })
        } ];
        for (const {url: url, parse: parse} of endpoints) {
            try {
                const data = await this._fetchJson(url);
                const {latitude: latitude, longitude: longitude} = parse(data) ?? {};
                if (typeof latitude === "number" && typeof longitude === "number" && Number.isFinite(latitude) && Number.isFinite(longitude)) return {
                    latitude: latitude,
                    longitude: longitude
                };
            } catch (e) {
                this._api.logger.info(`weather-panel: ip geolocation via ${url} failed: ${e}`);
            }
        }
        return null;
    }
    async _refresh() {
        const location = this._settings.location ?? "13.756331,100.501762";
        try {
            const coords = this._parseLocation(location);
            if (!coords) throw new Error(`invalid "location" setting: "${location}" (expected "lat,lon")`);
            this._coords = coords;
            this._resolvedLocation = location;
            const {latitude: latitude, longitude: longitude} = coords;
            const url = `${FORECAST_URL}?latitude=${latitude}&longitude=${longitude}` + "&current=temperature_2m,weather_code,is_day&timezone=auto";
            const data = await this._fetchJson(url);
            const current = data.current ?? {};
            const tempC = current.temperature_2m;
            const {icon: icon, condition: condition} = _describeWeather(current.weather_code, current.is_day ?? 1);
            this._weather = {
                tempC: tempC,
                tempF: typeof tempC === "number" ? tempC * 9 / 5 + 32 : null,
                icon: icon,
                condition: condition
            };
        } catch (e) {
            this._api.logger.info(`weather-panel: refresh failed: ${e}`);
        }
        this._render();
    }
    _normalizeHexColor(value) {
        const fallback = "#1a1a1a";
        if (typeof value !== "string") return fallback;
        const trimmed = value.trim();
        if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(trimmed)) return trimmed;
        const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
        if (match) {
            const toHex = n => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, "0");
            return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
        }
        return fallback;
    }
    _getColoredIconFile(iconKey, colorHex) {
        if (!this._iconDir) return null;
        const srcFile = this._iconDir.get_child(`${iconKey}.svg`);
        if (!srcFile.query_exists(null)) return null;
        const safeColor = this._normalizeHexColor(colorHex);
        const cacheFile = this._cacheDir.get_child(`${iconKey}-${safeColor.replace("#", "")}.svg`);
        if (cacheFile.query_exists(null)) return cacheFile;
        // Cache miss: recoloring means reading the source SVG and writing the
        // cached copy, both real file I/O. Do that off the main loop and fall
        // back to the plain (uncolored) icon for this render pass - once the
        // cache file lands, _render() runs again and this hits the
        // query_exists() cache-hit branch above like normal.
        this._recolorIconAsync(srcFile, cacheFile, safeColor, iconKey);
        return srcFile;
    }
    async _recolorIconAsync(srcFile, cacheFile, safeColor, iconKey) {
        const cachePath = cacheFile.get_path();
        if (!this._recoloring) this._recoloring = new Set;
        if (this._recoloring.has(cachePath)) return;
        this._recoloring.add(cachePath);
        try {
            const svgText = await readTextFileAsync(srcFile.get_path());
            if (svgText == null) return;
            const recolored = svgText.replaceAll("#000000", safeColor);
            GLib.mkdir_with_parents(this._cacheDir.get_path(), 448);
            await writeTextFileAsync(cachePath, recolored);
            this._render();
        } catch (e) {
            this._api.logger.info(`weather-panel: failed to recolor icon "${iconKey}": ${e}`);
        } finally {
            this._recoloring.delete(cachePath);
        }
    }
    _render() {
        const iconColor = this._settings.iconColor ?? "#ffffff";
        const iconSize = this._settings.iconSize ?? 48;
        const conditionColor = this._settings.conditionColor ?? "#e6e6e6";
        const tempColor = this._settings.tempColor ?? "#ffffff";
        const tempUnit = this._settings.tempUnit ?? "celsius";
        const {family: conditionFontFamily, size: conditionFontSize} = _parseFontDescription(this._settings.conditionFont ?? "Sans 14", "Sans", 14);
        const {family: tempFontFamily, size: tempFontSize} = _parseFontDescription(this._settings.tempFont ?? "Sans Bold 32", "Sans Bold", 32);
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorKey: "cardColor",
            cornerRadiusFallback: 18
        }, false);
        this._content.set_style("padding: 10px 14px; spacing: 4px;");
        const iconKey = this._weather?.icon ?? "weather-cloud";
        const iconFile = this._getColoredIconFile(iconKey, iconColor);
        if (iconFile) {
            const gicon = new Gio.FileIcon({
                file: iconFile
            });
            this._iconBin.set_child(new St.Icon({
                gicon: gicon,
                icon_size: iconSize
            }));
        } else {
            this._iconBin.set_child(null);
        }
        this._conditionLabel.set_text(this._weather ? this._trCondition(this._weather.condition) : "--");
        this._conditionLabel.set_style(`color: ${conditionColor}; font-family: ${conditionFontFamily}; ` + `font-size: ${conditionFontSize}px; text-align: center;`);
        let tempText = "--";
        if (this._weather) {
            const value = tempUnit === "fahrenheit" ? this._weather.tempF : this._weather.tempC;
            if (typeof value === "number") tempText = `${Math.round(value)}°`;
        }
        this._tempLabel.set_text(tempText);
        this._tempLabel.set_style(`color: ${tempColor}; font-family: ${tempFontFamily}; ` + `font-size: ${tempFontSize}px; text-align: center;`);
    }
}