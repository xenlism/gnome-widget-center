import GLib from "gi://GLib";

import Soup from "gi://Soup?version=3.0";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

let _session = null;

function _getSession() {
    if (!_session) _session = new Soup.Session;
    return _session;
}

async function _geocode(keyword) {
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(keyword)}&count=6&language=en&format=json`;
    const message = Soup.Message.new("GET", url);
    if (!message) throw new Error(`invalid URL: ${url}`);
    const bytes = await _getSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()} for ${url}`);
    const text = new TextDecoder("utf-8").decode(bytes.get_data());
    const data = JSON.parse(text);
    return data.results ?? [];
}

function _placeLabel(result) {
    return result.admin1 && result.admin1 !== result.name ? `${result.name}, ${result.admin1}, ${result.country}` : `${result.name}, ${result.country}`;
}

function _locationValue(result) {
    return `${result.latitude.toFixed(5)},${result.longitude.toFixed(5)}`;
}

export async function searchPlace(keyword) {
    const results = await _geocode(keyword);
    return results.map(result => ({
        label: _placeLabel(result),
        value: _placeLabel(result),
        subtitle: _locationValue(result),
        fields: {
            location: _locationValue(result)
        }
    }));
}

export async function searchLocation(keyword) {
    const results = await _geocode(keyword);
    return results.map(result => ({
        label: _locationValue(result),
        value: _locationValue(result),
        subtitle: _placeLabel(result),
        fields: {
            place: _placeLabel(result)
        }
    }));
}