// lib/widgetConfigDefaults.js
//
// Helper for bundled widgets' getDefaultSettings(). Reads the widget's own
// config.json and returns its {fieldId: default} map, so a widget's JS
// never has to duplicate a literal value that already lives in
// config.json.
//
// Only usable by bundled widgets (widgets/<id>/widget.js), which can
// import lib/*.js via a relative path - third-party widgets loaded from
// ~/.local/share/gnome-widget-center/widgets/ cannot reach this file
// (see CLAUDE.md "Architecture facts") and must keep declaring their
// own getDefaultSettings() literally.

import GLib from 'gi://GLib';
import {readWidgetConfig} from './widgetConfigReader.js';
import {getConfigDefaults} from './widgetConfigValidator.js';

/**
 * @param {string} widgetJsUrl - pass `import.meta.url` from the calling
 *   widget.js. Used only to locate that widget's own folder.
 * @returns {object} flattened {fieldId: default} map from config.json,
 *   or {} if the widget has no config.json / it fails to parse. Never
 *   throws - callers can always safely spread the result.
 */
export function configJsonDefaults(widgetJsUrl) {
    try {
        const widgetPath = GLib.path_get_dirname(GLib.filename_from_uri(widgetJsUrl)[0]);
        const {config} = readWidgetConfig(widgetPath);
        return getConfigDefaults(config);
    } catch (e) {
        return {};
    }
}
