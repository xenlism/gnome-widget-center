// products/extension/lib/secretFields.js
//
// Task 11 (theme export/backup) — figures out which values in a widget's
// OWN settings (widgets/<id>.json, read via StorageService/WidgetSettings)
// are secrets that must never leave the machine in a `.gwct` theme export
// (see exportService.js). A `.gwcbak` full backup (backupService.js) does
// NOT use this — that file is a password-protected archive of everything,
// secrets included, since it's meant to restore an identical setup, not
// to be shared.
//
// "Secret" is decided two ways, both walked recursively over config.json's
// tabs -> groups -> fields (-> nested `object.properties` / `list.item`,
// see widgetConfigValidator.js for the exact shape):
//
//   1. `fieldType: "password"` — the widget author explicitly said so
//      (development/docs/WIDGET_API.md §6.4). This is authoritative.
//   2. `format: "email"` — also an explicit, structural signal (same
//      FORMATS enum as password's fieldType, see widgetConfigValidator.js).
//   3. A heuristic on the field's `id`/`label` for things config.json's
//      grammar has no dedicated fieldType/format for yet (API keys,
//      access tokens, usernames) — belt-and-suspenders for widgets that
//      modeled these as a plain `text` field instead of `password`.
//
// Redaction walks the SETTINGS VALUE in lockstep with the schema, not
// just the schema in isolation — a `list` of `object`s (e.g. "linked
// accounts", each with a `name` and an `accessToken`) needs its secret
// field stripped out of every array element, not just detected as
// "somewhere in this schema", or the array would sail through an export
// untouched. See getSecretFieldIds()'s doc comment below for the
// (narrower) flat-id-set view, still exported for anything that only
// needs "does this schema contain a secret anywhere".
//
// Legacy `metadata.json` "settings" array (§6.1) and hand-written
// `prefs.js` (§6.2) widgets have no declarative schema for us to read at
// all — for those (and for any key present in settings but absent from
// the schema), only the heuristic (point 3) applies, run directly
// against the key's own name.

/** Matches an "obviously secret" setting id/label even when the widget
 * author didn't mark it `fieldType: "password"` or `format: "email"`.
 * Deliberately broad (better to over-redact one honest field than leak
 * a real credential) — a false positive here just means one extra field
 * silently missing from the exported `.gwct`, which the user can always
 * re-enter by hand after import; a false negative would ship a live
 * credential in a file meant to be shareable. */
const SECRET_NAME_PATTERN =
    /(pass(word)?|api[_-]?key|apikey|secret|token|access[_-]?key|auth|credential|user[_-]?name|username|e-?mail)/i;

function _looksSecretByName(id, label) {
    return SECRET_NAME_PATTERN.test(String(id ?? '')) || SECRET_NAME_PATTERN.test(String(label ?? ''));
}

function _isSecretField(field) {
    return field?.fieldType === 'password' ||
        field?.format === 'email' ||
        _looksSecretByName(field?.id, field?.label);
}

/** @private normalizes an `object` field's `properties` map (keyed by
 * property name, values may omit their own `id`) into a plain array of
 * field-like descriptors, the same shape group.fields already has. */
function _propertiesToFieldList(properties) {
    if (!properties || typeof properties !== 'object')
        return [];
    return Object.entries(properties).map(([propId, propField]) => ({...propField, id: propField?.id ?? propId}));
}

/** @private walks one field (and, for `object`/`list` fields, whatever is
 * nested under it) collecting every secret field id it finds into `out`.
 * Used only by getSecretFieldIds() below — see that function's doc
 * comment for why it's a narrower tool than redactSecrets(). */
function _walkFieldIds(field, out) {
    if (!field || typeof field !== 'object')
        return;

    if (_isSecretField(field) && typeof field.id === 'string' && field.id)
        out.add(field.id);

    if (field.item)
        _walkFieldIds(field.item, out);
    for (const propField of _propertiesToFieldList(field.properties))
        _walkFieldIds(propField, out);
}

/**
 * @param {object|null} config - parsed config.json (widgetConfigReader's
 *   `readWidgetConfig().config`), or null for a widget with no config.json.
 * @returns {Set<string>} every field id anywhere in the schema (at any
 *   nesting depth) that's a secret. NOTE: this flattens nesting away, so
 *   it's only useful for a yes/no "does this schema contain a secret
 *   anywhere" check — redactSecrets() below is what actually removes
 *   secrets from a settings object correctly, INCLUDING ones nested
 *   inside a `list`/`object` field, which a flat id set can't express
 *   (an id here doesn't say WHERE it lives, e.g. "inside every element
 *   of the `accounts` array").
 */
