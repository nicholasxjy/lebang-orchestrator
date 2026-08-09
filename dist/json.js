export function sortJson(value) {
    if (Array.isArray(value)) {
        return value.map(sortJson);
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, sortJson(item)]));
    }
    return value;
}
export function formatJson(value) {
    return JSON.stringify(sortJson(value), null, 2);
}
export function formatJsonLine(value) {
    return JSON.stringify(sortJson(value));
}
//# sourceMappingURL=json.js.map