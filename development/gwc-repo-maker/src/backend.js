// backend.js - the ONLY place that talks to the outside world: runs the Python tools (tools/gwc_repo.py is JSON in/out)
// and streams build logs. The GUI holds no repo logic of its own.
import Gio from "gi://Gio";
import GLib from "gi://GLib";

export const APP_DIR = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
export const BUNDLED_TOOLS = GLib.getenv("GWC_TOOLS") || GLib.build_filenamev([ APP_DIR, "backend", "tools" ]);
export const KEY_DIR = GLib.getenv("GWC_KEY_DIR") || GLib.build_filenamev([ GLib.get_user_config_dir(), "gwc-repo-maker", "keys" ]);
// install.sh puts the dependencies in <app>/.venv; use that Python when it exists, otherwise the system one
const VENV_PY = GLib.build_filenamev([ APP_DIR, ".venv", "bin", "python3" ]);
const PY = GLib.getenv("GWC_PYTHON") || (GLib.file_test(VENV_PY, GLib.FileTest.IS_EXECUTABLE) ? VENV_PY : (GLib.find_program_in_path("python3") ?? "python3"));
const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);

/** tools dir for a repo: the repo's own copy (same version as its CI), else the bundled one */
export function toolsFor(repo) {
    const own = GLib.build_filenamev([ repo, "tools" ]);
    return exists(GLib.build_filenamev([ own, "gwc_repo.py" ])) ? own : BUNDLED_TOOLS;
}

/** python3 tools/gwc_repo.py [--repo R] --key-dir K ARGS -> parsed JSON ({ok, ...}); tool errors come back as {ok:false,error} */
export async function tool(repo, args, { initFrom = null } = {}) {
    const dir = initFrom ?? toolsFor(repo);
    const argv = [ PY, GLib.build_filenamev([ dir, "gwc_repo.py" ]), ...(repo && !initFrom ? [ "--repo", repo ] : []), "--key-dir", KEY_DIR, ...args ];
    try {
        const l = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
        l.setenv("PYTHONDONTWRITEBYTECODE", "1", true);
        const proc = l.spawnv(argv);
        const [ out, err ] = await new Promise((res, rej) => proc.communicate_utf8_async(null, null, (p, r) => { try { res(p.communicate_utf8_finish(r).slice(1)); } catch (e) { rej(e); } }));
        try { return JSON.parse(out); } catch (_e) { return { ok: false, error: (err || out || "the tool produced no output").trim().split("\n").slice(-4).join("\n") }; }
    } catch (e) {
        return { ok: false, error: `Could not start python3: ${e.message}` };
    }
}

/** Run a command, call onLine(text) per output line (stdout+stderr merged). Resolves { code }. */
export function streamRun(argv, { cwd = null, env = {}, onLine }) {
    return new Promise(resolve => {
        const l = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE });
        l.setenv("PYTHONDONTWRITEBYTECODE", "1", true); l.setenv("PYTHONUNBUFFERED", "1", true);
        for (const [ k, v ] of Object.entries(env)) l.setenv(k, v, true);
        if (cwd) l.set_cwd(cwd);
        let proc;
        try { proc = l.spawnv(argv); } catch (e) { onLine(`Could not start: ${e.message}`); resolve({ code: -1 }); return; }
        const rd = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() });
        const pump = () => rd.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, r) => {
            let line; try { [ line ] = s.read_line_finish_utf8(r); } catch (_e) { line = null; }
            if (line === null) { proc.wait_async(null, (p, r2) => { try { p.wait_finish(r2); } catch (_e) { /* */ } resolve({ code: p.get_exit_status() }); }); return; }
            onLine(line); pump();
        });
        pump();
    });
}

/** ids of the private keys in KEY_DIR (file names without .key), sorted */
export const listKeyIds = () => {
    try {
        const e = Gio.File.new_for_path(KEY_DIR).enumerate_children("standard::name", 0, null), out = [];
        for (let i = e.next_file(null); i; i = e.next_file(null)) if (i.get_name().endsWith(".key")) out.push(i.get_name().slice(0, -4));
        return out.sort();
    } catch (_e) { return []; }
};

export const readKey = kid => { try { return new TextDecoder().decode(Gio.File.new_for_path(GLib.build_filenamev([ KEY_DIR, `${kid}.key` ])).load_contents(null)[1]).trim(); } catch (_e) { return null; } };

