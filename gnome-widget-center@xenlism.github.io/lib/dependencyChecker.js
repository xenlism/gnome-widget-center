import GLib from "gi://GLib";

const PACKAGE_MANAGERS = [ {
    key: "apt",
    command: name => `sudo apt install ${name}`
}, {
    key: "dnf",
    command: name => `sudo dnf install ${name}`
}, {
    key: "pacman",
    command: name => `sudo pacman -S ${name}`
}, {
    key: "zypper",
    command: name => `sudo zypper install ${name}`
} ];

export function isBinaryAvailable(bin) {
    if (typeof bin !== "string" || !bin) return false;
    return GLib.find_program_in_path(bin) !== null;
}

export function suggestInstallCommand(packageHints) {
    if (!packageHints || typeof packageHints !== "object") return null;
    for (const {key: key, command: command} of PACKAGE_MANAGERS) {
        const packageName = packageHints[key];
        if (typeof packageName === "string" && packageName && isBinaryAvailable(key)) return command(packageName);
    }
    return null;
}

export function checkWidgetDependencies(metadata) {
    const declared = metadata?.dependencies?.system;
    if (!Array.isArray(declared)) return [];
    return declared.filter(dep => dep && typeof dep.bin === "string" && dep.bin).map(dep => ({
        bin: dep.bin,
        reason: typeof dep.reason === "string" ? dep.reason : "",
        installed: isBinaryAvailable(dep.bin),
        suggestedCommand: suggestInstallCommand(dep.package)
    }));
}

export function verifyWidgetDependencies(metadata) {
    const checked = checkWidgetDependencies(metadata);
    const missing = checked.filter(dep => !dep.installed);
    return {
        ok: missing.length === 0,
        missing: missing
    };
}