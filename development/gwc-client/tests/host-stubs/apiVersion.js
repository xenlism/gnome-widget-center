// TEST STUB of the host extension's lib/apiVersion.js. Supports api-version <= 2.
export const SUPPORTED_API = 2;
export function checkApiVersion(md) {
    const v = typeof md["api-version"] === "string" ? parseInt(md["api-version"], 10) : md["api-version"];
    if (!Number.isInteger(v)) return { ok: false, reason: "Invalid api-version" };
    return v <= SUPPORTED_API ? { ok: true } : { ok: false, reason: `Widget needs api-version ${v}, this app supports ${SUPPORTED_API}` };
}
