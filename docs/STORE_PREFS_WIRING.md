> **Status:** wired. The channel / tier / rollback code below now lives in `lib/prefs/storePage.js` (`buildStoreSettings`) and is shown
> under Preferences > Store; the browse/install UI is the Store tab (`lib/prefs/storeBrowsePage.js`). The snippets are kept as reference.

# Wiring channel / rollback / tier into the prefs window

NOT tested against the real prefs file (it is not in this archive) and not run under GTK. The logic it calls IS tested
(`tests/prefsModel.test.mjs`, `tests/gjs/rollback.test.js`). Adapt names to the real prefs code.

```js
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import { CHANNELS, channelNote, channelRow, rollbackConfirm, rollbackState, tierBadge, withChannel } from "./lib/store/prefsModel.js";
import { canRollback, rollbackInstalled } from "./lib/store/rollback.js";
import { effectiveTier } from "./lib/store/integrity.js";
import { loadRepoConfig, saveRepoConfig } from "./lib/store/repoConfig.js";
```

## 1. Channel (store settings group)
```js
let cfg = await loadRepoConfig();
const row = new Adw.ComboRow({ title: "Release channel", model: Gtk.StringList.new(CHANNELS.map(c => c.label)), selected: channelRow(cfg) });
row.connect("notify::selected", async () => {
    const next = CHANNELS[row.selected].id, note = channelNote(cfg.channel, next);
    cfg = withChannel(cfg, next); await saveRepoConfig(cfg);
    row.subtitle = note ?? CHANNELS[row.selected].hint;
    // recreate StoreClient(repo, { channel: cfg.channel }) and refresh the lists
});
```
`StoreClient` takes `channel` in its options; `getAllItems`, `search` and update checks already filter by it.

## 2. Tier badge (repo row and item header)
```js
const { manifest } = await client.getManifest();
const b = tierBadge(effectiveTier(repo, manifest));              // always pass effectiveTier(), never manifest.tier
const label = new Gtk.Label({ label: b.text, tooltip_text: b.tooltip, css_classes: [ "caption", b.style ] });
```

## 3. Rollback button (installed item row)
```js
const registry = await InstallRegistry.load();
const st = rollbackState({ kind, live: registry.get(kind, id)?.v, kept: canRollback(kind, id), recorded: registry.prevOf(kind, id) });
btn.label = st.label; btn.tooltip_text = st.tooltip; btn.sensitive = st.available;
btn.connect("clicked", () => {
    const c = rollbackConfirm({ kind, name, live: registry.get(kind, id)?.v, version: st.version });
    const d = new Adw.AlertDialog({ heading: c.heading, body: c.body });          // Adw >= 1.5
    d.add_response("cancel", "Cancel"); d.add_response("ok", c.confirm); d.set_default_response("cancel");
    d.choose(win, null, async (_d, res) => {
        if (d.choose_finish(res) !== "ok") return;
        try { await rollbackInstalled(registry, kind, id); /* refresh the row */ }
        catch (e) { /* show e.message in a toast */ }
    });
});
```
A widget is loaded by GNOME Shell: after a rollback tell the user it takes effect after the widget is reloaded
(or after re-login), the same as after an update.
