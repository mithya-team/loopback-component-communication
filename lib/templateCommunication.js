const _ = require('lodash');
function TemplateCommunication(app) {
    if (!app) {
        return Promise.reject(new Error(`app is required.`));
    }
    if (!(this instanceof TemplateCommunication)) {
        return new TemplateCommunication(app);
    }
    this.app = app;
    this.defaultCommSettings = require('./config/communicationSettings.json');
}

TemplateCommunication.prototype.setup = async function ({
    dataSource = 'db',
    settingModel = 'Setting',
    templateModel = 'Template',
    unsubscribeModel = 'Unsubscribe',
    communicationSettings = require('./config/communicationSettings.json'),
    scheduledCommSettings = {},
    messageProvider = {},
    customEmailFilter,
    twilio,
}) {
    // dataSource = ''
    const predefMessageModels = {
        email: 'Email',
        sms: 'Sms',
        pushNotification: 'PushNotification',
        inAppNotification: 'InAppNotification',
    };

    if (customEmailFilter && typeof customEmailFilter !== 'function') {
        return Promise.reject({
            statusCode: 400,
            message: 'customEmailFilter should be a function.',
        });
    }

    messageProvider = _.merge({}, predefMessageModels, messageProvider);
    _.each(_.keys(this.defaultCommSettings), (setting) => {
        // console.log(setting);
        communicationSettings[setting] = _.unionBy(
            communicationSettings[setting],
            this.defaultCommSettings[setting],
            'key'
        );
    });
    let App = this.app;
    for (const providerModel in messageProvider) {
        if (typeof messageProvider[providerModel] === 'string') {
            let Model = _.get(
                App,
                `models.${messageProvider[providerModel]}`,
                require('../index')[messageProvider[providerModel]]
            );
            if (Model && !App.models[Model.definition.name]) {
                App.model(Model, { dataSource, public: true });
            }
            if (providerModel === 'sms' && twilio) {
                if (twilio.sid && twilio.token) {
                    Model.init(twilio.sid, twilio.token);
                } else {
                    console.error(`Invalid twilio config.`);
                }
            }
        }
    }
    if (!dataSource || !App.dataSources[dataSource]) {
        return Promise.reject(new Error(`Provide a valid dataSource.`));
    }
    for (let provider in messageProvider) {
        const Model = App.models[messageProvider[provider]];
        if (typeof messageProvider[provider] === 'function') {
            let tmpProvider = messageProvider[provider];
            messageProvider[provider] = {};
            messageProvider[provider]['send'] = tmpProvider;
        } else {
            // console.log(
            //     `Applying ${messageProvider[provider]} model as message provider.`
            // );
            if (!App.models[messageProvider[provider]]) {
                const modelName = messageProvider[provider];
                console.warn(`${modelName} model provider has not been setup.`);
                messageProvider[provider] = {};
                messageProvider[provider]['send'] = async () => {
                    return Promise.reject(
                        new Error(`${modelName} model has not been setup.`)
                    );
                };
                continue;
            }
            messageProvider[provider] = App.models[messageProvider[provider]];
        }
    }

    let InAppModel = _.get(
        App,
        `models.InAppNotification`,
        require('../index').InAppNotification
    );

    let CommModel = _.get(
        App,
        `models.Communication`,
        require('../index').Communication
    );

    let CommTrackModel = _.get(
        App,
        `models.CommunicationTracking`,
        require('../index').CommunicationTracking
    );

    let ScheduledCommModel = _.get(
        App,
        `models.ScheduledCommunication`,
        require('../index').ScheduledCommunication
    );

    let UnsubscribeModel = _.get(
        App,
        `models.${unsubscribeModel}`,
        require('../index').Unsubscribe
    );

    const Models = [
        InAppModel,
        CommModel,
        CommTrackModel,
        ScheduledCommModel,
        UnsubscribeModel,
    ];
    const mixinSlug = require('./mixins/Slug');
    const mixinTimestamp = require('./mixins/Timestamp');

    mixinSlug(ScheduledCommModel, {});
    for (let Model of Models) {
        if (!Model) {
            return Promise.reject(
                new Error(`${Model.name} model has not been setup.`)
            );
        }
        mixinTimestamp(Model);
        if (typeof Model.initSettings === 'function') {
            const modelSettings = {
                templateModel: App.models[templateModel],
                settingModel: App.models[settingModel],
                communicationSettings: communicationSettings,
                scheduledCommSettings: scheduledCommSettings || {},
                messageProvider: messageProvider,
                customEmailFilter: customEmailFilter || this.customEmailFilter,
            };
            Model.initSettings(modelSettings);
        }
        if (!App.models[Model.definition.name]) {
            App.model(Model, { dataSource, public: true });
        }
        attachNotifyObservers(Model, 'send');
    }

    const mixinTrash = require('loopback-component-trash')(App, {
        dataSource,
        models: [ScheduledCommModel.modelName],
    });

    ////////////////////////////////////////////////////////////////////////////////////////////
};

const attachNotifyObservers = async function (
    Model,
    methodName,
    commSettings = {}
) {
    let providers = Object.keys(Model.messageProvider || {});
    for (let provider of providers) {
        let providerMethod = Model.messageProvider[provider][methodName];
        Model.messageProvider[provider][methodName] = async (incomingData) => {
            const ignoreEnvs = commSettings.ignoreEnvs || [];
            const NODE_ENV = process.env.NODE_ENV || 'development';
            if (ignoreEnvs.includes(NODE_ENV)) {
                console.info(incomingData);
                return;
            }
            const work = async function (data, done) {
                try {
                    let result = await providerMethod.call(
                        Model.messageProvider[provider],
                        data
                    );
                    done(null, result);
                } catch (error) {
                    done(error);
                }
            };
            return await new Promise((resolve, reject) => {
                Model.notifyObserversAround(
                    provider,
                    incomingData,
                    work,
                    function (err, result) {
                        if (err) reject(err);
                        resolve(result);
                    }
                );
            });
        };
    }
};

TemplateCommunication.prototype.setCustomEmailFilter = function (fn) {
    this.customEmailFilter = fn;
};

TemplateCommunication.prototype.smsAuth = function (sid, token) {
    this.smsConfig = { sid, token };
};
TemplateCommunication.prototype.setProvider = async function (
    providerName,
    cbFn
) {
    if (!(typeof cbFn === 'function')) {
        return Promise.reject(new Error(`cbFn must be a function.`));
    }
    this[providerName] = this[providerName] || {};
    this[providerName] = _.set(this, `${providerName}.send`, cbFn);
};
module.exports = TemplateCommunication;
