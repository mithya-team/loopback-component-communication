const _ = require('lodash');
module.exports = (InAppNotification) => {
    InAppNotification.sendInAppNotification = async function ({
        templateId,
        providerFields,
    }) {
        if (!templateId) {
            return Promise.reject(new Error(`templateId is required.`));
        }
        const generatedTemplate = await InAppNotification.templateModel.generateTemplate(
            templateId,
            'inAppNotification'
        );
        let inAppNotificationGlobalSettings =
            InAppNotification.inAppNotificationSettings || {};
        return await InAppNotification.messageProvider.inAppNotification.send({
            ...inAppNotificationGlobalSettings,
            ...providerFields,
            ...generatedTemplate,
        });
    };

    InAppNotification.remoteMethod('sendInAppNotification', {
        accepts: [
            {
                arg: 'data',
                description: 'templateId/providerFields',
                type: 'object',
                required: true,
                http: { source: 'body' },
            },
        ],
    });

    // InAppNotification.s

    InAppNotification.initSettings = async function (settings) {
        Object.keys(settings).forEach((setting) => {
            InAppNotification[setting] = settings[setting];
        });
        storeGlobalSettings({
            InAppNotification,
            Template: InAppNotification.templateModel,
        });
    };

    function storeGlobalSettings({ InAppNotification, Template }) {
        const identifierType = ['inApp'];
        const SettingModel =
            Template.app.models[InAppNotification.settingModel];
        let globalSettings = {};
        let settings;
        // if (!SettingModel) {

        if (
            (settings =
                InAppNotification.communicationSettings['Communication'])
        ) {
            let keyVal = {};
            let identifier = identifierType.shift();
            do {
                _.filter(settings, (item) => {
                    if (item.identifier === identifier) {
                        keyVal[item.key] = item.value;
                    }
                });
                InAppNotification[`${identifier}Settings`] = { ...keyVal };
                keyVal = {};
            } while ((identifier = identifierType.shift()));
        }
        // }
    }
    return InAppNotification;
};
