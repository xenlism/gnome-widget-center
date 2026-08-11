const DEFAULT_CONSTRAINTS = Object.freeze({
    minW: 50,
    minH: 50,
    maxW: 1e3,
    maxH: 1e3
});

export class SizeConstraintManager {
    static getConstraintsFor(metadata) {
        const declared = metadata?.["size-constraints"];
        if (!declared || typeof declared !== "object") return DEFAULT_CONSTRAINTS;
        return {
            minW: Number.isFinite(declared.minW) ? declared.minW : DEFAULT_CONSTRAINTS.minW,
            minH: Number.isFinite(declared.minH) ? declared.minH : DEFAULT_CONSTRAINTS.minH,
            maxW: Number.isFinite(declared.maxW) ? declared.maxW : DEFAULT_CONSTRAINTS.maxW,
            maxH: Number.isFinite(declared.maxH) ? declared.maxH : DEFAULT_CONSTRAINTS.maxH
        };
    }
    static _currentSize(actor) {
        let [width, height] = actor.get_size();
        if (width === 0 || height === 0) {
            const [, natWidth] = actor.get_preferred_width(-1);
            const [, natHeight] = actor.get_preferred_height(-1);
            width = width || natWidth;
            height = height || natHeight;
        }
        return [ width, height ];
    }
    static applyConstraints(metadata, actor) {
        const rules = this.getConstraintsFor(metadata);
        const [width, height] = this._currentSize(actor);
        const clampedWidth = Math.max(rules.minW, Math.min(width, rules.maxW));
        const clampedHeight = Math.max(rules.minH, Math.min(height, rules.maxH));
        if (clampedWidth === width && clampedHeight === height) return;
        actor.set_size(clampedWidth, clampedHeight);
    }
}