export function getSecretFieldIds(config) {
    const out = new Set();
    if (!config || !Array.isArray(config.tabs))
        return out;

    for (const tab of config.tabs) {
        for (const group of tab.groups ?? []) {
            for (const field of group.fields ?? [])
                _walkFieldIds(field, out);
        }
    }
    return out;
}

/** @private redacts one plain settings object in place against a flat
 * list of field descriptors that apply AT THIS LEVEL (top-level
 * group.fields, or one `object` field's normalized `properties`).
 * Recurses into `list`/`object` fields so a secret nested arbitrarily
 * deep — e.g. `accounts[].accessToken` — is actually removed from every
 * array element, not just flagged as "present somewhere in the schema".
 * Also runs the plain name heuristic over any key NOT covered by a
 * schema field at this level, so legacy/no-schema settings and
 * copy-pasted field names both still get caught.
 * @param {object} valueObj - mutated in place.
 * @param {Array<object>} fields - field descriptors covering this level.
 * @param {string[]} removedKeys - appended to as keys are removed.
 */
function _redactObjectInPlace(valueObj, fields, removedKeys) {
    if (!valueObj || typeof valueObj !== 'object')
        return;

    const coveredIds = new Set();

    for (const field of fields) {
        const id = field?.id;
        if (typeof id !== 'string' || !id || !(id in valueObj))
            continue;
        coveredIds.add(id);

        if (_isSecretField(field)) {
            delete valueObj[id];
            removedKeys.push(id);
        } else if (field.fieldType === 'object' && field.properties) {
            _redactObjectInPlace(valueObj[id], _propertiesToFieldList(field.properties), removedKeys);
        } else if (field.fieldType === 'list' && field.item?.dataType === 'object' && Array.isArray(valueObj[id])) {
            const itemFields = _propertiesToFieldList(field.item.properties);
            for (const element of valueObj[id])
                _redactObjectInPlace(element, itemFields, removedKeys);
        }
        // Plain scalar / list-of-scalars fields that aren't secret: left as-is.
    }

    // Heuristic safety net for keys the schema at this level didn't cover
    // at all (legacy widgets, or a key the author forgot to declare).
    for (const key of Object.keys(valueObj)) {
        if (!coveredIds.has(key) && _looksSecretByName(key, null)) {
            delete valueObj[key];
            removedKeys.push(key);
        }
    }
}

/**
 * Redacts secret settings from ONE widget's settings object before it
 * goes into a `.gwct` export — the only entry point callers should use
 * (getSecretFieldIds() above is a narrower, flattened view kept for
 * simple "contains a secret?" checks).
 * @param {object} settings - one widget's full settings object, as read
 *   from `widgets/<id>.json`.
 * @param {object|null} config - parsed config.json, or null for a widget
 *   with no declarative schema (legacy `settings` array / prefs.js) —
 *   in which case only the name heuristic applies, at the top level only.
 * @returns {{redacted: object, removedKeys: string[]}} `redacted` is a
 *   deep-enough copy of `settings` with every secret value removed, at
 *   whatever depth it was found; `removedKeys` lists what was taken out
 *   (leaf key names, not full paths — enough for a human-readable "these
 *   fields were left out" summary), so a caller can show the user what
 *   didn't make it into the export.
 */
export function redactSecrets(settings, config) {
    // Bug fix: structuredClone() is a browser/Node global, not something
    // GJS guarantees - calling it here threw "structuredClone is not
    // defined" on every theme export, before any redaction logic even
    // ran. Widget settings are always plain JSON-serializable data (this
    // is exactly what gets round-tripped through widgets/<id>.json), so a
    // JSON.parse(JSON.stringify()) round-trip is a safe, dependency-free
    // deep clone here - no Dates/Maps/functions/circular refs to worry
    // about losing, unlike a general-purpose structuredClone() call site.
    const redacted = JSON.parse(JSON.stringify(settings ?? {}));
    const removedKeys = [];

    const topLevelFields = [];
    if (config && Array.isArray(config.tabs)) {
        for (const tab of config.tabs) {
            for (const group of tab.groups ?? [])
                topLevelFields.push(...(group.fields ?? []));
        }
    }

    _redactObjectInPlace(redacted, topLevelFields, removedKeys);

    return {redacted, removedKeys};
}
