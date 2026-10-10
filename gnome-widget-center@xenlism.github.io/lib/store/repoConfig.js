// repoConfig.js - ~/.config/gnome-widget-center/repos.json  (the "repo list")
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { readTextFileAsync, writeTextFileAsync } from "../fsUtils.js";

export const OFFICIAL_REPO = { id: "xenlism", name: "Xenlism Official Store",
    url: "https://xenlism.github.io/xenlism-gwc/", enabled: true, official: true };

/** Former addresses of the official store. A repos.json / install record that still has one is moved to OFFICIAL_REPO.url. */
export const LEGACY_OFFICIAL_URLS = [ "https://xenlism.github.io/gwc-store/" ];

/**
 * Public keys the OFFICIAL store may sign with (like a distro keyring). They are read from <extension>/keys/*.json:
 * each file is one { "kid": "gwc-2026-a", "pub": "<base64 ed25519 public key>" } or an array of them (the public half printed by
 * tools/gwc_keygen.py). Keep the NEXT key there too, one release before you start signing with it, so key rotation never needs a flag day.
 * Empty on purpose until a real key is added: the official store is then refused (fails closed, never "unsigned OK").
 * NEVER put a private key in keys/.
 */
export const OFFICIAL_KEYS = [];

const KID_OK = /^[A-Za-z0-9._-]{1,64}$/;
const PUB_OK = /^[A-Za-z0-9+/]{43}=$/;                 // 32 bytes, base64 with padding

/** Read keys/*.json next to the extension into OFFICIAL_KEYS. A bad file is logged and skipped, never fatal. */
function loadEmbeddedKeys() {
    try {
        const dir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent().get_child("keys");
        const en = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
        const names = [];
        for (let i = en.next_file(null); i; i = en.next_file(null)) {
            const n = i.get_name();
            if (i.get_file_type() === Gio.FileType.REGULAR && n.endsWith(".json") && !n.startsWith(".")) names.push(n);
        }
        for (const n of names.sort()) {
            try {
                const [ , bytes ] = dir.get_child(n).load_contents(null);
                const d = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
                for (const k of Array.isArray(d) ? d : [ d ]) {
                    if (typeof k?.kid !== "string" || !KID_OK.test(k.kid) || typeof k?.pub !== "string" || !PUB_OK.test(k.pub)) throw new Error("bad key entry");
                    if (!OFFICIAL_KEYS.some(x => x.kid === k.kid)) OFFICIAL_KEYS.push({ kid: k.kid, pub: k.pub });
                }
            } catch (e) { logError(e, `[widget-center] keys/${n} ignored`); }
        }
    } catch (_e) { /* no keys/ folder: official store stays refused */ }
}
loadEmbeddedKeys();

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

/** normalizeRepoUrl() + the official store's old addresses mapped to its current one (for comparing stored URLs). */
export function canonicalRepoUrl(input) {
    const n = normalizeRepoUrl(input);
    return LEGACY_OFFICIAL_URLS.includes(n) ? OFFICIAL_REPO.url : n;
}

