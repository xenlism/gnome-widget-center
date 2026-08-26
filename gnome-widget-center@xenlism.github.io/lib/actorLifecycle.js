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

    const validSibling = sibling?.get_parent?.() === parent ? sibling : null;
    parent.insert_child_above(child, validSibling);
    return true;
}
