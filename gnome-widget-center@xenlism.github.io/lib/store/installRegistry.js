// installRegistry.js - remembers WHERE each widget/pack came from. Decides what the Share button does.
//   src "store"  -> downloaded from a repo in the list       -> share as LINK
//   src "file"   -> imported from someone's .gwcw/.gwct      -> share as FILE
//   (no entry)   -> made by the user / copied by hand        -> share as FILE
import GLib from "gi://GLib";

import { readTextFileAsync, writeTextFileAsync } from "../fsUtils.js";
import { canonicalRepoUrl } from "./repoConfig.js";

const path = () => GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "store-installed.json" ]);

const onDisk = (kind, id) => kind === "widgets"
    ? GLib.file_test(GLib.build_filenamev([ GLib.get_user_data_dir(), "gnome-widget-center", "widgets", id ]), GLib.FileTest.EXISTS)
    : GLib.file_test(GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "themepacks", `${id}.gwct` ]), GLib.FileTest.EXISTS);

const safeCanonical = u => { try { return canonicalRepoUrl(u); } catch (_e) { return u; } };   // old official address -> current one

export class InstallRegistry {
    static async load() {
        const r = new InstallRegistry();
        try {
            const d = JSON.parse(await readTextFileAsync(path()) ?? "{}");
            r.data = { version: 1, widgets: d.widgets ?? {}, themepacks: d.themepacks ?? {} };
        } catch (_e) { r.data = { version: 1, widgets: {}, themepacks: {} }; }
        await r._pruneMissing();
        return r;
    }
    /**
     * A widget / pack that was deleted outside the store (Uninstall button, rm, the shell) must not stay "Installed":
     * drop the records whose files are gone, so the store offers Install again. Records of items that were never
     * written to the usual folders are left alone only if they still exist there - there is no other place to look.
     */
    async _pruneMissing() {
        let changed = false;
        for (const kind of [ "widgets", "themepacks" ]) {
            for (const id of Object.keys(this.data[kind])) {
                if (onDisk(kind, id)) continue;
                delete this.data[kind][id];
                changed = true;
            }
        }
        if (changed) { try { await this._save(); } catch (_e) { /* the in-memory registry is already correct */ } }
    }
    get(kind, id) { return this.data[kind][id] ?? null; }
    map(kind) { return this.data[kind]; }
    /** Remembers the record it replaces as `prev` (one level), mirroring the one rollback copy kept on disk. */
    record(kind, id, rec) {
        const old = this.data[kind][id];
        const next = { ...rec, at: Math.floor(Date.now() / 1000) };
        if (old) { const { prev: _p, revoked: _r, ...snap } = old; next.prev = snap; }
        this.data[kind][id] = next;
        return this._save();
    }
    /** { v } of the version a rollback would restore, or null */
    prevOf(kind, id) { const p = this.data[kind][id]?.prev; return p ? { v: p.v ?? null, src: p.src } : null; }
    /** Mirror of rollbackWidget/Themepack: the live record and its `prev` swap places. `liveVersion` = what the files say now. */
    recordRollback(kind, id, liveVersion) {
        const cur = this.data[kind][id];
        const { prev, revoked: _r, ...now } = cur ?? {};
        const restored = { ...(prev ?? { src: "file" }), v: liveVersion ?? prev?.v, at: Math.floor(Date.now() / 1000) };
        if (cur) restored.prev = now;          // the version we rolled back from stays one step away
        delete restored.revoked;
        this.data[kind][id] = restored;
        return this._save();
    }
    forget(kind, id) { delete this.data[kind][id]; return this._save(); }
    /** The store withdrew this item (revoked[]). Flag only; quarantine is a separate, explicit step. */
    markRevoked(kind, id, reason) {
        const r = this.data[kind][id]; if (!r) return Promise.resolve();
        r.revoked = { reason, at: Math.floor(Date.now() / 1000) }; return this._save();
    }
    revokedList() {
        return [ "widgets", "themepacks" ].flatMap(k => Object.entries(this.data[k]).filter(([ , r ]) => r.revoked).map(([ id, r ]) => ({ kind: k, id, reason: r.revoked.reason })));
    }
    /** { mode: "link", repoUrl } | { mode: "file" } */
    shareMode(kind, id) {
        const r = this.get(kind, id);
        return r?.src === "store" && r.repo ? { mode: "link", repoUrl: safeCanonical(r.repo) } : { mode: "file" };
    }
    _save() {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path()), 0o755);
        return writeTextFileAsync(path(), JSON.stringify(this.data));
    }
}
