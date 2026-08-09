// products/extension/lib/prefsWidgetManagement.js
//
// Split out of prefsWindowControllerBase.js (2026-08-01 lib/ cleanup pass) —
// per-widget logic: jumping the window to one widget's settings subpage,
// building its Overview row, enabling/disabling it, and opening whichever
// of the four settings UIs it has (config.json / settings.js / hand-
// written prefs.js / legacy `settings` schema — see this file's sibling
// prefsWindowControllerBase.js header for the priority order). Applied as a
// mixin onto PrefsWindowControllerBase (see prefsWindowControllerBase.js),
// same as the sibling prefsPageBuilders.js mixin — every `this.xxx`
// reference below still means exactly what it meant before the split.

import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {fileExists} from './fsUtils.js';
import {pickTranslation} from './i18nUtils.js';
import {WidgetSettings} from './widgetSettings.js';
import {buildSettingsPage} from './settingsSchemaUI.js';
import {readWidgetConfig} from './widgetConfigReader.js';
import {buildConfigPage} from './widgetConfigUI.js';
import {createGwcContext, validateSchema} from './settingsApi.js';
import {SettingsStore} from './settingsStore.js';
import {buildGroup as buildSettingsJsGroup} from './settingsRenderer.js';
import {ThemeService} from './themeService.js';
import {rgbaToHex} from './colorUtils.js';
import {loadTranslations} from '../i18n/index.js';

