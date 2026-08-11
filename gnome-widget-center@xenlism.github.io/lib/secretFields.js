const SECRET_NAME_PATTERN = /(pass(word)?|api[_-]?key|apikey|secret|token|access[_-]?key|auth|credential|user[_-]?name|username|e-?mail)/i;

function _looksSecretByName(id, label) {
    return SECRET_NAME_PATTERN.test(String(id ?? "")) || SECRET_NAME_PATTERN.test(String(label ?? ""));
}

function _isSecretField(field) {
    return field?.fieldType === "password" || field?.format === "email" || _looksSecretByName(field?.id, field?.label);
}

function _propertiesToFieldList(properties) {
    if (!properties || typeof properties !== "object") return [];
    return Object.entries(properties).map(([propId, propField]) => ({
        ...propField,
        id: propField?.id ?? propId
    }));
}

function _walkFieldIds(field, out) {
    if (!field || typeof field !== "object") return;
    if (_isSecretField(field) && typeof field.id === "string" && field.id) out.add(field.id);
    if (field.item) _walkFieldIds(field.item, out);
    for (const propField of _propertiesToFieldList(field.properties)) _walkFieldIds(propField, out);
}

export function getSecretFieldIds(config) {
    const out = new Set;
    if (!config || !Array.isArray(config.tabs)) return out;
    for (const tab of config.tabs) {
        for (const group of tab.groups ?? []) {
            for (const field of group.fields ?? []) _walkFieldIds(field, out);
        }
    }
    return out;
}

function _redactObjectInPlace(valueObj, fields, removedKeys) {
    if (!valueObj || typeof valueObj !== "object") return;
    const coveredIds = new Set;
    for (const field of fields) {
        const id = field?.id;
        if (typeof id !== "string" || !id || !(id in valueObj)) continue;
        coveredIds.add(id);
        if (_isSecretField(field)) {
            delete valueObj[id];
            removedKeys.push(id);
        } else if (field.fieldType === "object" && field.properties) {
            _redactObjectInPlace(valueObj[id], _propertiesToFieldList(field.properties), removedKeys);
        } else if (field.fieldType === "list" && field.item?.dataType === "object" && Array.isArray(valueObj[id])) {
            const itemFields = _propertiesToFieldList(field.item.properties);
            for (const element of valueObj[id]) _redactObjectInPlace(element, itemFields, removedKeys);
        }
    }
    for (const key of Object.keys(valueObj)) {
        if (!coveredIds.has(key) && _looksSecretByName(key, null)) {
            delete valueObj[key];
            removedKeys.push(key);
        }
    }
}

export function redactSecrets(settings, config) {
    const redacted = JSON.parse(JSON.stringify(settings ?? {}));
    const removedKeys = [];
    const topLevelFields = [];
    if (config && Array.isArray(config.tabs)) {
        for (const tab of config.tabs) {
            for (const group of tab.groups ?? []) topLevelFields.push(...group.fields ?? []);
        }
    }
    _redactObjectInPlace(redacted, topLevelFields, removedKeys);
    return {
        redacted: redacted,
        removedKeys: removedKeys
    };
}