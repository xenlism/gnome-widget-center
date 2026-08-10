// products/extension/lib/themePackExportDialog.js
//
// "Export Theme…" dialog for building a shareable theme PACK file (not to
// be confused with the plain desktop-appearance `.gwct` export already in
// lib/exportService.js's Import/Export category — this reuses the exact
// same on-disk `.gwct` document/writer, but layers pack-authoring
// metadata on top: `name`, `description`, `author`, `url`, and a
// screenshot image, base64-embedded directly in the file (so the whole
// pack is one shareable file — no separate screenshot.png to lose track
// of, unlike the folder+theme.json form lib/themePackRegistry.js also
// supports). Opened from:
//   - Preferences window → Import/Export category (see
//     lib/prefsPageBuilders.js's "Export Theme Pack…" row).
//   - Widget Center overlay → Themes tab, either a specific pack's own
//     Export icon button (prefills name/description/author/url/widgets
//     from that pack) or the tab's own "Export current desktop…" action
//     (blank form, current live widget selection) — both routed through
//     widget-center-prefs-app.js's `--export-theme-id=`/
//     `--export-theme-new` flags since the overlay itself is St/Clutter,
//     not GTK (see widgetCenterOverlay.js's header for why every GTK4
//     window is a separate spawned process).
//
// GTK4/libadwaita only — never import St/Clutter/Meta/Shell here, same
// rule as every other file under prefsWindowControllerBase.js's dependency
// tree (see that file's header).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import {chooseFile, showReportDialog} from './prefsDialogs.js';
import {buildGwctDocument, writeGwctFile, ensureGwctExtension} from './exportService.js';
import {readBytesFile} from './fsUtils.js';

// chooseFile() (prefsDialogs.js) only accepts a single glob pattern, so
// the file-chooser's own filter is seeded with '*.png' (the common
// case) — the extension→mime lookup below still recognizes jpg/jpeg/webp
// too, for anyone who renames a file or types a full path in by hand.
const MIME_BY_EXTENSION = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

// 2026-08-10 ask: Email/URL are free-text Adw.EntryRow fields with no
// built-in format checking of their own (unlike e.g. a GtkSpinButton's
// numeric range) — a typo here silently ships in the exported .gwct and
// only surfaces much later, to whoever opens the pack, as a dead mailto/
// broken link. Deliberately permissive patterns (not a full RFC 5322/
// RFC 3986 validator — this is a "does this look like a plausible email/
// URL" sanity check, not a strict parser) so a legitimate-but-unusual
// address/URL isn't blocked. Both fields stay OPTIONAL — empty is valid,
// only a non-empty value that doesn't look like the thing it claims to be
// is rejected.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^https?:\/\/[^\s]+\.[^\s]+$/i;

/**
 * @param {Adw.PreferencesWindow|Adw.Window} parentWindow - transient_for.
 * @param {object} services - {storage, theme, settings, discoveredWidgets}
 *   same shape prefsPageBuilders.js's Import/Export category already has
 *   on hand.
 * @param {object} [prefill] - {name, description, author, url,
 *   widgetIds: string[]|null} — widgetIds null means "use whatever's
 *   currently enabled on the live desktop" (buildGwctDocument()'s normal
 *   behavior); a non-null array restricts the export to exactly those
 *   widget ids (used when re-exporting/editing an already-discovered
 *   pack, so re-exporting doesn't silently pick up unrelated widgets the
 *   user has separately enabled since).
 */
