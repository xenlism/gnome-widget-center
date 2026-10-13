// prefsPageBuilders.js - composes the page-builder mixins of the preferences window (split by area, see the imported files).
import { PrefsPageScaffoldMixin } from "./prefsPageScaffold.js";
import { PrefsDataCategoriesMixin } from "./prefsDataCategories.js";
import { PrefsAppearanceMixin } from "./prefsAppearanceCategory.js";
import { PrefsSettingsCategoriesMixin } from "./prefsSettingsCategories.js";
import { PrefsStoreCardsMixin } from "./prefsStoreCards.js";

export const PrefsPageBuildersMixin = Base =>
    PrefsStoreCardsMixin(PrefsSettingsCategoriesMixin(PrefsAppearanceMixin(PrefsDataCategoriesMixin(PrefsPageScaffoldMixin(Base)))));
