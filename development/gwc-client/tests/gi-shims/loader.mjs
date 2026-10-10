// Node module-hook: maps gi://X to ./X.mjs (minimal fakes of GLib/Gio/Soup, enough to LOGIC-test storeClient.js in Node).
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
export async function resolve(specifier, context, next) {
    if (specifier.startsWith("gi://")) {
        const name = specifier.slice(5).split("?")[0];
        return { url: pathToFileURL(join(here, `${name}.mjs`)).href, shortCircuit: true };
    }
    return next(specifier, context);
}
