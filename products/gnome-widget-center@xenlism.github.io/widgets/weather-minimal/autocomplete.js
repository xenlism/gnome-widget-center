// widgets/weather-minimal/autocomplete.js
//
// Search functions for this widget's two "autocomplete"-type config.json
// fields (see WIDGET_API.md §6.4's Autocomplete Field / Handover.md):
//
//   place    -> searchPlace(keyword)    e.g. "Bangkok, Thailand"
//   location -> searchLocation(keyword) e.g. "13.756331,100.501762"
//
// Both call the same free Open-Meteo geocoding endpoint
// (geocoding-api.open-meteo.com - no API key required) and differ only in
// which half of each geocoding hit becomes `label`/`value` vs the
// `fields` map used to fill the sibling field - see config.json's
// "fillsField" on each field, and widgetConfigUI.js's _autocompleteRow()
// for how `fields` gets applied.
//
// Runs in the prefs (GTK4) process - dynamically imported by
// widgetConfigUI.js, NOT by widget.js, so it has no `api` argument and no
// GNOME Shell (St/Clutter) access, only plain gi:// libraries.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

let _session = null;
function _getSession() {
    if (!_session)
        _session = new Soup.Session();
    return _session;
}

/** @private shared fetch, same pattern as widget.js's _fetchJson(). */
async function _geocode(keyword) {
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(keyword)}&count=6&language=en&format=json`;
    const message = Soup.Message.new('GET', url);
    if (!message)
        throw new Error(`invalid URL: ${url}`);

    const bytes = await _getSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    if (message.get_status() !== Soup.Status.OK)
        throw new Error(`HTTP ${message.get_status()} for ${url}`);

    const text = new TextDecoder('utf-8').decode(bytes.get_data());
    const data = JSON.parse(text);
    return data.results ?? [];
}

/** @private "Bangkok, Thailand" / "Nakhon Si Thammarat, Thailand" etc. */
function _placeLabel(result) {
    return result.admin1 && result.admin1 !== result.name
        ? `${result.name}, ${result.admin1}, ${result.country}`
        : `${result.name}, ${result.country}`;
}

/** @private "13.75633,100.50182" - fixed precision, matches this widget's location pattern. */
function _locationValue(result) {
    return `${result.latitude.toFixed(5)},${result.longitude.toFixed(5)}`;
}

/**
 * Backs the "place" field. Typing a city name suggests full "City,
 * Region, Country" strings; picking one also fills the sibling "location"
 * field with its resolved coordinates.
 * @param {string} keyword
 * @returns {Promise<Array<{label: string, value: string, subtitle: string, fields: object}>>}
 */
export async function searchPlace(keyword) {
    const results = await _geocode(keyword);
    return results.map(result => ({
        label: _placeLabel(result),
        value: _placeLabel(result),
        subtitle: _locationValue(result),
        fields: {location: _locationValue(result)},
    }));
}

/**
 * Backs the "location" field. Typing a city name (the natural way to
 * search for coordinates) suggests "lat,lon" values labeled with their
 * place name; picking one also fills the sibling "place" field.
 * @param {string} keyword
 * @returns {Promise<Array<{label: string, value: string, subtitle: string, fields: object}>>}
 */
export async function searchLocation(keyword) {
    const results = await _geocode(keyword);
    return results.map(result => ({
        label: _locationValue(result),
        value: _locationValue(result),
        subtitle: _placeLabel(result),
        fields: {place: _placeLabel(result)},
    }));
}
