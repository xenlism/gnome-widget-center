export function pickTranslation(map, key, fallback) {
    const value = map?.[key];
    return typeof value === "string" && value.length > 0 ? value : fallback;
}