export function openThemePackExportDialog(parentWindow, services, prefill = {}) {
    const {storage, theme, settings, discoveredWidgets} = services;

    const window = new Adw.Window({
        transient_for: parentWindow,
        modal: true,
        default_width: 480,
        default_height: 560,
        title: 'Export Theme…',
    });

    const toolbarView = new Adw.ToolbarView();
    const header = new Adw.HeaderBar({show_end_title_buttons: true});
    toolbarView.add_top_bar(header);

    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
        title: 'Theme pack details',
        description: 'Shown to anyone who opens this .gwct file in their own Widget Center.',
    });
    page.add(group);

    const nameRow = new Adw.EntryRow({title: 'Name'});
    nameRow.text = prefill.name ?? '';
    group.add(nameRow);

    const descRow = new Adw.EntryRow({title: 'Description'});
    descRow.text = prefill.description ?? '';
    group.add(descRow);

    const authorRow = new Adw.EntryRow({title: 'Author'});
    authorRow.text = prefill.author ?? '';
    group.add(authorRow);

    const emailRow = new Adw.EntryRow({title: 'Email'});
    emailRow.text = prefill.email ?? '';
    group.add(emailRow);

    const urlRow = new Adw.EntryRow({title: 'URL'});
    urlRow.text = prefill.url ?? '';
    group.add(urlRow);

    // Live feedback as the user types/leaves the field — Adw.EntryRow
    // doesn't have a built-in "invalid" visual state, so this leans on
    // the same 'error' CSS class GTK4/libadwaita's own validated widgets
    // (e.g. Adw.PasswordEntryRow's strength indicator) already use for
    // this. Only ever flags a genuinely non-empty-and-wrong value — an
    // empty field is never marked invalid, since both fields are
    // optional (see EMAIL_PATTERN/URL_PATTERN's own comment).
    const markValidity = (row, pattern) => {
        const text = row.text.trim();
        const invalid = text.length > 0 && !pattern.test(text);
        row.set_css_classes(invalid ? ['error'] : []);
        return !invalid;
    };
    emailRow.connect('notify::text', () => markValidity(emailRow, EMAIL_PATTERN));
    urlRow.connect('notify::text', () => markValidity(urlRow, URL_PATTERN));

    // --- Screenshot picker: browse for an image file, read+base64 it
    // right away (kept in memory as {path, bytes, mime} until Save) so
    // the preview label can show a filename without re-reading on save.
    let screenshotPick = null; // {path, bytes: Uint8Array, mime}
    const screenshotRow = new Adw.ActionRow({title: 'Screenshot', subtitle: 'No image selected'});
    const screenshotButton = new Gtk.Button({label: 'Browse…', valign: Gtk.Align.CENTER});
    screenshotButton.connect('clicked', async () => {
        const path = await chooseFile(window, {action: 'open', title: 'Choose a screenshot image', pattern: '*.png'});
        if (!path)
            return;
        try {
            const bytes = readBytesFile(path);
            if (!bytes)
                throw new Error('could not read the chosen file');
            const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
            const mime = MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
            screenshotPick = {path, bytes, mime};
            screenshotRow.subtitle = GLib.path_get_basename(path);
        } catch (e) {
            logError(e, '[widget-center] themePackExportDialog: could not read screenshot');
            showReportDialog(window, 'Could not read screenshot', e.message);
        }
    });
    screenshotRow.add_suffix(screenshotButton);
    group.add(screenshotRow);

    // --- Bottom bar: Close / Export. Export itself pops the native
    // GNOME "Save File" dialog (Gtk.FileChooserNative, via chooseFile()'s
    // 'save' action) so the user picks the destination folder + filename
    // at export time, rather than this dialog carrying its own separate
    // Folder path/Filename fields (removed per the 2026-08-09
    // export-dialog simplification ask).
    const bottomBar = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.END,
        margin_top: 8,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });

    const closeButton = new Gtk.Button({label: 'Close'});
    closeButton.connect('clicked', () => window.close());
    bottomBar.append(closeButton);

    const exportButton = new Gtk.Button({
        label: 'Export',
        css_classes: ['suggested-action'],
    });
    exportButton.connect('clicked', async () => {
        if (!nameRow.text.trim()) {
            showReportDialog(window, 'Give this theme pack a name', 'The Name field can\'t be empty.');
            return;
        }

        // Hard gate (2026-08-10 ask), not just the live 'error' class
        // above — the live feedback is easy to miss (no shake/toast,
        // just a border color change), so Export itself re-checks both
        // fields and blocks with an explicit message rather than
        // silently shipping a malformed email/URL in the .gwct.
        if (!markValidity(emailRow, EMAIL_PATTERN)) {
            showReportDialog(window, 'Check the Email field',
                `"${emailRow.text.trim()}" doesn't look like a valid email address.`);
            return;
        }
        if (!markValidity(urlRow, URL_PATTERN)) {
            showReportDialog(window, 'Check the URL field',
                `"${urlRow.text.trim()}" doesn't look like a valid URL (must start with http:// or https://).`);
            return;
        }

        const defaultName = ensureGwctExtension(nameRow.text.trim().replace(/[^\w.-]+/g, '-') || 'theme-pack');
        const savePath = await chooseFile(window, {
            action: 'save',
            title: 'Save theme pack',
            initialName: defaultName,
            initialFolder: GLib.get_home_dir(),
            pattern: '*.gwct',
        });
        if (!savePath)
            return; // user cancelled the save dialog

        try {
            // buildGwctDocument() already gathers exactly the
            // appearance/hostSettings/widgets shape a plain desktop
            // export uses (see exportService.js's file header for
            // what's in/out — secrets are already redacted here, same
            // as the ordinary "Export theme…" row). `prefill.widgetIds`
            // restricts it to a specific pack's own widget set when
            // re-exporting one (rather than the doc's own "currently
            // enabled" default) by pre-filtering the candidate list.
            const candidates = prefill.widgetIds
                ? discoveredWidgets.filter(w => prefill.widgetIds.includes(w.id))
                : discoveredWidgets;
            const {document} = buildGwctDocument(candidates, {storage, theme, settings});

            document.packMeta = {
                id: (prefill.id ?? nameRow.text).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
                name: nameRow.text.trim(),
                description: descRow.text.trim(),
                author: authorRow.text.trim(),
                email: emailRow.text.trim(),
                url: urlRow.text.trim(),
            };
            if (screenshotPick) {
                document.screenshot = {
                    mimeType: screenshotPick.mime,
                    base64: GLib.base64_encode(screenshotPick.bytes),
                };
            }

            const finalPath = writeGwctFile(ensureGwctExtension(savePath), document);
            showReportDialog(window, 'Theme pack exported',
                `Saved to ${finalPath}\nWidgets included: ${document.widgets.length}`);
            window.close();
        } catch (e) {
            logError(e, '[widget-center] themePackExportDialog: export failed');
            showReportDialog(window, 'Export failed', e.message);
        }
    });
    bottomBar.append(exportButton);

    toolbarView.add_bottom_bar(bottomBar);
    toolbarView.set_content(new Gtk.ScrolledWindow({child: page, vexpand: true}));
    window.set_content(toolbarView);
    window.present();

    // Best-effort: the overlay's z-index fix (widgetCenterOverlay.js's
    // `_launchExternalPrefsWindow()`) already hides the St overlay while
    // ANY window from this process is open and re-shows it once every
    // window belonging to this process's app-id is gone — nothing
    // extra needed here for that to cover this dialog too, since it's
    // just another top-level window under the same Adw.Application.
    return window;
}
