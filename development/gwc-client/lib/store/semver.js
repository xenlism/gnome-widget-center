// semver.js - tiny version compare (pure). "1.2.3" > "1.2" > "1.1.9"; "1.0.0-beta" < "1.0.0".
const RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v) {
    const m = RE.exec(String(v ?? "").trim());
    if (!m) return null;
    return { n: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ? m[4].split(".") : [] };
}

/** -1 | 0 | 1, or null when either side is not a version. */
export function cmpVersion(a, b) {
    const x = parseVersion(a), y = parseVersion(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
    if (!x.pre.length && !y.pre.length) return 0;
    if (!x.pre.length) return 1;                 // release > prerelease
    if (!y.pre.length) return -1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i], q = y.pre[i];
        if (p === undefined) return -1;
        if (q === undefined) return 1;
        if (p === q) continue;
        const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
        if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
        if (pn !== qn) return pn ? -1 : 1;       // numeric identifiers sort before alphanumeric
        return p < q ? -1 : 1;
    }
    return 0;
}
