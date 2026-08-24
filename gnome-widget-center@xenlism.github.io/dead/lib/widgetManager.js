export class WidgetManager {
    resetWidget(widgetId) {
        const instance = this.getWidgetInstance(widgetId);
        if (!instance) return;
        this._settingsService.resetInstanceSettings(widgetId);
        this.reloadWidget(widgetId);
    }
    reloadWidget(widgetId) {
        const instance = this.getWidgetInstance(widgetId);
        if (!instance) return;
        this._unloadWidgetActor(widgetId);
        this._createWidgetActor(widgetId);
    }
    _createWidgetActor(widgetId) {
        const instance = this.getWidgetInstance(widgetId);
        if (!instance) return;
        const presetSize = instance.layout?.presetSize ?? "small";
        const actor = this._widgetLoader.createActor(instance, presetSize);
        this._widgetLayer.addActor(actor, instance.layout?.position);
    }
}