/** build a preview (unsigned) or the real thing (signed with the repo's active key), streaming into onLine */
export async function build(repo, { signed, firstPublish, onLine }) {
    const t = toolsFor(repo), out = GLib.build_filenamev([ repo, "dist" ]);
    const argv = [ PY, GLib.build_filenamev([ t, "build_store.py" ]), "--out", out ];
    const env = {};
    if (!signed) argv.push("--unsigned");
    else {
        const st = await tool(repo, [ "status" ]);
        const kid = st.ok ? st.config.signKid : "";
        const seed = kid ? readKey(kid) : null;
        if (!seed) { onLine(`No private key for '${kid || "(none)"}' in ${KEY_DIR}. Create one on the Overview page, or build a preview instead.`); return { code: 2 }; }
        env.GWC_SIGNING_KEY = seed;
        argv.push(...(firstPublish ? [ "--first-publish" ] : [ "--prev-url", "auto" ]));      // build_store.py exits when given neither
    }
    return streamRun(argv, { cwd: repo, env, onLine });
}

export const verify = (repo, { signed, onLine }) =>
    streamRun([ PY, GLib.build_filenamev([ toolsFor(repo), "verify_store.py" ]), GLib.build_filenamev([ repo, "dist" ]),
        "--config", GLib.build_filenamev([ repo, "store.config.json" ]), ...(signed ? [] : [ "--unsigned" ]) ], { cwd: repo, onLine });

// ---------------------------------------------------------------------------------------------------------------------
// GitHub publishing (backend/gwc_publish.py): sign in, create the repository, upload dist/ to gh-pages, enable Pages.
// Stdlib-only Python, JSON in/out like tools/gwc_repo.py. It lives next to (not inside) backend/tools so ./sync-backend.sh keeps it.
// ---------------------------------------------------------------------------------------------------------------------
const PUBLISH_PY = GLib.build_filenamev([ APP_DIR, "backend", "gwc_publish.py" ]);
const lastJson = text => { for (const l of text.trim().split("\n").reverse()) { if (l.startsWith("{")) { try { return JSON.parse(l); } catch (_e) { /* keep looking */ } } } return null; };

/** One gwc_publish.py command -> parsed JSON ({ok, ...} / {ok:false, error, code}). `stdin` is how a pasted token is passed (never argv). */
export async function ghTool(args, { stdin = null } = {}) {
    try {
        const l = new Gio.SubprocessLauncher({ flags: (stdin !== null ? Gio.SubprocessFlags.STDIN_PIPE : 0) | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
        l.setenv("PYTHONDONTWRITEBYTECODE", "1", true);
        const proc = l.spawnv([ PY, PUBLISH_PY, "--key-dir", KEY_DIR, ...args ]);
        const [ out, err ] = await new Promise((res, rej) => proc.communicate_utf8_async(stdin, null, (p, r) => { try { res(p.communicate_utf8_finish(r).slice(1)); } catch (e) { rej(e); } }));
        return lastJson(out) ?? { ok: false, error: (err || out || "the publisher produced no output").trim().split("\n").slice(-4).join("\n") };
    } catch (e) {
        return { ok: false, error: `Could not start python3: ${e.message}` };
    }
}

/** Upload <repo>/dist to GitHub Pages (a repository of its own, or `folder` of an existing Pages site), streaming progress ("# ..." lines) into onLine. Resolves the final JSON result. */
export async function ghUpload(repo, repoName, { folder = null, cname = null, onLine }) {
    let last = null;
    const r = await streamRun([ PY, PUBLISH_PY, "--key-dir", KEY_DIR, "upload", "--repo-name", repoName, "--dist", GLib.build_filenamev([ repo, "dist" ]), ...(folder !== null ? [ "--folder", folder ] : []), ...(cname ? [ "--cname", cname ] : []) ], {
        cwd: repo, onLine: l => { if (l.startsWith("{")) { try { last = JSON.parse(l); return; } catch (_e) { /* plain text */ } } onLine(l.startsWith("# ") ? l.slice(2) : l); } });
    return last ?? { ok: false, error: `the upload stopped unexpectedly (${r.code})` };
}

/** { seq, expires } of the last build in <repo>/dist, or null */
export function lastBuild(repo) {
    try { const m = JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(GLib.build_filenamev([ repo, "dist", "store.json" ])).load_contents(null)[1])); return { seq: m.seq, expires: m.expires }; } catch (_e) { return null; }
}
