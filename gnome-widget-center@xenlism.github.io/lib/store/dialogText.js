// dialogText.js - the text of the "Install ...?" dialog, as a pure function so it is unit-tested and the wording
// of trust information (permissions, author, tier, channel, key changes) cannot drift from what was verified.
import { PERM_NOTE, describePerms, needsAttention } from "./permText.js";

export const CODE_WARNING = "Widgets run JavaScript inside GNOME Shell with your user's permissions. Only install widgets from sources you trust.";

/**
 * @param o.item     verified shard item
 * @param o.isW      widget (true) or theme pack
 * @param o.repo     { name, official? }
 * @param o.tier     effectiveTier(): "official" | "community"
 * @param o.expired  manifest past its signed `expires`
 * @param o.manifest verified manifest ({ updated, expires })
 * @param o.author   checkAuthor() result
 * @param o.pin      checkAuthorPin() result: "new" | "same" | "changed" | "lost"
 * @returns { heading, body, danger }  danger = the confirm button must be red
 */
export function installDialog({ item, isW, repo, tier, expired, manifest, author, pin }) {
    const lines = [ item.d, "" ];
    lines.push(`Version ${item.v} · by ${item.a} · ${item.c} · ${(item.s / 1024).toFixed(1)} KB`);
    lines.push(`Store: ${repo.name}${tier === "community" ? " (community store - not reviewed by the Widget Center project)" : ""}`);
    let danger = isW && tier !== "official";
    if (item.ch === "beta") lines.push("⚠ Beta release: it may be unstable.");
    if (isW) {
        lines.push("", ...describePerms(item.perm).map(l => `• ${l}`), PERM_NOTE);
        if (needsAttention(item.perm)) danger = true;
        if (author.status === "verified") lines.push("", `✓ Signed by its author: ${author.signer.name} (key ${author.signer.fingerprint.slice(0, 19)}…)`);
        else lines.push("", "Not signed by its author: only the store vouches for this widget.");
        if (pin === "changed") {
            lines.push("", "⚠ The author's signing key is DIFFERENT from the one you installed before. This can mean the store or the author's account was taken over.");
            danger = true;
        } else if (pin === "lost") {
            lines.push("", "⚠ You installed an author-signed version before; this one is NOT signed by its author.");
            danger = true;
        }
    }
    if (expired) lines.push("", `⚠ This store has not been updated since ${manifest.updated} (its signed validity ended ${manifest.expires.slice(0, 10)}). It may be abandoned.`);
    if (isW) lines.push("", CODE_WARNING);
    return { heading: `Install “${item.n}”?`, body: lines.join("\n"), danger };
}