export async function loadRepoConfig() {
    try {
        const text = await readTextFileAsync(path());          // null when the file does not exist
        if (!text) return cloneJson(DEFAULT_CONFIG);
        const cfg = JSON.parse(text);
        if (!Array.isArray(cfg.repos)) throw new Error("bad repos.json");
        cfg.checkIntervalHours = Math.min(Math.max(cfg.checkIntervalHours ?? 12, 1), 168);
        cfg.channel = cfg.channel === "beta" ? "beta" : "stable";          // "stable" unless the user opted in to betas
        for (const r of cfg.repos) {                       // the default URL changed: follow it, keep the user's enabled flag
            try { if (r.official && LEGACY_OFFICIAL_URLS.includes(normalizeRepoUrl(r.url))) r.url = OFFICIAL_REPO.url; } catch (_e) { /* keep as is */ }
        }
        for (const r of cfg.repos) {                       // a hand-edited file must not smuggle odd shapes into trust decisions
            if (r.official && r.url !== OFFICIAL_REPO.url) r.official = false;    // only OUR url may claim the embedded keys
            r.keys = Array.isArray(r.keys) ? r.keys.filter(k => typeof k?.kid === "string" && typeof k?.pub === "string") : [];
        }
        const seen = new Set();                            // two entries for one URL (e.g. after the move above) -> keep the first
        cfg.repos = cfg.repos.filter(r => { try { const u = normalizeRepoUrl(r.url); if (seen.has(u)) return false; seen.add(u); return true; } catch (_e) { return false; } });
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
    const n = canonicalRepoUrl(url);
    return cfg.repos.find(r => canonicalRepoUrl(r.url) === n) ?? null;
}

/** Build a repo entry (not saved). keys = the [{kid, pub}] the user pinned after seeing the fingerprint. */
export function makeRepo({ url, name, keys }) {
    const n = normalizeRepoUrl(url);
    const id = `r${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, n, -1).slice(0, 8)}`;
    return { id, name: name || GLib.Uri.parse(n, GLib.UriFlags.NONE).get_host(), url: n, enabled: true, official: false, keys: keys ?? [] };
}

export function addRepo(cfg, { url, name, keys }) {
    const n = canonicalRepoUrl(url);
    if (findRepoByUrl(cfg, n)) throw new Error("Repo already in list");
    cfg.repos.push(n === OFFICIAL_REPO.url ? cloneJson(OFFICIAL_REPO) : makeRepo({ url: n, name, keys }));
    return cfg;
}

/**
 * Change a repo's name and/or address (the list can hold any number of repos). A different address is a different store with
 * its own signing key, so the caller must pass the key the user just trusted for it (`keys`); the old pin never carries over.
 * The OFFICIAL_REPO address is the only one that is "official" (it uses the embedded keys); any other address is community.
 * Throws when the address is invalid or already used by another entry. Mutates and returns cfg.
 */
export function updateRepo(cfg, id, { url, name, keys }) {
    const repo = cfg.repos.find(r => r.id === id);
    if (!repo) throw new Error("Repo not found");
    const n = url === undefined ? canonicalRepoUrl(repo.url) : canonicalRepoUrl(url);
    const other = cfg.repos.find(r => r !== repo && canonicalRepoUrl(r.url) === n);
    if (other) throw new Error(`Repo already in list (${other.name ?? other.id})`);
    const moved = n !== canonicalRepoUrl(repo.url);
    if (moved) {
        if (n === OFFICIAL_REPO.url) { repo.official = true; repo.keys = []; }
        else {
            if (!keys?.length) throw new Error("A signing key must be trusted for the new address");
            repo.official = false; repo.keys = keys;
        }
        repo.url = n;
    }
    if (name !== undefined) repo.name = String(name).trim() || (repo.official ? OFFICIAL_REPO.name : GLib.Uri.parse(repo.url, GLib.UriFlags.NONE).get_host());
    return cfg;
}

/** Pin the signing key(s) the user just confirmed (by fingerprint) for this repo. Replaces earlier pins: the user is re-trusting. */
export function setRepoKeys(cfg, id, keys) {
    const repo = cfg.repos.find(r => r.id === id);
    if (!repo) throw new Error("Repo not found");
    if (!keys?.length) throw new Error("No key to pin");
    repo.keys = keys;
    return cfg;
}

export function setRepoEnabled(cfg, id, enabled) {
    const repo = cfg.repos.find(r => r.id === id);
    if (repo) repo.enabled = !!enabled;
    return cfg;
}

/** Point the repo back at the built-in official address (embedded keys, "official" tier). */
export function resetToOfficial(cfg, id) {
    return updateRepo(cfg, id, { url: OFFICIAL_REPO.url, name: OFFICIAL_REPO.name });
}

export function removeRepo(cfg, id) {
    cfg.repos = cfg.repos.filter(r => r.id !== id || r.official);   // official repo can be disabled, not removed (edit it or reset it instead)
    return cfg;
}
