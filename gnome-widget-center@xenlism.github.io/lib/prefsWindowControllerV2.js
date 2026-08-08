// products/extension/lib/prefsWindowControllerV2.js
//
// 2026-08-08 — this is now the ONLY Control Center window this project
// builds. `prefs.js` and `widget-center-prefs-app.js` both construct
// `PrefsWindowControllerV2` directly (see HANDOVER_PREFS_V2.md's "V2
// wasn't actually wired up" addendum for how long that switch was
// missing, and what broke because of it). `lib/prefsWindowController.js`
// still exists underneath as the shared base class (constructor + a
// few small cross-window helpers + the two page/widget-row mixins) —
// see that file's own header — but no longer defines its own `build()`;
// only this file's `build()` (below) is ever called.
//
// What's different from what `lib/prefsWindowController.js` used to
// build on its own (the "v1" window, still visible in this file's/that
// file's git history if ever needed again):
//   1. FOUR top-level tabs instead of two: Overview, Themes, Preferences,
//      About — Themes and About are both new top-level tabs; v1 only had
//      Overview (a plain Adw.SwitchRow list) and Preferences (with About
//      nested as one of its sidebar categories).
//   2. Overview is now a responsive 2-cards-per-row grid (screenshot,
//      name, description, author, Enable/Settings/Remove buttons) —
//      the same visual language as the St/Clutter Widget Center overlay's
//      Overview tab (lib/widgetCenterOverlay.js's `_buildWidgetCard()`),
//      but built entirely in GTK4/Libadwaita here (Gtk.FlowBox +
//      Gtk.Picture/Gtk.Image), never St/Clutter — this file, like every
//      other file under products/extension/ *outside* extension.js and
//      lib/widgetCenterOverlay.js, runs in the separate GTK4 prefs
//      process and must NEVER import St/Clutter/Meta/Shell
//      (development/docs/WIDGET_API.md §4). "Adw GTK4, not a St+Adw mix"
//      — this file is pure Gtk4/Adw the whole way down.
//   3. Themes is a new top-level tab, same 2-per-row card grid, sourced
//      from the same lib/themePackRegistry.js the overlay's Themes tab
//      already uses. Each card: screenshot, name, description, widget
//      count, author, an Apply button + a READ-ONLY switch showing
//      whether this pack is the currently active one (a real switch
//      would suggest per-pack independent on/off, which isn't how theme
//      packs work — only one is ever "active" at a time, same reasoning
//      lib/widgetCenterOverlay.js's own `_buildThemePackCard()` doc
//      comment already gives for why that one is a status pill, not a
//      toggle — this is the same idea rendered as a disabled Gtk.Switch
//      instead, per this checkpoint's explicit design ask), plus a small
//      Remove button for user-installed packs only.
//   4. Preferences is UNCHANGED content-wise — same
//      `_buildPreferencesPage()` from prefsPageBuilders.js (General /
//      Appearance / Desktop / Interactions / Backup / Import-Export /
//      Advanced sidebar), just called with `{includeAbout: false}` so
//      About doesn't also show up nested in there once it has its own
//      top-level tab.
//   5. About is a brand new top-level tab. Unlike Overview/Themes, this
//      one DOES use Adw.PreferencesPage + Adw.PreferencesGroup (the
//      "normal" Adwaita settings-page look) — About is static,
//      read-only content with no grid to lay out, so the HIG's clamped
//      reading-width column is exactly what you want here, whereas
//      clamping the Overview/Themes card grids to that same ~600-860px
//      column is precisely the "doesn't fill the screen" problem this
//      checkpoint's design ask called out. That's why Overview/Themes
//      below build their own plain Gtk.ScrolledWindow+Gtk.Box content
//      (wrapped in the thinnest possible Adw.PreferencesGroup shim,
//      title-less, so window.add() still has the Adw.PreferencesPage it
//      requires) instead of laying widget/theme cards out as rows
//      inside a titled Adw.PreferencesGroup the way v1's Overview list
//      did — see _buildClampedCardPage()'s own doc comment below for
//      the current (2026-08-08) 800px-clamp approach.
//
// 2026-08-08 revision — the "full-bleed edge-to-edge grid" approach
// above (3-per-row cards, window.maximize(), a hand-rolled shim trying
// to defeat AdwPreferencesPage's own reading-width clamp) is gone.
// Rather than fight that clamp, every tab now deliberately EMBRACES it:
// Overview/Themes/Preferences all render inside an explicit
// `Adw.Clamp` pinned to `maximum-size: 800` (see
// `_buildClampedCardPage()` below), same fixed reading width the About
// tab already gets for free from AdwPreferencesPage's own default
// clamp. Cards dropped from 3-per-row to 2-per-row to match: two
// 370px cards + 20px column spacing is 760px, comfortably inside 800
// with room for the clamp's own edge margins, so nothing clips the way
// 3-up did on a narrower/un-maximized window. The window itself no
// longer forces `maximize()` — it opens at a normal, modest default
// size instead (see `build()` below) since there's no more full-bleed
// content that needs the whole screen to look right.
//
// The Preferences tab's sidebar (Adw.NavigationSplitView, unchanged in
// v1 — see lib/prefsWindowController.js) is *also* replaced here with
// a single-page accordion: each category (General, Appearance, Desktop,
// …) is now a collapsible "card" the user opens/closes in place, rather
// than a left-hand list that swaps right-hand content. That accordion
// lives in the shared `lib/prefsPageBuilders.js` mixin
// (`_buildCategoryAccordion()`), opt-in via a new `{layout: 'accordion'}`
// option on `_buildPreferencesPage()` so v1's sidebar behavior is
// completely unaffected — this file is the only caller that passes it.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {PrefsWindowController} from './prefsWindowController.js';
import {confirmOverwrite} from './prefsDialogs.js';
import {fileExists} from './fsUtils.js';
import {ThemePackRegistry} from './themePackRegistry.js';
import {SettingsService} from './settingsService.js';
import {StorageService} from './storageService.js';
import {PrefsWidgetList} from './prefsWidgetList.js';
import {WidgetSettings} from './widgetSettings.js';
import {loadTranslations} from '../i18n/index.js';

