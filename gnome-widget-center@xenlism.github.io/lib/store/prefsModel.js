// prefsModel.js - what the prefs window SHOWS for channel / rollback / tier, as pure functions (no gi://, no I/O).
// The UI only turns these plain objects into widgets, so the wording and the rules are unit-tested and cannot drift.
//
//   channel : Adw.ComboRow  <- CHANNELS, current = channelRow(cfg);   on change: cfg = withChannel(cfg, id); saveRepoConfig(cfg)
//   tier    : badge next to the repo name / in the item header <- tierBadge(effectiveTier(repo, manifest))
//   rollback: button on an installed item  <- rollbackState(...);  confirm dialog <- rollbackConfirm(...)
//             on confirm: await rollbackInstalled(registry, kind, id)   (rollback.js; swaps both ways)

export const CHANNELS = [
    { id: "stable", label: "Stable", hint: "Only releases the author marked as stable. Recommended." },
    { id: "beta", label: "Beta", hint: "Also show and offer beta releases. They may be unstable." },
];

/** Index of the current channel in CHANNELS (for Adw.ComboRow.selected). Anything unknown means stable. */
export const channelRow = cfg => Math.max(0, CHANNELS.findIndex(c => c.id === cfg?.channel));

/** New config with the channel set; unknown values fall back to "stable" (same rule loadRepoConfig applies). Does not mutate. */
export const withChannel = (cfg, id) => ({ ...cfg, channel: id === "beta" ? "beta" : "stable" });

/**
 * Note shown when the user picks a channel, or null. Switching beta -> stable never downgrades anything: installed betas stay,
 * they just stop receiving further beta updates.
 */
export function channelNote(from, to) {
    if (from === to) return null;
    if (to === "beta") return "Beta releases may be unstable. Widgets still run with your user's permissions.";
    return "Betas you already installed stay as they are. New beta releases will not be shown or offered.";
}

/** @param tier effectiveTier(): "official" | "community" (anything else is treated as community: never show a false official badge) */
export function tierBadge(tier) {
    if (tier === "official") return { text: "Official", style: "success", tooltip: "Published and reviewed by the Widget Center project." };
    return { text: "Community", style: "warning", tooltip: "Run by a third party. Not reviewed by the Widget Center project: check the author before installing." };
}

/**
 * State of the Rollback button for an installed item.
 * @param o.kind        "widgets" | "themepacks"
 * @param o.live        version installed now (registry record .v, or null)
 * @param o.kept        canRollback(kind, id) -> { version } | null   (what is on disk)
 * @param o.recorded    registry.prevOf(kind, id) -> { v } | null     (what the registry remembers)
 */
export function rollbackState({ kind, live = null, kept = null, recorded = null }) {
    const version = kept?.version ?? recorded?.v ?? null;
    if (!kept) return { available: false, version: null, label: "Roll back", tooltip: "No previous version is kept. It is saved when you update." };
    const noun = kind === "widgets" ? "widget" : "theme pack";
    return {
        available: true, version,
        label: version ? `Roll back to ${version}` : "Roll back",
        tooltip: `Go back to the previous version of this ${noun}${live && version ? ` (${live} → ${version})` : ""}. Rolling back again returns to where you are now.`,
    };
}

/** Confirmation dialog for a rollback. A widget is code: the restored version's permissions are the old ones, say so. */
export function rollbackConfirm({ kind, name, live = null, version = null }) {
    const isW = kind === "widgets";
    const lines = [ `“${name}” will go back to ${version ? `version ${version}` : "the previous version"}${live ? ` (now ${live})` : ""}.` ];
    lines.push("The version you have now is kept, so you can switch back.");
    if (isW) lines.push("", "The older version runs with the permissions it declared back then. Rolling back does not download or re-verify anything.");
    return { heading: `Roll back “${name}”?`, body: lines.join("\n"), confirm: "Roll back", danger: false };
}
