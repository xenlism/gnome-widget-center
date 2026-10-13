// revocation.js - what to do when a store withdraws something you installed (signed `revoked[]` in store.json).
//   1. checkRevocations()  after every manifest refresh: FLAGS matching installs in the registry (no files touched)
//   2. the prefs UI shows registry.revokedList() with the store's reason and a "Disable" button
//   3. quarantineRevoked() runs only when the user pressed that button: it MOVES the item to
//      ~/.local/share/gnome-widget-center/quarantine/<kind>/ (reversible, nothing is deleted)
import { quarantine } from "./gwcFormat.js";

/**
 * @returns { all: [{kind,id,reason}], fresh: [...], cleared: [{kind,id}] }
 *   fresh   = newly flagged this time (show a notification for these)
 *   cleared = flagged earlier but the store no longer withdraws them (flag dropped)
 */
export async function checkRevocations(client, registry) {
    const all = await client.revocations(registry);
    const fresh = all.filter(h => !registry.get(h.kind, h.id)?.revoked);
    for (const h of fresh) await registry.markRevoked(h.kind, h.id, h.reason);
    const still = new Set(all.map(h => `${h.kind}/${h.id}`));
    const cleared = [];
    for (const kind of [ "widgets", "themepacks" ]) {
        for (const id of Object.keys(client.ownInstalls(registry, kind))) {
            if (registry.get(kind, id)?.revoked && !still.has(`${kind}/${id}`)) { await registry.clearRevoked(kind, id); cleared.push({ kind, id }); }
        }
    }
    return { all, fresh, cleared };
}

export function quarantineRevoked(registry, { kind, id }) {
    if (!registry.get(kind, id)?.revoked) throw new Error("This item is not flagged as withdrawn");
    return quarantine(kind, id);
}
