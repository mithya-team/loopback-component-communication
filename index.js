let loopback = '';

module.exports = (lb) => {
    if (!lb) {
        throw new Error(`Provide loopback object.`);
    }
    loopback = lb;
    setup();
    return require('./lib/templateCommunication');
};

function setup() {
    const DataModel = loopback.PersistedModel || loopback.DataModel;

    function loadModel(jsonFile) {
        const modelDefinition = require(jsonFile);
        return DataModel.extend(
            modelDefinition.name,
            modelDefinition.properties,
            {
                relations: modelDefinition.relations,
                acls: modelDefinition.acls,
            }
        );
    }

    const CommunicationSetting = loadModel(
        './lib/models/CommunicationSetting.json'
    );
    module.exports.CommunicationSetting = require('./lib/models/CommunicationSetting')(
        CommunicationSetting
    );
    module.exports.CommunicationSetting.autoAttach = 'db';

    const InAppModel = loadModel('./lib/models/InAppNotification.json');
    module.exports.InAppNotification = require('./lib/models/InAppNotification')(
        InAppModel
    );
    module.exports.InAppNotification.autoAttach = 'db';

    const Unsubscribe = loadModel('./lib/models/Unsubscribe.json');
    module.exports.Unsubscribe = require('./lib/models/Unsubscribe')(
        Unsubscribe
    );
    module.exports.Unsubscribe.autoAttach = 'db';

    const Communication = loadModel('./lib/models/Communication.json');
    module.exports.Communication = require('./lib/models/Communication')(
        Communication
    );
    module.exports.Communication.autoAttach = 'db';

    const CommunicationTracking = loadModel(
        './lib/models/CommunicationTracking.json'
    );
    module.exports.CommunicationTracking = require('./lib/models/CommunicationTracking')(
        CommunicationTracking
    );
    module.exports.CommunicationTracking.autoAttach = 'db';

    const ScheduledCommunication = loadModel(
        './lib/models/ScheduledCommunication.json'
    );
    module.exports.ScheduledCommunication = require('./lib/models/ScheduledCommunication')(
        ScheduledCommunication
    );
    module.exports.ScheduledCommunication.autoAttach = 'db';

    const Sms = loadModel('./lib/provider-models/Sms.json');
    module.exports.Sms = require('./lib/provider-models/Sms')(Sms);
    module.exports.Sms.autoAttach = 'db';
}
