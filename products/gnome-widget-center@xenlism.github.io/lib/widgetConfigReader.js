// products/extension/lib/widgetConfigReader.js
//
// Reads config.json for a widget. Does NOT import St/Clutter — safe for
// both the Shell process (extension.js/widgetLoader.js) and the Prefs
// process (prefs.js), same rule as widgetConfigValidator.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {validateConfig} from './widgetConfigValidator.js';

/**
 * @param {string} widgetPath - absolute path to the widget's folder
 * @returns {boolean} whether config.json exists on disk for this widget,
 *   without reading/parsing it — cheap existence check used to decide
 *   `hasConfigJson` for the widget list (prefsWidgetList.js) and
 *   WidgetLoader.discover().
 */
export function widgetHasConfigJson(widgetPath) {
    const configPath = GLib.build_filenamev([widgetPath, 'config.json']);
    return Gio.File.new_for_path(configPath).query_exists(null);
}

/**
 * Read and validate config.json for a widget.
 * @param {string} widgetPath - absolute path to widget folder
 * @returns {{config: object|null, errors: Array<{message: string}>}}
 *   `config` is null if the file doesn't exist, can't be parsed, or fails
 *   validateConfig() — `errors` explains why in the last two cases (empty
 *   array + null config just means "no config.json here", not an error).
 */
export function readWidgetConfig(widgetPath) {
    const configPath = GLib.build_filenamev([widgetPath, 'config.json']);
    const configFile = Gio.File.new_for_path(configPath);

    if (!configFile.query_exists(null))
        return {config: null, errors: []};

    let contents;
    try {
        const [success, bytes] = configFile.load_contents(null);
        if (!success)
            return {config: null, errors: [{message: 'Failed to read config.json'}]};
        contents = new TextDecoder().decode(bytes);
    } catch (e) {
        return {config: null, errors: [{message: `Failed to read config.json: ${e.message}`}]};
    }

    let parsed;
    try {
        parsed = JSON.parse(contents);
    } catch (e) {
        return {config: null, errors: [{message: `Failed to parse config.json: ${e.message}`}]};
    }

    const errors = validateConfig(parsed);
    if (errors.length > 0)
        return {config: null, errors};

    return {config: parsed, errors: []};
}
