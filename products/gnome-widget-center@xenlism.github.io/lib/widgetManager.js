export class WidgetManager {

    resetWidget(widgetId) {
        const instance = this.getWidgetInstance(widgetId);
        if (!instance)
            return;

        // Reset settings; persistent layout storage retains presetSize & position
        this._settingsService.resetInstanceSettings(widgetId);

        // Reload widget using clean lifecycle (reads size directly from layout state)
        this.reloadWidget(widgetId);
    }

    reloadWidget(widgetId) {
        const instance = this.getWidgetInstance(widgetId);
        if (!instance)
            return;

        this._unloadWidgetActor(widgetId);
        this._createWidgetActor(widgetId);
    }

    _createWidgetActor(widgetId) {
        const instance = this.getWidgetInstance(widgetId);
        if (!instance)
            return;

        // Single source of truth: retrieve size directly from layout metadata
        const presetSize = instance.layout?.presetSize ?? 'small';

        const actor = this._widgetLoader.createActor(instance, presetSize);
        this._widgetLayer.addActor(actor, instance.layout?.position);
    }
}
