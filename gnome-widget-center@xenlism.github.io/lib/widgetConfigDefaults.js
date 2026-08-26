import GLib from 'gi://GLib';
import {readWidgetConfig} from './widgetConfigReader.js';
import {getConfigDefaults} from './widgetConfigValidator.js';

export function configJsonDefaults(widgetJsUrl) {
    try {
        const widgetPath = GLib.path_get_dirname(GLib.filename_from_uri(widgetJsUrl)[0]);
        const {config} = readWidgetConfig(widgetPath);
        return getConfigDefaults(config);
    } catch (e) {
        return {};
    }
}