export const PrefsWidgetManagementMixin = Base => class extends Base {
    /**
     * @description "Load widget on install" policy (2026-08-08, General
     * category — `auto-enable-new-widgets`/`known-widget-ids` GSettings
     * keys, see schemas/*.gschema.xml for the full contract). Called
     * once near the top of building v2's Overview tab
     * (`_buildOverviewCardsTab()`, lib/prefsWindowController.js —
     * v1's own list-based Overview page,
     * `_buildOverviewPage()`, was removed once
     * lib/prefsWindowController.js became the only window this
     * project actually builds; see HANDOVER_PREFS_V2.md),
     * BEFORE either reads disabled-widgets to decide each row/card's
     * initial switch state — so a widget disabled by this policy shows
     * up already-off on first paint, not enabled-then-flipped-off.
     *
     * Diffs `discoveredIds` against `known-widget-ids` (ids this
     * install has seen at least once before, regardless of current
     * enabled state). Any id not yet known is, per
     * `auto-enable-new-widgets`, either left alone (default - matches
     * every prior version of this extension, where "discovered and not
     * in disabled-widgets" already meant enabled) or added to
     * disabled-widgets (opt-in "don't auto-load new widgets" mode).
     * Either way the id is added to known-widget-ids so it's never
     * treated as "new" again - flipping a widget on/off later via
     * Overview is a completely separate, ordinary disabled-widgets
     * write and never touches known-widget-ids.
     *
     * No-op (returns the plain current disabled set, unchanged) if
     * `settings` isn't ready - same fail-open convention every other
     * GSettings read in this mixin/prefsPageBuilders.js already
     * follows (`sensitive: settings.isReady`, etc).
     * @param {SettingsService} settings
     * @param {Array<string>} discoveredIds - every widget id found by
     *   PrefsWidgetList.list() this run (bundled + user), regardless of
     *   current enabled state.
     * @returns {Set<string>} the disabled-widgets set to actually
     *   render against - already includes anything this call just
     *   auto-disabled.
     */
    applyAutoEnablePolicy(settings, discoveredIds) {
        if (!settings?.isReady)
            return new Set();

        let known, disabled;
        try {
            known = new Set(settings.getGlobalValue('known-widget-ids'));
            disabled = new Set(settings.getGlobalValue('disabled-widgets'));
        } catch (e) {
            logError(e, '[widget-center] prefs: could not read known-widget-ids/disabled-widgets');
            return new Set();
        }

        const autoEnable = !!settings.getGlobalValue('auto-enable-new-widgets');
        let knownChanged = false;
        let disabledChanged = false;

        for (const id of discoveredIds) {
            if (known.has(id))
                continue;
            known.add(id);
            knownChanged = true;
            if (!autoEnable && !disabled.has(id)) {
                disabled.add(id);
                disabledChanged = true;
            }
        }

        if (knownChanged) {
            try {
                settings.setGlobalValue('known-widget-ids', Array.from(known));
            } catch (e) {
                logError(e, '[widget-center] prefs: could not save known-widget-ids');
            }
        }
        if (disabledChanged) {
            try {
                settings.setGlobalValue('disabled-widgets', Array.from(disabled));
            } catch (e) {
                logError(e, '[widget-center] prefs: could not save disabled-widgets (auto-enable policy)');
            }
        }

        return disabled;
    }

    /**
     * @description Jumps an already-built window straight to one widget's
     * settings subpage - the standalone app's equivalent of writing
     * requested-widget-id and waiting for build()'s dconf plumbing, for
     * callers (widget-center-prefs-app.js) that already know exactly
     * which window and which widget id, with no GSettings round-trip
     * needed. No-op if build() hasn't been called yet or the id is
     * unknown/empty (see _jumpToWidgetPrefs()).
     * @param {Adw.PreferencesWindow} window
     * @param {string} widgetId
     */
    jumpToWidget(window, widgetId) {
        this._jumpToWidgetPrefs(window, this._settings, this._storage, this._discovered, widgetId);
    }

    /**
     * @private 2026-07-20 fix — the other half of extension.js's
     * `_openWidgetSettings()`. Reads `requested-widget-id` back out of the
     * shared GSettings key, clears it immediately (so it's a one-shot
     * hint, not a sticky "always jump here"), and — if it names a widget
     * that was actually discovered — presents that widget's settings
     * sub-page right away, exactly as if the user had clicked its own
     * "Settings" suffix button in the list (`_openWidgetPrefs()`, same
     * method `_buildWidgetRow()`'s button uses).
     *
     * Deliberately queued with `GLib.idle_add()` rather than called
     * inline: `window.present_subpage()` needs the window (and the page
     * this method is called from inside `fillPreferencesWindow()`) to
     * actually be mapped/realized first — calling it synchronously while
     * the window is still being built out is exactly the kind of timing
     * issue this codebase's other real-hardware fixes keep running into
     * (see e.g. widgetEditMode.js's `_buildBackActor()` non-positive-size
     * warning for the general pattern). One idle-loop turn is enough for
     * GTK to finish mapping the window.
     * @param {Adw.PreferencesWindow} window
     * @param {SettingsService} settings
     * @param {StorageService} storage
     * @param {Array} discovered - the `ok` list from `PrefsWidgetList.list()`
     */
    _openRequestedWidgetPrefs(window, settings, storage, discovered) {
        if (!settings.isReady)
            return;

        let requestedId;
        try {
            requestedId = settings.getGlobalValue('requested-widget-id');
        } catch (e) {
            logError(e, '[widget-center] prefs: could not read requested-widget-id');
            return;
        }

        this._jumpToWidgetPrefs(window, settings, storage, discovered, requestedId);
    }

    /**
     * @private shared by `_openRequestedWidgetPrefs()`'s one-shot read at
     * startup and `fillPreferencesWindow()`'s live `onChanged` subscription
     * (2026-07-30 fix, see that call site's comment) — both ultimately
     * just want "given whatever requested-widget-id currently says, jump
     * to that widget's settings subpage". Safe to call with an empty/
     * unknown id (a no-op) since both callers may fire with nothing
     * actually requested.
     * @param {Adw.PreferencesWindow} window
     * @param {SettingsService} settings
     * @param {StorageService} storage
     * @param {Array} discovered - the `ok` list from `PrefsWidgetList.list()`
     * @param {string} requestedId
     */
    _jumpToWidgetPrefs(window, settings, storage, discovered, requestedId) {
        if (!requestedId)
            return;

        // One-shot: clear right away so a plain "open the Control Center"
        // later (no widget id in flight) never jumps anywhere, and so a
        // second `changed::requested-widget-id` emission for the exact
        // same id doesn't jump twice.
        try {
            settings.setGlobalValue('requested-widget-id', '');
        } catch (e) {
            logError(e, '[widget-center] prefs: could not clear requested-widget-id');
        }

        const widget = discovered.find(w => w.id === requestedId);
        if (!widget) {
            // Widget vanished (uninstalled, disabled-with-error, etc)
            // between the Settings click and this window opening — fall
            // back to the top-level list rather than throwing.
            logError(new Error(`requested-widget-id "${requestedId}" not found among discovered widgets`));
            return;
        }
        if (!widget.hasConfigJson && !widget.hasPrefs && !widget.hasSettingsSchema && !widget.metadata?.['themeable'])
            return; // no settings page to jump to for this widget

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._openWidgetPrefs(window, storage, widget).catch(e =>
                logError(e, `[widget-center] prefs: opening requested settings for "${widget.id}" failed`));
            return GLib.SOURCE_REMOVE;
        });
    }

    /** @private builds one Adw.SwitchRow (+ optional Settings button) for a discovered widget. */
    _buildWidgetRow(window, settings, storage, widget, isDisabled) {
        const row = new Adw.SwitchRow({
            title: widget.name,
            subtitle: widget.description,
            active: !isDisabled,
        });
        // Progressive i18n: this._loadWidgetI18n() is async (dynamic
        // import()), but building the widget list can't wait on 12
        // separate file loads before showing anything — start with
        // metadata.json's own English name/description (above) and
        // relabel the row in place once/if a translation shows up. Not
        // awaited on purpose; see _loadWidgetI18n()'s doc comment.
        this._loadWidgetI18n(widget).then(translations => {
            row.title = this._t(translations, 'meta.name', widget.name);
            row.subtitle = this._t(translations, 'meta.description', widget.description);
        }).catch(() => {});

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

        if (widget.hasConfigJson || widget.hasPrefs || widget.hasSettingsSchema || widget.metadata?.['themeable']) {
            const settingsButton = new Gtk.Button({
                icon_name: 'go-next-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: `${widget.name} settings`,
            });
            settingsButton.connect('clicked', () => {
                this._openWidgetPrefs(window, storage, widget).catch(e =>
                    logError(e, `[widget-center] prefs: opening settings for "${widget.id}" failed`));
            });
            row.add_suffix(settingsButton);
        }

        return row;
    }

    /**
     * @private Dynamically loads one widget's own i18n/ table for the
     * current locale — see i18n/index.js's loadTranslations(), the
     * exact same loader every widget's i18n/index.js copy also exports
     * (see that file's header for why prefs.js reuses this one static
     * import instead of dynamically importing each widget's own copy:
     * the function is pure/stateless, it only cares about the dirPath
     * argument, so which physical copy runs it is irrelevant — each
     * widget still ships a fully working, self-contained i18n/index.js
     * of its own for anything that imports the widget directly, e.g. its
     * own widget.js).
     * @param {object} widget - a PrefsWidgetList entry (has .path)
     * @returns {Promise<Object>} {} if the widget has no i18n/ folder or
     *   nothing matched the current locale — never rejects.
     */
    _loadWidgetI18n(widget) {
        // 2026-08-04: same `language` override as everywhere else - see
        // prefsWindowControllerBase.js's build() for the identical read
        // against this._settings for the main window's own chrome
        // strings. this._settings is already set by the time any widget
        // subpage can be opened (build() runs first).
        const languageOverride = this._settings?.isReady
            ? (this._settings.getGlobalValue('language') || undefined)
            : undefined;
        return loadTranslations(GLib.build_filenamev([widget.path, 'i18n']), languageOverride).catch(() => ({}));
    }

    /** @private translations[key] if present, else `fallback`. */
    _t(translations, key, fallback) {
        return pickTranslation(translations, key, fallback);
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
     * Control Center window. Four sources, in priority order:
     *   1. config.json (development/docs/WIDGET_API.md §6.4), read +
     *      validated by widgetConfigReader.js and auto-built into an Adw
     *      page by widgetConfigUI.js — the recommended path, and the one
     *      every bundled widget now ships instead of a hand-written
     *      prefs.js. Wins over #2/#3/#4 if a widget somehow has more
     *      than one, since config.json is meant to fully replace the
     *      others for a given widget, not merge with them.
     *   2. The widget's own prefs.js, dynamically imported (only this
     *      file, never widget.js — see development/docs/WIDGET_API.md
     *      §4) and embedded via its buildPrefsWidget() — kept for
     *      user-installed widgets that still ship one, or anything a
     *      declarative schema genuinely can't express (custom layout,
     *      live preview, etc).
     *   3. The widget's own settings.js (§6.3's `gwc.settings` fluent
     *      builder), dynamically imported and rendered via
     *      lib/settingsApi.js + lib/settingsRenderer.js — see
     *      _openWidgetSettingsJsPrefs(). Richer type set than #4 (adds
     *      date/action/multiOption/font/color, plus unconditional
     *      showIf()), but newer and less common than config.json, so it
     *      sits below #1/#2 rather than replacing them.
     *   4. A declarative `settings` array in metadata.json, auto-built
     *      into an Adw page by settingsSchemaUI.js — the oldest and
     *      least expressive of the four; only reached for widgets with
     *      none of #1-#3 of their own.
     */
    async _openWidgetPrefs(window, storage, widget) {
        const translations = await this._loadWidgetI18n(widget);
        const title = this._t(translations, 'meta.name', widget.name);

        if (widget.hasConfigJson) {
            const {config, errors} = readWidgetConfig(widget.path);
            if (config) {
                const settingsHandle = WidgetSettings.load(widget.id, storage);
                const prefsPage = buildConfigPage(config, settingsHandle, title, widget.path, translations);
                this._appendWidgetAppearanceGroup(prefsPage, widget);
                this._presentPrefsPage(window, widget, prefsPage);
                return;
            }
            // config.json exists but failed to read/parse/validate —
            // fall through to prefs.js/settings.js/schema below rather
            // than showing nothing, and log why so it's not silent.
            logError(new Error(
                `config.json for "${widget.id}" invalid: ${errors.map(e => e.message).join('; ')}`));
        }

        if (widget.hasPrefs) {
            this._openHandWrittenPrefs(window, storage, widget);
            return;
        }

        if (widget.hasSettingsJs) {
            this._openWidgetSettingsJsPrefs(window, widget, title);
            return;
        }

        // Scoped to this widget only, same WidgetSettings class
        // extension.js's WidgetLoader uses — the auto-generated rows
        // read/write it exactly like a hand-written prefs.js would.
        // (settingsSchemaUI.js's flat-array path predates config.json,
        // settings.js, and this i18n system — every bundled widget has
        // since moved to config.json, see this method's class-level doc
        // comment for the fallback order.)
        const settingsHandle = WidgetSettings.load(widget.id, storage);
        const prefsPage = buildSettingsPage(widget.metadata.settings ?? [], settingsHandle, title);
        this._appendWidgetAppearanceGroup(prefsPage, widget);
        this._presentPrefsPage(window, widget, prefsPage);
    }

    /**
     * @private §6.3 path — the widget's own `settings.js`, dynamically
     * imported and rendered via the `gwc.settings` fluent builder
     * (lib/settingsApi.js -> lib/settingsRenderer.js), backed by its own
     * SettingsStore (lib/settingsStore.js — a separate on-disk location,
     * `~/.local/share/gnome-widget-center/settings/<id>.json`, NOT
     * `widgets/<id>.json`/WidgetSettings; see settingsStore.js's file
     * header for why this is a deliberately separate "third system").
     *
     * Unlike the WidgetSettings-backed paths (config.json/prefs.js/
     * legacy schema, which debounce writes ~300ms and need an explicit
     * flush on close — see _presentPrefsPage()'s doc comment),
     * SettingsStore.set()/setMany() write straight to disk synchronously,
     * so there's nothing to flush here — only its Gio.FileMonitor to
     * release, done via store.destroy() in the onClose callback below.
     * @param {Adw.PreferencesWindow} window
     * @param {object} widget - discovered widget entry (needs .id/.path).
     * @param {string} title - already-translated display title.
     */
    _openWidgetSettingsJsPrefs(window, widget, title) {
        const entryPath = GLib.build_filenamev([widget.path, 'settings.js']);
        if (!fileExists(entryPath)) {
            logError(new Error(`settings.js not found for "${widget.id}"`));
            return;
        }

        import(`file://${entryPath}`)
            .then(module => {
                if (typeof module.defineSettings !== 'function')
                    throw new Error(`settings.js for "${widget.id}" has no defineSettings() export`);

                const gwc = createGwcContext(widget.id);
                module.defineSettings(gwc);
                const schema = gwc.settings.build();
                validateSchema(schema);

                const store = new SettingsStore(widget.id, schema.fields);
                const prefsPage = new Adw.PreferencesPage({title});
                for (const group of buildSettingsJsGroup(schema, store, {title}))
                    prefsPage.add(group);

                this._appendWidgetAppearanceGroup(prefsPage, widget);
                this._presentPrefsPage(window, widget, prefsPage, () => store.destroy());
            })
            .catch(e => {
                logError(e, `[widget-center] prefs: failed to open settings.js for "${widget.id}"`);
            });
    }

    /**
     * @private Theme system (2026-07-25) — appends a per-widget
     * "Appearance" group (background color/transparent + corner radius)
     * to any settings page for a widget that opts in via metadata.json's
     * `"themeable": true`. Reads/writes `theme.json`'s per-widget
     * `config.background` / `config.cornerRadius` via
     * `ThemeService.getWidgetTheme()`/`setWidgetTheme()` — deliberately
     * NOT `WidgetSettings`/`widgets/<id>.json`, since this is an
     * APPEARANCE concern, not a behavior one (see themeService.js's file
     * header and development/docs/SETTINGS_SPEC.md's "one file, one
     * responsibility" principle).
     *
     * When the Appearance page's global "Force this ... on every widget"
     * switch is on for a property, that property's row here is shown but
     * disabled (greyed out, displaying the global value) — matches what
     * `ThemeService.getEffectiveWidgetTheme()` actually does at render
     * time: a per-widget value stored while forced would just be silently
     * ignored, so letting the user edit it here would be misleading.
     * @param {Adw.PreferencesPage} prefsPage
     * @param {object} widget - discovered widget entry (needs .id,
     *   .metadata.themeable).
     */
    _appendWidgetAppearanceGroup(prefsPage, widget) {
        if (!widget.metadata?.['themeable'])
            return;

        const theme = new ThemeService();
        theme.init();
        const global = theme.getGlobalTheme();
        const {config} = theme.getWidgetTheme(widget.id);
        const widgetBackground = config.background ?? {};
        const widgetCornerRadius = config.cornerRadius ?? {};

        const group = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'This widget\'s own background and corner radius. Set in the ' +
                'Control Center\'s Appearance page, "Force" can override these for every widget.',
        });
        prefsPage.add(group);

        const bgForced = !!global.background.force;
        const transparentRow = new Adw.SwitchRow({
            title: 'Transparent',
            active: bgForced ? !!global.background.transparent : !!widgetBackground.transparent,
            sensitive: !bgForced,
            subtitle: bgForced ? 'Forced by the global Appearance settings.' : null,
        });
        group.add(transparentRow);

        const colorRow = new Adw.ActionRow({
            title: 'Background color',
            sensitive: !bgForced,
        });
        const rgba = new Gdk.RGBA();
        rgba.parse((bgForced ? global.background.color : widgetBackground.color) ?? '#1e1e2e');
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog(),
            rgba,
            valign: Gtk.Align.CENTER,
            sensitive: !bgForced,
        });
        colorRow.add_suffix(colorButton);
        colorRow.set_activatable_widget(colorButton);
        group.add(colorRow);

        if (!bgForced) {
            const saveBackground = () => {
                theme.setWidgetTheme(widget.id, {
                    config: {
                        background: {
                            transparent: transparentRow.active,
                            color: rgbaToHex(colorButton.rgba),
                        },
                    },
                });
            };
            transparentRow.connect('notify::active', saveBackground);
            colorButton.connect('notify::rgba', saveBackground);
        }

        const radiusForced = !!global.cornerRadius.force;
        const radiusRow = new Adw.SpinRow({
            title: 'Corner radius',
            subtitle: radiusForced ? 'Forced by the global Appearance settings.' : '0\u201364 px',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 64, step_increment: 1,
                value: (radiusForced ? global.cornerRadius.value : widgetCornerRadius.value) ?? 12,
            }),
            sensitive: !radiusForced,
        });
        group.add(radiusRow);

        if (!radiusForced) {
            radiusRow.connect('notify::value', () => {
                theme.setWidgetTheme(widget.id, {
                    config: {cornerRadius: {value: radiusRow.value}},
                });
            });
        }
    }

    /**
     * @private Real-hardware bug report (2026-07-19): a widget's settings
     * subpage had no visible "Save"/"Close" of its own — every row
     * writes straight through to disk on change (see settingsSchemaUI.js
     * / widgets' own hand-written prefs.js), so there was never a
     * separate "Save" step, and closing relied entirely on the Control
     * Center window's own title-bar chrome. That's not obvious enough on
     * its own, so every settings subpage gets an explicit action bar with
     * a "Save & Close" button that flushes any pending debounced write
     * immediately (see the 2026-07-26 bug-fix note on
     * fillPreferencesWindow()'s close-request handler for why relying on
     * the ~300ms debounce alone was silently losing edits).
     *
     * 2026-08-04: this used to also show a separate plain "Close" button
     * next to it — removed. It flushed the exact same pending write and
     * closed the exact same way underneath (see the 2026-07-19 note
     * above: every row already writes straight through, there's no
     * "discard" semantics for either button to actually differ on), so
     * having two buttons just implied a real Close-without-saving/Save
     * distinction that never existed and cost real confusion for no
     * benefit — one honest button.
     * @param {Adw.PreferencesWindow} window
     * @param {object} widget - discovered widget entry (needs .id for
     *   WidgetSettings.flush()).
     * @param {Adw.PreferencesPage} prefsPage - built by either
     *   buildSettingsPage() or a widget's own buildPrefsWidget().
     * @param {() => void} [onClose] - extra cleanup to run alongside the
     *   WidgetSettings.flush() below, before closing the subpage. Used
     *   by _openWidgetSettingsJsPrefs() to release its SettingsStore's
     *   Gio.FileMonitor (settings.js pages don't use WidgetSettings at
     *   all, so flush() is a harmless no-op for them, not a replacement
     *   for this).
     */
    _presentPrefsPage(window, widget, prefsPage, onClose = () => {}) {
        const actionsGroup = new Adw.PreferencesGroup();
        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.END,
        });

        const saveButton = new Gtk.Button({
            label: 'Save & Close',
            css_classes: ['suggested-action'],
        });
        saveButton.connect('clicked', () => {
            WidgetSettings.flush(widget.id);
            onClose();
            window.close_subpage();
        });

        buttonBox.append(saveButton);
        actionsGroup.add(buttonBox);
        prefsPage.add(actionsGroup);

        window.present_subpage(prefsPage);
    }

    /** @private the pre-task-05 hand-written-prefs.js path, unchanged. */
    _openHandWrittenPrefs(window, storage, widget) {
        const entryPath = GLib.build_filenamev([widget.path, widget.metadata.prefs]);
        if (!fileExists(entryPath)) {
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
                this._appendWidgetAppearanceGroup(prefsPage, widget);
                this._presentPrefsPage(window, widget, prefsPage);
            })
            .catch(e => {
                logError(e, `[widget-center] prefs: failed to open settings for "${widget.id}"`);
            });
    }
};
