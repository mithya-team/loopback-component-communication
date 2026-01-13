const _ = require('lodash');
module.exports = (CommunicationSetting) => {
    CommunicationSetting.createFromDefault = async function (settings) {
        try {
            const [commSettingIns] = await CommunicationSetting.find({
                where: {
                    or: [{ slug: settings.slug || 'communicationSetting' }],
                },
            });
            settings.slug = settings.slug || 'communicationSetting';
            if (
                !commSettingIns ||
                (commSettingIns && !commSettingIns.modified)
            ) {
                const modelName = CommunicationSetting.definition.name;
                const modelId = commSettingIns && commSettingIns.id;
                CommunicationSetting.getDataSource().connector.connect(
                    function (err, db) {
                        const dbCollection = db.collection(modelName);
                        if (modelId) {
                            dbCollection
                                .updateOne({ _id: modelId }, { $set: settings })
                                .then((res) => {
                                    console.log(res);
                                });
                        } else {
                            dbCollection.insertOne(settings).then((res) => {
                                console.log(res);
                            });
                        }
                    }
                );
            }
        } catch (error) {
            console.log(error);
            return Promise.reject(error);
        }
    };

    CommunicationSetting.observe('before save', async (ctx) => {
        const instance = ctx.instance || ctx.data;
        instance.modified = true;
        const userId = _.get(ctx, `options.accessToken.userId`, false);
        if (userId) {
            instance.userId = userId;
        }
    });

    return CommunicationSetting;
};
