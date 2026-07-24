/**
 * prefs/integration-example.js
 *
 * How prefs.js wires everything together for one widget.
 * (Not a real file the engine loads — just a reference snippet.)
 */

'use strict';

const { GwcSettingsApi } = imports.lib.settingsApi;
const { GwcSettingsStore } = imports.lib.settingsStore;
const { GwcSettingsRenderer } = imports.prefs.settingsRenderer;
const { ExampleWidgetSettings } = imports.widgets['example-widget'].settings;

function buildWidgetSettingsGroup(widgetId, defineSettingsFn, preferencesPage) {
    // 1. Build the schema by calling the widget's defineSettings with a
    //    fresh, widget-scoped gwc context.
    const gwc = GwcSettingsApi.createGwcContext(widgetId);
    defineSettingsFn(gwc);
    const schema = gwc.settings.build();
    GwcSettingsApi.validateSchema(schema);

    // 2. Create/load the on-disk store for this widget, seeded with
    //    defaults from the schema.
    const store = new GwcSettingsStore.SettingsStore(widgetId, schema.fields);

    // 3. Render real GTK4/libadwaita rows, wired to the store.
    //    buildGroup() returns an ARRAY — one Adw.PreferencesGroup per
    //    .group('Title') section the widget declared (plus a fallback
    //    group for any ungrouped fields).
    const groups = GwcSettingsRenderer.buildGroup(schema, store, {
        title: 'Example Widget',
        description: 'Settings for the Example Widget instance',
    });

    for (const group of groups) {
        preferencesPage.add(group);
    }

    // Keep a reference so it can be destroyed when the prefs window closes.
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
