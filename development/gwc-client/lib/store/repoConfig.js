// repoConfig.js - ~/.config/gnome-widget-center/repos.json  (the "repo list")
import GLib from "gi://GLib";

import { readTextFileAsync, writeTextFileAsync } from "../fsUtils.js";

export const OFFICIAL_REPO = { id: "xenlism", name: "Xenlism Official Store",
    url: "https://xenlism.github.io/gwc-store/", enabled: true, official: true };

/**
 * Public keys the OFFICIAL store may sign with (like a distro keyring). Put the public half printed by
 * tools/gwc_keygen.py here: { kid: "gwc-2026-a", pub: "<base64>" }. Keep the NEXT key listed here too, one release
 * before you start signing with it, so key rotation never needs a flag day.
 * Empty on purpose: until a real key is added the official store is refused (fails closed, never "unsigned OK").
 */
export const OFFICIAL_KEYS = [
    // { kid: "gwc-2026-a", pub: "..." },
];

export const DEFAULT_CONFIG = { version: 1, checkIntervalHours: 12, channel: "stable", repos: [ OFFICIAL_REPO ] };

// Older GJS (GNOME <= 46) has no built-in deep clone; the config is plain JSON so a JSON round trip is an exact copy.
const cloneJson = o => JSON.parse(JSON.stringify(o));
const path = () => GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "repos.json" ]);

/** https only (http allowed for localhost dev). Returns canonical "https://host/path/" or throws. */
export function normalizeRepoUrl(input) {
    const u = GLib.Uri.parse(String(input).trim(), GLib.UriFlags.NONE);
    const host = u.get_host();
    const ok = u.get_scheme() === "https" || (u.get_scheme() === "http" && (host === "localhost" || host === "127.0.0.1"));
    if (!ok || !host) throw new Error("Repo URL must be https://");
    let p = u.get_path() || "/";
    if (!p.endsWith("/")) p += "/";
    const port = u.get_port() > 0 && u.get_port() !== 443 ? `:${u.get_port()}` : "";
    return `${u.get_scheme()}://${host}${port}${p}`;          // query + fragment dropped
}

export async function loadRepoConfig() {
    try {
        const text = await readTextFileAsync(path());          // null when the file does not exist
        if (!text) return cloneJson(DEFAULT_CONFIG);
        const cfg = JSON.parse(text);
        if (!Array.isArray(cfg.repos)) throw new Error("bad repos.json");
        cfg.checkIntervalHours = Math.min(Math.max(cfg.checkIntervalHours ?? 12, 1), 168);
        cfg.channel = cfg.channel === "beta" ? "beta" : "stable";          // "stable" unless the user opted in to betas
        for (const r of cfg.repos) {                       // a hand-edited file must not smuggle odd shapes into trust decisions
            if (r.official && r.url !== OFFICIAL_REPO.url) r.official = false;    // only OUR url may claim the embedded keys
            r.keys = Array.isArray(r.keys) ? r.keys.filter(k => typeof k?.kid === "string" && typeof k?.pub === "string") : [];
        }
        return cfg;
    } catch (_e) {
        return cloneJson(DEFAULT_CONFIG);               // invalid -> defaults
    }
}

export async function saveRepoConfig(cfg) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path()), 0o755);
    await writeTextFileAsync(path(), JSON.stringify(cfg, null, 2));
}

export function findRepoByUrl(cfg, url) {
    const n = normalizeRepoUrl(url);
    return cfg.repos.find(r => normalizeRepoUrl(r.url) === n) ?? null;
}

/** Build a repo entry (not saved). keys = the [{kid, pub}] the user pinned after seeing the fingerprint. */
export function makeRepo({ url, name, keys }) {
    const n = normalizeRepoUrl(url);
    const id = `r${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, n, -1).slice(0, 8)}`;
    return { id, name: name || GLib.Uri.parse(n, GLib.UriFlags.NONE).get_host(), url: n, enabled: true, official: false, keys: keys ?? [] };
}

export function addRepo(cfg, { url, name, keys }) {
    const n = normalizeRepoUrl(url);
    if (findRepoByUrl(cfg, n)) throw new Error("Repo already in list");
    cfg.repos.push(makeRepo({ url: n, name, keys }));
    return cfg;
}

export function removeRepo(cfg, id) {
    cfg.repos = cfg.repos.filter(r => r.id !== id || r.official);   // official repo can be disabled, not removed
    return cfg;
}
