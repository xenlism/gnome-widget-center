// Pure tests for lib/store/prefsModel.js, plus checks that it agrees with the REAL repoConfig/integrity rules it mirrors.
import test from "node:test";
import assert from "node:assert/strict";
import { CHANNELS, channelNote, channelRow, rollbackConfirm, rollbackState, tierBadge, withChannel } from "../lib/store/prefsModel.js";
import { effectiveTier, visibleIn } from "../lib/store/integrity.js";

test("channel row: stable default, beta selectable, junk/missing config means stable", () => {
    assert.deepEqual(CHANNELS.map(c => c.id), [ "stable", "beta" ]);
    assert.equal(channelRow({ channel: "stable" }), 0);
    assert.equal(channelRow({ channel: "beta" }), 1);
    for (const bad of [ undefined, null, {}, { channel: "nightly" }, { channel: 1 } ]) assert.equal(channelRow(bad), 0, JSON.stringify(bad));
});

test("withChannel: sets beta/stable, never stores anything else, does not mutate", () => {
    const cfg = Object.freeze({ version: 1, channel: "stable", repos: [ { id: "x" } ] });
    assert.equal(withChannel(cfg, "beta").channel, "beta");
    assert.equal(withChannel({ ...cfg, channel: "beta" }, "stable").channel, "stable");
    for (const bad of [ "nightly", "", null, undefined, "BETA" ]) assert.equal(withChannel(cfg, bad).channel, "stable", String(bad));
    assert.equal(withChannel(cfg, "beta").repos, cfg.repos, "other fields carried over");
    assert.equal(cfg.channel, "stable");
});

test("the channel the UI saves is exactly what the client filters on (visibleIn)", () => {
    const stable = { id: "a" }, beta = { id: "b", ch: "beta" };
    assert.equal(visibleIn(beta, withChannel({}, "stable").channel), false);
    assert.equal(visibleIn(beta, withChannel({}, "beta").channel), true);
    assert.equal(visibleIn(stable, withChannel({}, "stable").channel), true);
});

test("channel note: nothing when unchanged; beta warns; leaving beta says installed betas stay", () => {
    assert.equal(channelNote("stable", "stable"), null);
    assert.match(channelNote("stable", "beta"), /unstable/);
    assert.match(channelNote("beta", "stable"), /stay as they are/);
});

test("tier badge: only the real 'official' tier is shown as official; everything else is community", () => {
    assert.equal(tierBadge("official").text, "Official"); assert.equal(tierBadge("official").style, "success");
    for (const t of [ "community", undefined, null, "gold", "OFFICIAL" ]) { assert.equal(tierBadge(t).text, "Community", String(t)); assert.equal(tierBadge(t).style, "warning"); }
});

test("tier badge fed by the real effectiveTier(): a community repo that CLAIMS official is shown as community", () => {
    const claims = { tier: "official" };
    assert.equal(tierBadge(effectiveTier({ official: false }, claims)).text, "Community");
    assert.equal(tierBadge(effectiveTier(undefined, claims)).text, "Community");
    assert.equal(tierBadge(effectiveTier({ official: true }, claims)).text, "Official");
    assert.equal(tierBadge(effectiveTier({ official: true }, { tier: "community" })).text, "Community");
});

test("rollback button: disabled without a kept version, enabled with version in the label; disk is the authority", () => {
    const none = rollbackState({ kind: "widgets", live: "2.0.0", kept: null, recorded: { v: "1.0.0" } });
    assert.equal(none.available, false, "registry remembering a prev is not enough: the files must exist");
    assert.equal(none.version, null);
    const yes = rollbackState({ kind: "widgets", live: "2.0.0", kept: { version: "1.0.0" }, recorded: { v: "1.0.0" } });
    assert.equal(yes.available, true); assert.equal(yes.label, "Roll back to 1.0.0"); assert.match(yes.tooltip, /2\.0\.0 → 1\.0\.0/); assert.match(yes.tooltip, /returns to where you are now/);
    const nover = rollbackState({ kind: "themepacks", kept: { version: null } });
    assert.equal(nover.available, true); assert.equal(nover.label, "Roll back"); assert.match(nover.tooltip, /theme pack/);
    assert.equal(rollbackState({ kind: "widgets", kept: { version: "0.9.0" }, recorded: null }).label, "Roll back to 0.9.0");
});

test("rollback confirm: widget mentions permissions of the older code, theme pack does not; never red", () => {
    const w = rollbackConfirm({ kind: "widgets", name: "Clock", live: "2.0.0", version: "1.0.0" });
    assert.equal(w.heading, "Roll back “Clock”?"); assert.equal(w.confirm, "Roll back"); assert.equal(w.danger, false);
    assert.match(w.body, /version 1\.0\.0 \(now 2\.0\.0\)/); assert.match(w.body, /can switch back/); assert.match(w.body, /permissions/);
    const t = rollbackConfirm({ kind: "themepacks", name: "Neon", version: null });
    assert.match(t.body, /the previous version/); assert.doesNotMatch(t.body, /permissions/);
});
