export function rgbaToHex(rgba) {
    const toHex = c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
    return `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}`;
}