// Node has APIs that older GJS (GNOME <= 46) lacks, so Node tests cannot catch them. Keep the store code off them.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../lib/store");
const BANNED = [ "structuredClone", "Object.groupBy", "Array.fromAsync", ".toSorted(", ".toReversed(", "navigator." ];

test("lib/store avoids APIs missing from older GJS", () => {
    for (const f of readdirSync(dir).filter(f => f.endsWith(".js")))
        for (const code of BANNED) assert.ok(!readFileSync(join(dir, f), "utf8").includes(code), `${f} uses ${code}`);
});
