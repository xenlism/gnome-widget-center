// revocation.js - what to do when a store withdraws something you installed (signed `revoked[]` in store.json).
//   1. checkRevocations()  after every manifest refresh: FLAGS matching installs in the registry (no files touched)
//   2. the prefs UI shows registry.revokedList() with the store's reason and a "Disable" button
//   3. quarantineRevoked() runs only when the user pressed that button: it MOVES the item to
//      ~/.local/share/gnome-widget-center/quarantine/<kind>/ (reversible, nothing is deleted)
import { quarantine } from "./gwcFormat.js";

/** @returns { all: [{kind,id,reason}], fresh: [...] }  fresh = newly flagged this time (show a notification for these) */
export async function checkRevocations(client, registry) {
    const all = await client.revocations(registry);
    const fresh = all.filter(h => !registry.get(h.kind, h.id)?.revoked);
    for (const h of fresh) await registry.markRevoked(h.kind, h.id, h.reason);
    return { all, fresh };
}

export function quarantineRevoked(registry, { kind, id }) {
    if (!registry.get(kind, id)?.revoked) throw new Error("This item is not flagged as withdrawn");
    return quarantine(kind, id);
}
