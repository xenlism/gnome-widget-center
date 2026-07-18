// products/extension/prefs.js
//
// Task 05 — Control Center (Prefs GUI) entrypoint. GNOME Shell runs this
// in its own separate GTK4/libadwaita process, completely apart from
// extension.js's Shell process (development/docs/WIDGET_API.md §4) — this file, and
// everything it imports, must NEVER import St/Clutter/Meta/Shell.
//
// Responsibilities (development/tasks/05-prefs-control-center.md):
//   1. List every discovered widget (bundled + user), one Adw.SwitchRow
//      each, bound to the same `disabled-widgets` GSettings key
//      extension.js watches (see extension.js's onChanged() wiring) — so
//      toggling a row here takes effect on the desktop immediately, no
//      shell restart, even though this is a different process.
//   2. A "Settings" button per widget that has EITHER a prefs.js OR a
//      declarative `settings` schema in metadata.json (task 05):
//        - prefs.js present -> dynamically imports just that file (safe
//          here, per widget author contract) and embeds its
//          buildPrefsWidget() as an Adw.PreferencesWindow subpage.
//        - no prefs.js but a `settings` schema present -> auto-builds an
//          Adw page from it instead (settingsSchemaUI.js) — a widget
//          author can skip writing GTK4 entirely for simple settings.
//        - prefs.js wins if a widget somehow has both — see
//          _openWidgetPrefs()'s doc comment for why.
//   3. A separate error section for any widget whose metadata.json is
//      broken, so one bad widget can't take down the whole window.
//
// Cross-process live update (previously a documented known limitation of
// task 05 — see git history / ROADMAP.md for the old wording): a setting
// changed through a widget's prefs page is written straight to
// widgets/<id>.json via WidgetSettings/StorageService, exactly like
// extension.js does. The *already-running* widget instance in the Shell
// process no longer has to wait for its next load to notice — extension.js's
// WidgetLoader watches each loaded widget's settings file
// (lib/settingsWatcher.js) and merges external changes straight into the
// SAME live `api.settings` proxy the widget already holds, calling its
// optional `onSettingsChanged()` hook if it has one (development/docs/WIDGET_API.md §3).
// Nothing in THIS file changes to make that work — it's entirely a Shell-
// process concern — this comment stays here only because it's the natural
// place someone reading prefs.js would look for "what happens to the
// running widget after I save".

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PrefsWidgetList} from './lib/prefsWidgetList.js';
import {SettingsService} from './lib/settingsService.js';
import {StorageService} from './lib/storageService.js';
import {WidgetSettings} from './lib/widgetSettings.js';
import {buildSettingsPage} from './lib/settingsSchemaUI.js';

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
        const handlerId = row.connect('notify::active', () => {
            const ok = this._setWidgetEnabled(settings, widget.id, row.active);
            if (!ok) {
                // Write failed (see _setWidgetEnabled) — the switch already
                // flipped visually before this handler ran, but the
                // underlying value never changed, so revert it rather than
                // leave the UI showing a state that isn't real. Block the
                // handler while reverting so this doesn't just recurse.
                row.block_signal_handler(handlerId);
                row.active = !row.active;
                row.unblock_signal_handler(handlerId);
            }
        });

        if (widget.hasPrefs || widget.hasSettingsSchema) {
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

    /**
     * @private flips one widget id in/out of the `disabled-widgets`
     * GSettings array.
     * @returns {boolean} true if the write succeeded, false otherwise (so
     *   the caller can revert a switch that already flipped visually).
     */
    _setWidgetEnabled(settings, widgetId, enabled) {
        if (!settings.isReady) {
            logError(new Error(`SettingsService not ready — could not ${enabled ? 'enable' : 'disable'} "${widgetId}"`));
            return false;
        }

        try {
            const current = new Set(settings.getGlobalValue('disabled-widgets'));
            if (enabled)
                current.delete(widgetId);
            else
                current.add(widgetId);
            settings.setGlobalValue('disabled-widgets', Array.from(current));
            return true;
        } catch (e) {
            logError(e, `could not ${enabled ? 'enable' : 'disable'} "${widgetId}"`);
            return false;
        }
    }

    /**
     * @private Opens a widget's settings page as a subpage of the
     * Control Center window. Two sources, in priority order:
     *   1. The widget's own prefs.js, dynamically imported (only this
     *      file, never widget.js — see development/docs/WIDGET_API.md §4) and embedded
     *      via its buildPrefsWidget() — same as before task 05's schema
     *      addition, unchanged behavior for every widget that already
     *      has one.
     *   2. A declarative `settings` array in metadata.json (task 05),
     *      auto-built into an Adw page by settingsSchemaUI.js — only
     *      reached for widgets with NO prefs.js of their own. A widget
     *      with both gets #1: hand-written code can do anything a
     *      schema can plus more (custom layout, live preview, whatever),
     *      so it's treated as the author's deliberate choice to opt out
     *      of auto-generation rather than something to merge with it.
     */
    _openWidgetPrefs(window, storage, widget) {
        if (widget.hasPrefs) {
            this._openHandWrittenPrefs(window, storage, widget);
            return;
        }

        // Scoped to this widget only, same WidgetSettings class
        // extension.js's WidgetLoader uses — the auto-generated rows
        // read/write it exactly like a hand-written prefs.js would.
        const settingsHandle = WidgetSettings.load(widget.id, storage);
        const prefsPage = buildSettingsPage(widget.metadata.settings, settingsHandle, widget.name);
        window.present_subpage(prefsPage);
    }

    /** @private the pre-task-05 hand-written-prefs.js path, unchanged. */
    _openHandWrittenPrefs(window, storage, widget) {
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
