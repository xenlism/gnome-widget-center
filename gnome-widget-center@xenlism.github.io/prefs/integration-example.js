/**
 * prefs/integration-example.js
 *
 * How prefs.js wires everything together for one widget's settings.js.
 *
 * 2026-07-28: §6.3's builder is no longer dormant — prefs.js's
 * `_openWidgetSettingsJsPrefs()` now does exactly what this file
 * illustrates, for real, as the third rung of `_openWidgetPrefs()`'s
 * fallback chain (config.json > prefs.js > settings.js > legacy
 * metadata.json `settings` array). This file is kept as the short,
 * standalone version of that wiring for anyone reading WIDGET_API.md
 * §6.3 without wanting to dig through prefs.js's window-management
 * code — converted to plain ESM (previously `imports.gi`/`imports.lib.*`,
 * which never matched the ES-module syntax the rest of the shipped
 * extension actually uses).
 */

import {createGwcContext, validateSchema} from '../lib/settingsApi.js';
import {SettingsStore} from '../lib/settingsStore.js';
import {buildGroup} from '../lib/settingsRenderer.js';

/**
 * @param {string} widgetId
 * @param {(gwc: {settings: import('../lib/settingsApi.js').WidgetSettingsSchema}) => void} defineSettingsFn
 *   - a widget's own `settings.js`'s `defineSettings` export.
 * @param {import('gi://Adw').PreferencesPage} preferencesPage
 * @returns {{schema: object, store: SettingsStore, groups: Array}}
 */
export function buildWidgetSettingsGroup(widgetId, defineSettingsFn, preferencesPage) {
    // 1. Build the schema by calling the widget's defineSettings with a
    //    fresh, widget-scoped gwc context.
    const gwc = createGwcContext(widgetId);
    defineSettingsFn(gwc);
    const schema = gwc.settings.build();
    validateSchema(schema);

    // 2. Create/load the on-disk store for this widget, seeded with
    //    defaults from the schema.
    const store = new SettingsStore(widgetId, schema.fields);

    // 3. Render real GTK4/libadwaita rows, wired to the store.
    //    buildGroup() returns an ARRAY — one Adw.PreferencesGroup per
    //    .group('Title') section the widget declared (plus a fallback
    //    group for any ungrouped fields).
    const groups = buildGroup(schema, store, {
        title: 'Example Widget',
        description: 'Settings for the Example Widget instance',
    });

    for (const group of groups) {
        preferencesPage.add(group);
    }

    // Keep a reference so it can be destroyed when the prefs window closes
    // (releases the SettingsStore's Gio.FileMonitor — see its destroy()).
    return { schema, store, groups };
}

// Called from fillPreferencesWindow(window) in prefs.js:
//
//   const page = new Adw.PreferencesPage({ title: 'Widgets' });
//   buildWidgetSettingsGroup('example-widget', ExampleWidgetSettings.defineSettings, page);
//   window.add(page);
//
//   window.connect('close-request', () => {
//       // store.destroy() for every store created above
//   });
//
// The real prefs.js wiring does this per-subpage (open/close), not once
// for the whole window — see _openWidgetSettingsJsPrefs()'s doc comment.
