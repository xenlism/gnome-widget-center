# Project-Wide Handover & Architecture Document

---

## 1. Core Architecture & Grid Rules

* **10x10 Grid System:** The maximum grid boundary for any widget is strictly **10x10 blocks**, where each block equals **16px** (Total max footprint: **160px × 160px**).
* **Grid Enforcement:** All blocks and containers must be governed by the core grid engine to prevent layout breaking or coordinate overlapping.

---

## 2. Widget API & Object Standards

* **Root Container Requirement:** Every widget must initialize a root container (`St.BoxLayout` or `St.Bin`) *before* adding any child elements via `.add_child()`.
* **Overflow Protection:** Root containers must enforce clipping/hiding for any child elements exceeding boundaries (`clip_to_allocation = true` or `overflow: hidden`).
* **No Hardcoding:** Hardcoded pixel dimensions that violate the 10x10 (160px) grid rule are strictly prohibited in individual widget scripts.

---

## 3. Configuration & Metadata Contract

* **Metadata Limits:** All widget `metadata.json` files must declare `min-width`, `min-height`, `default-width`, `default-height`, `max-width`, and `max-height` values complying with the 10x10 grid ceiling.
* **Size Constraint Managers:** Core logic (`sizeConstraintManager.js`, `blockSizeManager.js`) must automatically sanitize widget dimensions to prevent invalid rendering out-of-bounds.