/** @private every directory a widget/theme-pack is considered "the
 * user's own" if found under — same convention v1's overlay integration
 * uses (widgetCenterOverlay.js's `_userWidgetsRoots()`/
 * `_userThemepacksRoots()`), duplicated here rather than imported since
 * that file is St/Clutter-only and can't be imported from this GTK4
 * process (see this file's header). */
function pathIsUnder(path, root) {
    return path === root || path.startsWith(`${root}/`);
}

/** @private recursively deletes a Gio.File directory (or a single file)
 * — Gio.File has no built-in recursive delete. Only ever called against
 * a path already confirmed to be under the user's own widgets/
 * themepacks folder (see callers) — never against a bundled path. */
function deleteRecursive(file) {
    const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let child;
        while ((child = enumerator.next_file(null)) !== null)
            deleteRecursive(file.get_child(child.get_name()));
        enumerator.close(null);
    }
    file.delete(null);
}

export class PrefsWindowControllerV2 extends PrefsWindowController {
    /**
     * @description Same contract as v1's build() (see
     * prefsWindowController.js's own doc comment) — safe to call exactly
     * once per window. Builds the four tabs described in this file's
     * header instead of v1's two.
     * @param {Adw.PreferencesWindow} window
     */
    async build(window) {
        window.connect('close-request', () => {
            // Same belt-and-suspenders flush v1's build() does — see
            // that method's doc comment for why this matters.
            WidgetSettings.flushAll();
            return false;
        });

        const settings = new SettingsService(
            this._extensionObject ?? GLib.build_filenamev([this.path, 'schemas'])
        );
        try {
            settings.init();
        } catch (e) {
            logError(e, '[widget-center] prefsV2: SettingsService.init() failed');
        }

        const languageOverride = settings.isReady ? (settings.getGlobalValue('language') || undefined) : undefined;
        this._i18n = await loadTranslations(GLib.build_filenamev([this.path, 'i18n']), languageOverride).catch(() => ({}));

        const storage = new StorageService();
        storage.init();

        const bundledWidgetsPath = GLib.build_filenamev([this.path, 'widgets']);
        const userWidgetsPath = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'gnome-widget-center', 'widgets',
        ]);
        const {ok, errors} = new PrefsWidgetList([bundledWidgetsPath, userWidgetsPath]).list();

        this._settings = settings;
        this._storage = storage;
        this._discovered = ok;
        this._userWidgetsPath = userWidgetsPath;

        // 2026-08-08: no longer forces maximize()/full-screen — every
        // tab now renders inside a fixed 800px Adw.Clamp (see this
        // file's header), so there's nothing left that needs the whole
        // screen to avoid clipping. A normal, modest default size that
        // comfortably fits the 800px content plus window chrome/sidebar.
        const display = Gdk.Display.get_default();
        const monitor = display.get_monitors().get_item(0);
        const geometry = monitor.get_geometry();

        window.set_default_size(900, geometry.height);

        this._buildOverviewCardsTab(window, settings, ok);
        this._buildThemesCardsTab(window, settings, storage, ok);
        this._preferencesPage = this._buildPreferencesPage(
            window, settings, storage, ok, {bundledWidgetsPath, userWidgetsPath},
            {includeAbout: false, layout: 'accordion'});
        this._buildAboutTab(window);

        // Same deep-link plumbing v1's build() has (Settings button in
        // Edit Mode -> requested-widget-id -> jump straight to that
        // widget's settings subpage) — unchanged behavior, just reusing
        // the inherited methods rather than re-implementing them.
        this._openRequestedWidgetPrefs(window, settings, storage, ok);
        if (settings.isReady) {
            const requestedIdHandlerId = settings.onChanged('requested-widget-id', value => {
                this._jumpToWidgetPrefs(window, settings, storage, ok, value);
            });
            window.connect('close-request', () => {
                settings.disconnect(requestedIdHandlerId);
                return false;
            });
        }
    }

    /**
     * @description Override of v1's `showBackupPage()`
     * (lib/prefsWindowController.js) — that implementation reads
     * `this._categoryListBox`/`this._categoryRowsById.backup`, which are
     * only ever set by `_buildPreferencesPage()`'s sidebar branch
     * (`Adw.NavigationSplitView` + a category `Gtk.ListBox`). This
     * window always builds Preferences with `{layout: 'accordion'}`
     * instead (see `build()` above), which never touches either of
     * those fields — so without this override, v1's version would
     * silently no-op here (both its guard-clause fields are `null`) and
     * the overlay's Backup button / widget-center-prefs-app.js's
     * `--focus=backup` flag would stop working under V2. Uses
     * `this._accordionCategoriesById` instead (set alongside the
     * accordion itself — see `_buildCategoryAccordion()` in
     * lib/prefsPageBuilders.js), expanding the "Backup & Restore" card
     * in place rather than selecting a sidebar row. Same idle-loop
     * deferral as v1's version and for the same reason: the window
     * needs to be mapped before `set_visible_page()` takes effect.
     * @param {Adw.PreferencesWindow} window
     */
    showBackupPage(window) {
        if (!this._preferencesPage || !this._accordionCategoriesById?.backup)
            return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                window.set_visible_page(this._preferencesPage);
                this._accordionCategoriesById.backup.expand();
            } catch (e) {
                logError(e, '[widget-center] prefsV2: showBackupPage() failed');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Shared: the "bare full-bleed page" shim ---------------------

    /**
     * @private Wraps `content` (any plain Gtk.Widget — here always a
     * Gtk.ScrolledWindow holding a card grid) in a normal
     * Adw.PreferencesPage/Adw.PreferencesGroup, with an explicit
     * `Adw.Clamp` (maximum-size 800) around it so Overview/Themes line
     * up at exactly the same 800px reading width as the Preferences
     * accordion and the About tab (see this file's header for why this
     * replaced the old full-bleed shim). 800 is comfortably inside
     * AdwPreferencesPage's own default clamp range, so this doesn't
     * fight the page's built-in behavior — it just pins it to a
     * specific, consistent number instead of letting it float between
     * its min/max on different window sizes.
     * @param {string} title - tab title (shown in the window's tab switcher).
     * @param {string} icon_name
     * @param {Gtk.Widget} content
     * @returns {Adw.PreferencesPage}
     */
    _buildClampedCardPage(title, icon_name, content) {
        const page = new Adw.PreferencesPage({title, icon_name});
        const group = new Adw.PreferencesGroup();
        const clamp = new Adw.Clamp({maximum_size: 800, tightening_threshold: 600});
        content.hexpand = true;
        content.vexpand = true;
        clamp.set_child(content);
        group.add(clamp);
        page.add(group);
        return page;
    }

    /** @private 2-per-row (1 on a narrower window) Gtk.FlowBox shared by
     * both card grids. Two 370px cards + 20px column spacing = 760px,
     * which fits inside the 800px Adw.Clamp from
     * `_buildClampedCardPage()` with room to spare — deliberately
     * dropped from the old 3-per-row layout (which needed a full-bleed,
     * un-clamped window to avoid clipping) now that every tab is pinned
     * to a fixed 800px width. Still a real GTK4 Gtk.FlowBox underneath,
     * so it still re-flows live (down to 1-per-row) if the window is
     * narrower than 800px. */
    _buildCardFlowBox() {
        return new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            row_spacing: 20,
            column_spacing: 20,
            max_children_per_line: 2,
            min_children_per_line: 1,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
            valign: Gtk.Align.START,
            hexpand: true,
        });
    }

    /** @private one card's outer shell: a fixed-width "card"-styled
     * Gtk.Box (the `card` CSS class is a standard Libadwaita style class
     * for a subtly raised/bordered container, same convention this
     * codebase already leans on elsewhere for boxed content). Fixed
     * width (rather than hexpand-to-fill) so FlowBox's homogeneous
     * layout produces even, predictable 2-up rows regardless of how
     * long a name/description happens to be — widened from 340 to 370
     * now that only 2 (not 3) need to fit in the 800px clamp. */
    _buildCardShell() {
        return new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['card'],
            width_request: 370,
            overflow: Gtk.Overflow.HIDDEN,
        });
    }

    /** @private screenshot/fallback-icon banner shared by widget and
     * theme-pack cards. `path` may be null (no screenshot found) —
     * falls back to a centered generic icon, same fallback
     * lib/widgetCenterOverlay.js's own `_buildScreenshot()` uses for
     * the overlay's equivalent cards. */
    _buildCardBanner(path) {
        const banner = new Gtk.Box({
            css_classes: ['wc-card-banner'],
            height_request: 160,
            valign: Gtk.Align.FILL,
        });
        if (path) {
            const picture = new Gtk.Picture({
                content_fit: Gtk.ContentFit.COVER,
                hexpand: true,
                vexpand: true,
            });
            picture.set_filename(path);
            banner.append(picture);
        } else {
            banner.append(new Gtk.Image({
                icon_name: 'image-x-generic-symbolic',
                pixel_size: 48,
                hexpand: true,
                vexpand: true,
                css_classes: ['dim-label'],
            }));
        }
        return banner;
    }

    /** @private resolves a widget's or theme pack's screenshot to an
     * absolute on-disk path Gtk.Picture can load directly. Handles both
     * shapes lib/widgetCenterOverlay.js's `_resolveScreenshot()`
     * already handles for the overlay (a relative `screenshot` field
     * next to metadata.json/theme.json, OR an embedded
     * `screenshotBase64` for a flat `.gwct` theme pack, decoded once
     * into `~/.cache/gnome-widget-center/thumbnails/` and reused) —
     * same cache path/convention, so a pack already opened once in the
     * overlay doesn't get re-decoded here, and vice versa.
     * @param {string} basePath
     * @param {object} metadataOrManifest
     * @returns {string|null}
     */
    _resolveScreenshotPath(basePath, metadataOrManifest) {
        if (metadataOrManifest?.screenshotBase64)
            return this._decodedScreenshotCachePath(metadataOrManifest);

        const relative = metadataOrManifest?.screenshot;
        if (!relative)
            return null;
        const path = GLib.build_filenamev([basePath, relative]);
        return fileExists(path) ? path : null;
    }

    /** @private see `_resolveScreenshotPath()`'s doc comment - identical
     * decode-once-and-cache behavior to widgetCenterOverlay.js's own
     * `_decodedScreenshotCachePath()`, duplicated rather than imported
     * for the same "that file is St-only, can't import it here" reason
     * as `pathIsUnder()` above. */
    _decodedScreenshotCachePath(manifest) {
        const ext = (manifest.screenshotMime ?? '').includes('png') ? 'png'
            : (manifest.screenshotMime ?? '').includes('webp') ? 'webp' : 'jpg';
        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-widget-center', 'thumbnails']);
        const cachePath = GLib.build_filenamev([cacheDir, `${manifest.id}.${ext}`]);

        if (fileExists(cachePath))
            return cachePath;

        try {
            GLib.mkdir_with_parents(cacheDir, 0o755);
            const bytes = GLib.base64_decode(manifest.screenshotBase64);
            GLib.file_set_contents(cachePath, bytes);
            return cachePath;
        } catch (e) {
            logError(e, `[widget-center] prefsV2: could not decode screenshot for "${manifest.id}"`);
            return null;
        }
    }

    // --- Tab 1: Overview (widget cards) -------------------------------

    /**
     * @private Builds the Overview tab and adds it to `window`. Safe to
     * call more than once (e.g. after Remove deletes a widget): if a
     * previous Overview page is already showing, it's removed first via
     * `window.remove()` (a documented Adw.PreferencesWindow method) so
     * the switcher never ends up with two identically-titled "Overview"
     * entries — same "throw the old content away, build fresh"
     * convention lib/widgetCenterOverlay.js's `_renderTab()` uses,
     * simple and cheap enough for a list that only ever numbers in the
     * dozens.
     * @param {Adw.PreferencesWindow} window
     * @param {SettingsService} settings
     * @param {Array} discovered - `ok` from PrefsWidgetList.list()
     */
    _buildOverviewCardsTab(window, settings, discovered) {
        if (this._overviewPage) {
            window.remove(this._overviewPage);
            this._overviewPage = null;
        }

        const scroll = new Gtk.ScrolledWindow({hexpand: true, vexpand: true});
        const flow = this._buildCardFlowBox();
        scroll.set_child(flow);

        // 2026-08-08: "load widget on install" policy — see
        // applyAutoEnablePolicy()'s own doc comment (lib/prefsWidgetManagement.js).
        this.applyAutoEnablePolicy(settings, discovered.map(w => w.id));

        const disabled = new Set(settings.isReady ? settings.getGlobalValue('disabled-widgets') : []);

        if (discovered.length === 0) {
            flow.append(new Gtk.Label({
                label: this._tr('overview.empty', 'No widgets found'),
                css_classes: ['dim-label'], margin_top: 48,
            }));
        }

        for (const widget of discovered) {
            const isUser = pathIsUnder(widget.path, this._userWidgetsPath);
            flow.append(this._buildWidgetCard(window, settings, widget, disabled.has(widget.id), isUser));
        }

        const page = this._buildClampedCardPage(
            this._tr('tab.overview.label', 'Overview'), 'view-grid-symbolic', scroll);
        window.add(page);
        this._overviewPage = page;
    }

    _buildWidgetCard(window, settings, widget, isDisabled, isUser) {
        const card = this._buildCardShell();
        card.append(this._buildCardBanner(this._resolveScreenshotPath(widget.path, widget.metadata)));

        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 4,
            margin_top: 12, margin_bottom: 12, margin_start: 14, margin_end: 14,
        });
        card.append(body);

        const title = new Gtk.Label({
            label: widget.name, xalign: 0, css_classes: ['title-4'],
            ellipsize: Pango.EllipsizeMode.END, single_line_mode: true,
        });
        body.append(title);

        if (widget.description) {
            const desc = new Gtk.Label({
                label: widget.description, xalign: 0, wrap: true, lines: 2,
                ellipsize: Pango.EllipsizeMode.END, css_classes: ['dim-label', 'caption'],
            });
            body.append(desc);
        }

        if (widget.metadata?.author) {
            body.append(new Gtk.Label({
                label: `by ${widget.metadata.author}`, xalign: 0,
                css_classes: ['dim-label', 'caption'],
            }));
        }

        // --- controls: 1. Settings  2. Remove (user-only)  3. Enable ---
        const controls = new Gtk.Box({
            spacing: 6, margin_top: 8, margin_bottom: 14, margin_start: 14, margin_end: 14,
        });
        card.append(controls);

        const settingsButton = new Gtk.Button({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: this._tr('overview.card.settings', 'Settings'),
            sensitive: widget.hasConfigJson || widget.hasPrefs || widget.hasSettingsJs || widget.hasSettingsSchema,
        });
        settingsButton.connect('clicked', () => {
            this._openWidgetPrefs(window, this._storage, widget).catch(e =>
                logError(e, `[widget-center] prefsV2: opening settings for "${widget.id}" failed`));
        });
        controls.append(settingsButton);

        if (isUser) {
            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: this._tr('overview.card.remove', 'Remove'),
                css_classes: ['destructive-action'],
            });
            removeButton.connect('clicked', async () => {
                const confirmed = await confirmOverwrite(window,
                    this._tr('overview.card.remove_confirm_heading', 'Remove this widget?'),
                    this._tr('overview.card.remove_confirm_body',
                        `This deletes "${widget.name}" from your user widgets folder. This cannot be undone.`),
                    this._tr('overview.card.remove_confirm_button', 'Remove'));
                if (!confirmed)
                    return;
                this._removeUserWidget(settings, widget);
                this._discovered = this._discovered.filter(w => w.id !== widget.id);
                this._buildOverviewCardsTab(window, settings, this._discovered);
            });
            controls.append(removeButton);
        }

        controls.append(new Gtk.Box({hexpand: true})); // spacer

        const enableButton = new Gtk.ToggleButton({
            label: isDisabled
                ? this._tr('overview.card.enable', 'Enable')
                : this._tr('overview.card.disable', 'Disable'),
            active: !isDisabled,
            valign: Gtk.Align.CENTER,
        });
        enableButton.connect('toggled', () => {
            const ok = this._setWidgetEnabled(settings, widget.id, enableButton.active);
            if (!ok) {
                enableButton.active = !enableButton.active;
                return;
            }
            enableButton.label = enableButton.active
                ? this._tr('overview.card.disable', 'Disable')
                : this._tr('overview.card.enable', 'Enable');
        });
        controls.append(enableButton);

        return card;
    }

    /**
     * @private Deletes a user-installed widget's files off disk
     * entirely (unlike Overview's Enable toggle, which only ever flips
     * `disabled-widgets` — "remove only widget from users not bundle
     * widget", this checkpoint's explicit ask) and, belt-and-suspenders,
     * also drops it from `disabled-widgets` so no stale id lingers in
     * that GSettings array once the folder is gone. Only ever called
     * from the Remove button above, which is only ever shown for
     * `isUser === true` cards — never reachable for a bundled widget.
     */
    _removeUserWidget(settings, widget) {
        try {
            deleteRecursive(Gio.File.new_for_path(widget.path));
        } catch (e) {
            logError(e, `[widget-center] prefsV2: could not remove widget "${widget.id}"`);
            return;
        }
        if (settings.isReady) {
            try {
                const current = new Set(settings.getGlobalValue('disabled-widgets'));
                current.delete(widget.id);
                settings.setGlobalValue('disabled-widgets', Array.from(current));
            } catch (e) {
                logError(e, `[widget-center] prefsV2: could not clean up disabled-widgets for "${widget.id}"`);
            }
        }
    }

    // --- Tab 2: Themes (theme-pack cards) -----------------------------

    /**
     * @private Builds the Themes tab and adds it to `window`. Same
     * safe-to-call-more-than-once/remove-old-page-first pattern as
     * `_buildOverviewCardsTab()` above — used after a theme pack is
     * removed, to refresh the grid without leaving a duplicate
     * "Themes" tab in the switcher.
     */
    _buildThemesCardsTab(window, settings, storage, discoveredWidgets) {
        if (this._themesPage) {
            window.remove(this._themesPage);
            this._themesPage = null;
        }

        const scroll = new Gtk.ScrolledWindow({hexpand: true, vexpand: true});
        const flow = this._buildCardFlowBox();
        scroll.set_child(flow);

        const entries = this._discoverThemePacks();
        if (entries.length === 0) {
            flow.append(new Gtk.Label({
                label: this._tr('themes.empty', 'No theme packs found'),
                css_classes: ['dim-label'], margin_top: 48,
            }));
        }
        for (const entry of entries)
            flow.append(this._buildThemeCard(window, settings, entry));

        const page = this._buildClampedCardPage(
            this._tr('tab.themes.label', 'Themes'), 'preferences-desktop-wallpaper-symbolic', scroll);
        window.add(page);
        this._themesPage = page;
    }

    /** @private same bundled+user themepacks/ search paths
     * lib/widgetCenterOverlay.js's `_discoverThemePacks()` uses. A fresh
     * ThemePackRegistry is built on every call (cheap directory scan,
     * same reasoning the overlay's own `_discoverThemePacks()` gives)
     * so a pack dropped in/removed from disk since the last render is
     * always reflected. */
    _discoverThemePacks() {
        const bundledPath = GLib.build_filenamev([this.path, 'themepacks']);
        const userPath = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'gnome-widget-center', 'themepacks',
        ]);
        this._userThemepacksPath = userPath;
        const registry = new ThemePackRegistry([
            {path: bundledPath, source: 'bundled'},
            {path: userPath, source: 'user'},
        ]);
        return registry.discover();
    }

    _buildThemeCard(window, settings, entry) {
        const {manifest, path, source} = entry;
        const card = this._buildCardShell();
        card.append(this._buildCardBanner(this._resolveScreenshotPath(path, manifest)));

        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 4,
            margin_top: 12, margin_bottom: 12, margin_start: 14, margin_end: 14,
        });
        card.append(body);

        body.append(new Gtk.Label({
            label: manifest.name ?? entry.id, xalign: 0, css_classes: ['title-4'],
            ellipsize: Pango.EllipsizeMode.END, single_line_mode: true,
        }));

        if (manifest.description) {
            body.append(new Gtk.Label({
                label: manifest.description, xalign: 0, wrap: true, lines: 2,
                ellipsize: Pango.EllipsizeMode.END, css_classes: ['dim-label', 'caption'],
            }));
        }

        const metaBits = [];
        if (manifest.author)
            metaBits.push(`by ${manifest.author}`);
        metaBits.push(`${(manifest.widgets ?? []).length} widgets`);
        body.append(new Gtk.Label({
            label: metaBits.join(' · '), xalign: 0, css_classes: ['dim-label', 'caption'],
        }));

        // --- controls: Apply button + read-only "active" switch -------
        const controls = new Gtk.Box({
            spacing: 8, margin_top: 8, margin_bottom: 14, margin_start: 14, margin_end: 14,
        });
        card.append(controls);

        const applyButton = new Gtk.Button({
            label: this._tr('themes.card.apply', 'Apply'),
            css_classes: ['suggested-action'],
        });
        applyButton.connect('clicked', () => {
            this._applyThemePack(settings, entry);
            statusSwitch.active = true;
        });
        controls.append(applyButton);

        controls.append(new Gtk.Box({hexpand: true})); // spacer

        const statusLabel = new Gtk.Label({
            label: this._tr('themes.card.active', 'Active'), css_classes: ['dim-label', 'caption'],
        });
        controls.append(statusLabel);
        const statusSwitch = new Gtk.Switch({
            active: this._isThemePackActive(entry.id),
            sensitive: false, // read-only status indicator, not a toggle - see this file's header
            valign: Gtk.Align.CENTER,
        });
        controls.append(statusSwitch);

        // Remove button (user packs only) lives as a small overlay in
        // the banner's corner rather than counted among the two
        // controls above, matching this checkpoint's "2 buttons below:
        // Apply + status switch" spec literally.
        if (source === 'user') {
            const removeButton = new Gtk.Button({
                icon_name: 'window-close-symbolic',
                tooltip_text: this._tr('themes.card.remove', 'Remove'),
                css_classes: ['circular', 'osd'],
                halign: Gtk.Align.END, valign: Gtk.Align.START,
                margin_top: 8, margin_end: 8,
            });
            removeButton.connect('clicked', async () => {
                const confirmed = await confirmOverwrite(window,
                    this._tr('themes.card.remove_confirm_heading', 'Remove this theme pack?'),
                    this._tr('themes.card.remove_confirm_body',
                        `This deletes "${manifest.name ?? entry.id}" from your themepacks folder. This cannot be undone.`),
                    this._tr('themes.card.remove_confirm_button', 'Remove'));
                if (!confirmed)
                    return;
                try {
                    deleteRecursive(Gio.File.new_for_path(path));
                } catch (e) {
                    logError(e, `[widget-center] prefsV2: could not remove theme pack "${entry.id}"`);
                    return;
                }
                if (this._themesPage) {
                    window.remove(this._themesPage);
                    this._themesPage = null;
                }
                this._buildThemesCardsTab(window, settings, this._storage, this._discovered);
            });
            const overlay = new Gtk.Overlay();
            const banner = card.get_first_child();
            card.remove(banner);
            overlay.set_child(banner);
            overlay.add_overlay(removeButton);
            card.prepend(overlay);
        }

        return card;
    }

    /** @private true if `id` is the extension's currently active theme
     * pack (`active-theme-pack` GSettings key) — same key
     * lib/widgetCenterOverlay.js's `_isThemePackEnabled()` reads. */
    _isThemePackActive(id) {
        if (!this._settings?.isReady)
            return false;
        try {
            return this._settings.getGlobalValue('active-theme-pack') === id;
        } catch (e) {
            return false;
        }
    }

    /**
     * @private Applies a theme pack: enables every widget id it lists
     * (without disabling anything NOT in the pack — same "additive"
     * behavior lib/widgetCenterOverlay.js's `_loadThemePack()` already
     * documents choosing, for the same reason) and records it as the
     * active pack. Live widgets pick this up the same way any other
     * `disabled-widgets`/GSettings change does — extension.js's own
     * `onChanged` watcher in the Shell process, no direct coupling
     * needed from this GTK4 process.
     */
    _applyThemePack(settings, entry) {
        if (!settings.isReady)
            return;
        try {
            const current = new Set(settings.getGlobalValue('disabled-widgets'));
            for (const widgetId of entry.manifest.widgets ?? [])
                current.delete(widgetId);
            settings.setGlobalValue('disabled-widgets', Array.from(current));
            settings.setGlobalValue('active-theme-pack', entry.id);
        } catch (e) {
            logError(e, `[widget-center] prefsV2: could not apply theme pack "${entry.id}"`);
        }
    }

    // --- Tab 4: About --------------------------------------------------

    /**
     * @private The one tab in this file that DOES use a normal
     * Adw.PreferencesPage + titled Adw.PreferencesGroup(s) — see this
     * file's header for why that's fine here specifically (static
     * content, no grid). Icon is the new assets/wc-about-icon.svg
     * (loaded straight off disk, see that file's own header for why
     * it's not a named icon-theme icon), shown large at the top of the
     * page; the tab switcher itself still uses a plain symbolic icon
     * name (`help-about-symbolic`) for visual consistency with the
     * other three tabs' switcher icons.
     * @param {Adw.PreferencesWindow} window
     */
    _buildAboutTab(window) {
        const page = new Adw.PreferencesPage({
            title: this._tr('tab.about.label', 'About'),
            icon_name: 'help-about-symbolic',
        });
        window.add(page);

        // --- Header: logo, name, version, tagline ----------------------
        const headerGroup = new Adw.PreferencesGroup();
        page.add(headerGroup);

        const headerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            halign: Gtk.Align.CENTER, margin_top: 24, margin_bottom: 12,
        });

        const logoPath = GLib.build_filenamev([this.path, 'assets', 'wc-about-icon.svg']);
        if (fileExists(logoPath)) {
            const logo = new Gtk.Picture({
                content_fit: Gtk.ContentFit.CONTAIN,
                width_request: 96, height_request: 96,
                halign: Gtk.Align.CENTER,
            });
            logo.set_filename(logoPath);
            headerBox.append(logo);
        } else {
            headerBox.append(new Gtk.Image({icon_name: 'preferences-desktop-applications-symbolic', pixel_size: 96}));
        }

        headerBox.append(new Gtk.Label({
            label: this.metadata.name ?? 'GNOME Widget Center',
            css_classes: ['title-1'], justify: Gtk.Justification.CENTER,
        }));
        headerBox.append(new Gtk.Label({
            label: this._tr('about.tagline', 'A desktop widget platform for GNOME Shell'),
            css_classes: ['dim-label'], justify: Gtk.Justification.CENTER, wrap: true,
        }));
        headerGroup.add(headerBox);

        // --- Details: version, license, source, docs --------------------
        const detailsGroup = new Adw.PreferencesGroup({
            title: this._tr('about.details.title', 'Details'),
        });
        page.add(detailsGroup);

        const versionRow = new Adw.ActionRow({title: this._tr('about.version', 'Version')});
        versionRow.add_suffix(new Gtk.Label({label: String(this.metadata.version ?? '—'), css_classes: ['dim-label']}));
        detailsGroup.add(versionRow);

        detailsGroup.add(new Adw.ActionRow({
            title: this._tr('about.license', 'License'),
            subtitle: 'GNU General Public License v3.0',
        }));

        if (this.metadata.url) {
            const sourceRow = new Adw.ActionRow({
                title: this._tr('about.source', 'Source code'),
                subtitle: this.metadata.url,
                activatable: true,
            });
            sourceRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            sourceRow.connect('activated', () => Gtk.show_uri(window, this.metadata.url, Gdk.CURRENT_TIME));
            detailsGroup.add(sourceRow);
        }

        // --- What it does: written from the project's own README/------
        // WIDGET_API.md/metadata.json content, in this file's own
        // words rather than copied verbatim from either document.
        const aboutGroup = new Adw.PreferencesGroup({
            title: this._tr('about.project.title', 'About this project'),
        });
        page.add(aboutGroup);

        // A short, human-readable summary written for this About tab
        // specifically (not metadata.json's own `description`, which is
        // the denser one-paragraph blurb GNOME's Extensions website/app
        // shows and reads more like store copy than an About page).
        const aboutText = this._tr('about.project.body',
            'GNOME Widget Center brings desktop widgets to GNOME Shell, in the spirit ' +
            'of KDE Plasma widgets, while following the GNOME Human Interface Guidelines. ' +
            'It discovers and loads widget plugins from a folder — either bundled with the ' +
            'extension or installed under your own user data directory — and renders them ' +
            'on the desktop with free, pixel-precise placement and collision-aware ' +
            'drag-and-drop editing. Every widget gets its own settings page, generated ' +
            'automatically from a declarative configuration file, or a fully hand-written ' +
            'one for anything more custom. This Control Center is where you manage which ' +
            'widgets are installed and enabled (Overview), browse and apply shareable theme ' +
            'packs (Themes), and configure the extension\'s own appearance and behavior ' +
            '(Preferences).');
        const aboutLabel = new Gtk.Label({
            label: aboutText, wrap: true, xalign: 0,
            margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6,
        });
        aboutGroup.add(aboutLabel);

        const techRow = new Adw.ActionRow({
            title: this._tr('about.technology', 'Built with'),
            subtitle: 'GJS · GTK4 · Libadwaita · GObject/GSettings',
        });
        aboutGroup.add(techRow);
    }
}
