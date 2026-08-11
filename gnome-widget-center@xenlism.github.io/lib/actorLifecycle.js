// Actor-tree invariants shared by widgets that create transient UI.
// GNOME Shell may unmap or reparent actors between an input event and a
// delayed callback, so validate the tree immediately before layout work.

export function isMappedActor(actor, stage = null) {
    try {
        const actorStage = actor?.get_stage?.();
        return !!actorStage && (!stage || actorStage === stage);
    } catch (e) {
        return false;
    }
}

export function hasAllocation(actor) {
    if (!isMappedActor(actor))
        return false;

    try {
        const [width, height] = actor.get_size();
        return width > 0 && height > 0;
    } catch (e) {
        return false;
    }
}

export function insertChildAboveSafely(parent, child, sibling = null) {
    if (!isMappedActor(parent))
        return false;

    // A sibling that has already been removed/reparented must never be
    // passed to Clutter; that is the source of insert_child_above warnings.
    const validSibling = sibling?.get_parent?.() === parent ? sibling : null;
    parent.insert_child_above(child, validSibling);
    return true;
}
