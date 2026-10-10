// permText.js - human wording for a widget's declared permissions (shown in the install dialog). Pure.
// Honest by design: permissions are DECLARED by the author and checked by a scanner at publish time. They are not enforced.
const KNOWN = {
    none: "Declares that it needs nothing special",
    network: "Can use the network",
    subprocess: "Can run other programs / open applications",
};
export function describePerms(perm) {
    return (perm ?? []).map(p => {
        if (KNOWN[p]) return KNOWN[p];
        const m = /^(fs-read|fs-write):(.+)$/.exec(p);
        if (m) return `${m[1] === "fs-read" ? "Can read" : "Can write"} files under ${m[2]}`;
        return `Unknown permission: ${p}`;
    });
}
/** true when the widget declares anything beyond "none" - the dialog highlights these */
export const needsAttention = perm => (perm ?? []).some(p => p !== "none");
export const PERM_NOTE = "Permissions are declared by the author and checked when the widget is published. They are not enforced: widgets are not sandboxed.";
