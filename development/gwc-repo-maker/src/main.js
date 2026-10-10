// GWC Repo Maker - GTK4 + libadwaita app (GJS) for creating and maintaining a GNOME Widget Center store repository.
// All repository logic lives in the Python tools (tools/gwc_repo.py, build_store.py); this app is the front end.
import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { Window } from "./window.js";

let opts = { repo: null, shots: null };
const app = new Adw.Application({ application_id: "io.github.xenlism.GwcRepoMaker", flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE });
app.add_main_option("repo", 0, GLib.OptionFlags.NONE, GLib.OptionArg.STRING, "Open this repository", "DIR");
app.add_main_option("screenshots", 0, GLib.OptionFlags.NONE, GLib.OptionArg.STRING, "Save a PNG of every page into DIR, then quit (testing)", "DIR");
app.connect("handle-local-options", (_a, d) => {
    const g = k => { const v = d.lookup_value(k, null); return v ? v.deepUnpack() : null; };
    opts = { repo: g("repo"), shots: g("screenshots") };
    return -1;
});
app.connect("command-line", () => { app.activate(); return 0; });
app.connect("activate", () => {
    let w = app.get_active_window();
    if (!w) w = new Window(app, opts);
    w.present();
});
app.run([ imports.system.programInvocationName, ...ARGV ]);
