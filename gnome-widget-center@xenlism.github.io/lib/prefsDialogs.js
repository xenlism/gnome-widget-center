// products/extension/lib/prefsDialogs.js
//
// Split out of prefsWindowControllerBase.js (2026-08-01 lib/ cleanup pass) —
// small, stateless GTK4/Adwaita dialog helpers (password prompt, yes/no
// confirmation, report dialog, native file chooser) that never touched
// `this` on PrefsWindowController — they only ever needed the `window`
// (and other plain arguments) passed in, so moving them out and calling
// them as plain functions changes nothing about behavior, only where
// the code lives. Used by the Import/Export and Backup/Restore category
// builders in prefsWindowControllerBase.js.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

export function showReportDialog(window, title, bodyText) {
    const dialog = new Adw.MessageDialog({
        transient_for: window,
        heading: title,
        body: bodyText || '(nothing to report)',
        modal: true,
    });
    dialog.add_response('close', 'Close');
    dialog.present();
}

/**
 * theme export/import never needs one, see exportService.js's file
 * header). Resolves with the entered string, or null if the user
 * cancelled — callers must treat null as "abort the whole action",
 * never as an empty password.
 * @param {Adw.PreferencesWindow} window
 * @param {string} heading
 * @param {string} body
 * @returns {Promise<string|null>}
 */
export function promptPassword(window, heading, body) {
    return new Promise(resolve => {
        const dialog = new Adw.MessageDialog({transient_for: window, heading, body, modal: true});
        const entry = new Gtk.PasswordEntry({show_peek_icon: true, margin_top: 8});
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('ok', 'Continue');
        dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('ok');
        entry.connect('activate', () => dialog.response('ok'));
        dialog.connect('response', (_d, response) => {
            resolve(response === 'ok' ? entry.text : null);
        });
        dialog.present();
    });
}

/**
 * that overwrites the user's current settings/appearance wholesale —
 * importing a `.gwct` theme or restoring a `.gwcbak` backup. Neither
 * of those actions is undoable from inside this window (no "undo",
 * no diff-before-apply), so this is the only chance to back out
 * after the file/password has already been chosen.
 * @param {Adw.PreferencesWindow} window
 * @param {string} heading
 * @param {string} body
 * @param {string} [confirmLabel]
 * @returns {Promise<boolean>} true only if the user picked the
 *   destructive confirm button; false for Cancel OR the dialog being
 *   dismissed any other way (Esc, close button) — callers must treat
 *   anything other than true as "abort the whole action".
 */
export function confirmOverwrite(window, heading, body, confirmLabel = 'Overwrite') {
    return new Promise(resolve => {
        const dialog = new Adw.MessageDialog({transient_for: window, heading, body, modal: true});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('confirm', confirmLabel);
        dialog.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            resolve(response === 'confirm');
        });
        dialog.present();
    });
}

/**
 * based so the async export/import/backup/restore handlers below can
 * just `await` a chosen path instead of nesting callbacks.
 * @param {Adw.PreferencesWindow} window
 * @param {{action: 'save'|'open', title: string, initialName?: string,
 *           pattern?: string}} opts
 * @returns {Promise<string|null>} chosen path, or null if cancelled.
 */
export function chooseFile(window, opts) {
    return new Promise(resolve => {
        const action = opts.action === 'save'
            ? Gtk.FileChooserAction.SAVE
            : opts.action === 'select_folder'
                ? Gtk.FileChooserAction.SELECT_FOLDER
                : Gtk.FileChooserAction.OPEN;
        const chooser = new Gtk.FileChooserNative({
            title: opts.title,
            action,
            transient_for: window,
            modal: true,
            accept_label: opts.action === 'save' ? '_Save' : opts.action === 'select_folder' ? '_Select' : '_Open',
        });
        if (opts.initialName)
            chooser.set_current_name(opts.initialName);
        if (opts.initialFolder) {
            try {
                chooser.set_current_folder(Gio.File.new_for_path(opts.initialFolder));
            } catch (e) {
                // best-effort — an invalid/missing folder just leaves the
                // chooser at its own default starting location.
            }
        }
        if (opts.pattern) {
            const filter = new Gtk.FileFilter();
            filter.add_pattern(opts.pattern);
            filter.set_name(opts.pattern);
            chooser.add_filter(filter);
        }
        chooser.connect('response', (_c, response) => {
            const file = response === Gtk.ResponseType.ACCEPT ? chooser.get_file() : null;
            resolve(file ? file.get_path() : null);
            chooser.destroy();
        });
        chooser.show();
    });
}
