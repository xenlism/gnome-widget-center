// extension/prefs.js
//
// Task 05 — Control Center (Prefs GUI) entrypoint. GNOME Shell runs this
// in its own separate GTK4/libadwaita process, completely apart from
// extension.js's Shell process (docs/WIDGET_API.md §4) — this file, and
// everything it imports, must NEVER import St/Clutter/Meta/Shell.
//
// Responsibilities (tasks/05-prefs-control-center.md):
//   1. List every discovered widget (bundled + user), one Adw.SwitchRow
//      each, bound to the same `disabled-widgets` GSettings key
//      extension.js watches (see extension.js's onChanged() wiring) — so
//      toggling a row here takes effect on the desktop immediately, no
//      shell restart, even though this is a different process.
//   2. A "Settings" button per widget that HAS a prefs.js — dynamically
//      imports just that file (safe here, per widget author contract) and
//      embeds its buildPrefsWidget() as an Adw.PreferencesWindow subpage.
//   3. A separate error section for any widget whose metadata.json is
//      broken, so one bad widget can't take down the whole window.
//
// Known limitation (documented, not fixed here — see Notes from
// implementation in tasks/05-prefs-control-center.md): a setting changed
// through a widget's prefs page is written straight to
// widgets/<id>.json via WidgetSettings/StorageService, exactly like
// extension.js does — but the *already-running* widget instance in the
// Shell process has its own in-memory settings proxy and has no way to
// know the file changed from this separate process. It picks up the new
// value the next time it's loaded (i.e. after a toggle off/on here, or a
// shell restart) — real-time reflection would need a cross-process
// notification channel that's out of scope for this task.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PrefsWidgetList} from './lib/prefsWidgetList.js';
import {SettingsService} from './lib/settingsService.js';
import {StorageService} from './lib/storageService.js';
import {WidgetSettings} from './lib/widgetSettings.js';

export default class WidgetCenterPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = new SettingsService(this);
        try {
            settings.init();
        } catch (e) {
            logError(e, '[widget-center] prefs: SettingsService.init() failed');
        }

        // Same StorageService file layer extension.js uses — plain
        // Gio/GLib file I/O, so it's just as safe to use from this
        // process as from the Shell's.
        const storage = new StorageService();
        storage.init();

        const bundledWidgetsPath = GLib.build_filenamev([this.path, 'widgets']);
        const userWidgetsPath = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'gnome-widget-center', 'widgets',
        ]);
        const {ok, errors} = new PrefsWidgetList([bundledWidgetsPath, userWidgetsPath]).list();

        const page = new Adw.PreferencesPage({
            title: 'Widgets',
            icon_name: 'preferences-desktop-applications-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Installed widgets',
            description: 'Turn a widget off to remove it from the desktop immediately — no restart needed.',
        });
        page.add(group);

        const disabled = new Set(settings.isReady ? settings.getGlobalValue('disabled-widgets') : []);

        if (ok.length === 0) {
            group.add(new Adw.ActionRow({
                title: 'No widgets found',
                subtitle: 'Nothing was discovered in the bundled or user widget folders.',
            }));
        }

        for (const widget of ok)
            group.add(this._buildWidgetRow(window, settings, storage, widget, disabled.has(widget.id)));

        if (errors.length > 0) {
            const errorGroup = new Adw.PreferencesGroup({
                title: 'Widgets that failed to load',
                description: 'Fix metadata.json for these, then reopen this window to retry.',
            });
            page.add(errorGroup);

            for (const err of errors) {
                const row = new Adw.ActionRow({
                    title: err.id,
                    subtitle: err.reason,
                    css_classes: ['error'],
                });
                row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
                errorGroup.add(row);
            }
        }
    }

    /** @private builds one Adw.SwitchRow (+ optional Settings button) for a discovered widget. */
    _buildWidgetRow(window, settings, storage, widget, isDisabled) {
        const row = new Adw.SwitchRow({
            title: widget.name,
            subtitle: widget.description,
            active: !isDisabled,
        });
        row.connect('notify::active', () => {
            this._setWidgetEnabled(settings, widget.id, row.active);
        });

        if (widget.hasPrefs) {
            const settingsButton = new Gtk.Button({
                icon_name: 'go-next-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: `${widget.name} settings`,
            });
            settingsButton.connect('clicked', () => {
                this._openWidgetPrefs(window, storage, widget);
            });
            row.add_suffix(settingsButton);
        }

        return row;
    }

    /** @private flips one widget id in/out of the `disabled-widgets` GSettings array. */
    _setWidgetEnabled(settings, widgetId, enabled) {
        if (!settings.isReady) {
            logError(new Error(`SettingsService not ready — could not ${enabled ? 'enable' : 'disable'} "${widgetId}"`));
            return;
        }

        const current = new Set(settings.getGlobalValue('disabled-widgets'));
        if (enabled)
            current.delete(widgetId);
        else
            current.add(widgetId);
        settings.setGlobalValue('disabled-widgets', Array.from(current));
    }

    /**
     * @private Dynamically imports the widget's OWN prefs.js (only this
     * file, never widget.js — see docs/WIDGET_API.md §4) and embeds its
     * buildPrefsWidget() as a subpage of the Control Center window.
     */
    _openWidgetPrefs(window, storage, widget) {
        const entryPath = GLib.build_filenamev([widget.path, widget.metadata.prefs]);
        const entryFile = Gio.File.new_for_path(entryPath);
        if (!entryFile.query_exists(null)) {
            logError(new Error(`prefs entry "${widget.metadata.prefs}" not found for "${widget.id}"`));
            return;
        }

        import(`file://${entryPath}`)
            .then(module => {
                if (typeof module.default !== 'function')
                    throw new Error(`${widget.metadata.prefs} has no default export class`);

                // Scoped to this widget only, same WidgetSettings class
                // extension.js's WidgetLoader uses — the widget author's
                // prefs.js reads/writes it exactly like widget.js's
                // api.settings, just from this process instead.
                const settingsHandle = WidgetSettings.load(widget.id, storage);
                const prefsInstance = new module.default(settingsHandle);
                const prefsPage = prefsInstance.buildPrefsWidget();
                window.present_subpage(prefsPage);
            })
            .catch(e => {
                logError(e, `[widget-center] prefs: failed to open settings for "${widget.id}"`);
            });
    }
}
