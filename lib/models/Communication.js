const _ = require('lodash');
const htmlToText = require('html-to-text');
const HTTP_STATUS_CODES = require('http-status-codes');
const { pe } = require('../utils/utils');
const moment = require('moment');
let NEXT_LOCK = 0;
const err = (code = 500, message) => {
    const error = new Error(message);
    error.statusCode = code;
    error.name = undefined;
    return error;
};
const SEND_EMAIL_TIMEOUT = 1000000;
module.exports = (Communication) => {
    // Will handle Email, Sms, pushNotification

    Communication.sendEmail = async function (
        where = {},
        dataFields = {},
        providerFields = {},
        userIds = [],
        rangeFilter,
        extras,
        options
    ) {
        where = { ...where, enabled: true };

        const templateInstance = await Communication.templateModel.findOne({
            where,
        });
        const templateId = templateInstance && templateInstance.id;
        if (!templateId) {
            return Promise.reject(
                err(HTTP_STATUS_CODES.NOT_FOUND, `template not found`)
            );
        }
        let attachments;
        if (templateInstance.attachments || templateInstance._attachments) {
            attachments =
                templateInstance.attachments || templateInstance._attachments;
        }
        if (attachments) {
            if (typeof attachments === 'function') {
                attachments = attachments();
            }

            providerFields.attachments = attachments;
        }

        let bulk = false;

        if (typeof userIds === 'string') {
            userIds = [userIds];
        }
        let [validUsers, invalidUsers] = await Communication.ValidateUserIds(
            userIds
        );

        let userEmails = [];
        if (validUsers.length > 0) {
            userEmails = await Communication.app.models.User.find({
                where: {
                    id: {
                        inq: validUsers,
                    },
                },
                fields: ['email'],
            });
            //TODO: what if no email
            // userEmails=userEmails.filter()
            userEmails = userEmails.map((item) => {
                return item.email;
            });
            console.log(`sending emails to ${userEmails}`);
        }

        providerFields.to = providerFields.to || [];
        if (!Array.isArray(providerFields.to)) {
            providerFields.to = [providerFields.to];
        }
        providerFields.to = providerFields.to.concat(userEmails);
        if (rangeFilter) {
            let emails = await Communication.getEmailsFromRange(rangeFilter);
            console.log(`Got ${emails} from rangeFilter`);
            providerFields.to = [...providerFields.to, ...emails];
        }
        if (providerFields.to.length > 1) {
            bulk = true;
            providerFields.to = _.uniq(providerFields.to);
        }
        for (const field in providerFields) {
            if (Array.isArray(providerFields[field])) {
                providerFields[field] = providerFields[field].filter((i) => i);
                if (providerFields[field].length === 0) {
                    providerFields = _.omit(providerFields, [field]);
                }
            }
        }
        let emailGlobalSettings = Communication.emailSettings || {};
        const mock = {
            ...emailGlobalSettings,
            ...providerFields,
            extras,
        };

        if (!bulk) {
            const generatedTemplate = await generateTemplate(
                templateId,
                dataFields,
                mock
            );
            let temp = {
                ...emailGlobalSettings,
                ...providerFields,
                ...generatedTemplate,
                extras,
            };
            for (const field in temp) {
                if (Array.isArray(temp[field])) {
                    temp[field] = temp[field].filter((i) => i);
                    if (temp[field].length === 0) {
                        temp = _.omit(temp, [field]);
                    }
                }
            }

            let result = await Promise.race([
                Communication.messageProvider.email.send(temp),
                new Promise((resolve, reject) => {
                    setTimeout(() => {
                        reject('Request timed out.');
                    }, SEND_EMAIL_TIMEOUT);
                }),
            ]);
            if (invalidUsers.length > 0) {
                result = { ...result, invalidUsers };
            }
            return result;
        } else {
            const emailResults = [];

            for (const receiver of providerFields.to) {
                const result = { email: receiver };
                let receiverProviderFields = Object.assign({}, providerFields);
                receiverProviderFields.to = receiver;
                const mock = {
                    ...emailGlobalSettings,
                    ...receiverProviderFields,
                    extras,
                };
                const generatedTemplate = await generateTemplate(
                    templateId,
                    dataFields,
                    mock
                );
                try {
                    await sendEmail({
                        ...emailGlobalSettings,
                        ...receiverProviderFields,
                        ...generatedTemplate,
                        extras,
                    });

                    // await
                    result.status = 'SUCCESS';
                } catch (error) {
                    result.status = 'FAILED';
                }
                emailResults.push(result);
            }

            const result = {};

            if (invalidUsers.length > 0) {
                result.invalidUsers = invalidUsers;
            }
            result.emailResults = emailResults;
            return result;
        }
    };

    const sendEmail = (data) => {
        let cb = async () => {
            try {
                await Promise.race([
                    Communication.messageProvider.email.send(data),
                    new Promise((resolve, reject) => {
                        setTimeout(() => {
                            reject('Request timed out.');
                        }, SEND_EMAIL_TIMEOUT);
                    }),
                ]);
            } catch (error) {
                let commTrackingInstance = _.get(
                    data,
                    `extras.commTrackingInstance`,
                    false
                );

                if (!commTrackingInstance || !data.to) {
                    return;
                }

                let failed = commTrackingInstance.failed || [];

                failed = [...failed, data.to];

                failed = _.uniq(failed);

                let sent = commTrackingInstance.sent || [];

                _.remove(sent, (email) => email === data.to);

                await commTrackingInstance.updateAttributes({
                    failed,
                    sent,
                });
                console.log(`----------------------------------`)
                console.log(error, data.to, data)
                console.log(`----------------------------------`)
            }
        };

        let checkInterval = setInterval(async () => {
            let _canSend = await canSend();
            if (!_canSend) {
                return;
            }
            clearInterval(checkInterval);
            await cb();
        }, 5000);
    };

    const canSend = async function () {
        //get current count
        if (NEXT_LOCK > 0) return false;
        NEXT_LOCK++;
        const refreshPeriod = Communication.emailSettings.refreshPeriod;
        const todaysCount = await Communication.count({
            created: {
                gte: moment().subtract(60000, 'ms').toDate(),
            },
        });
        const rateLimit = Communication.emailSettings.rateLimit;
        if (todaysCount >= rateLimit) {
            NEXT_LOCK > 0 && NEXT_LOCK--;
            return false;
        }
        return true;
    };

    const generateTemplate = async (templateId, dataFields, mock) => {
        const generatedTemplate = await Communication.templateModel.generateTemplate(
            templateId,
            { ...dataFields },
            mock
        );
        if (!generatedTemplate.subject) {
            return Promise.reject(err(404, 'Email subject is required.'));
        }
        if (!generatedTemplate.html) {
            return Promise.reject(err(404, 'Email html is required.'));
        }
        if (!generatedTemplate.text) {
            const text = htmlToText.fromString(generatedTemplate.html);
            if (!text.trim()) {
                return Promise.reject(err(404, 'Email text is required.'));
            }
            generatedTemplate.text = text;
        }
        return generatedTemplate;
    };

    Communication.sendSms = async function (
        where = {},
        dataFields = {},
        providerFields = {},
        userIds = [],
        rangeFilter,
        extras,
        options
    ) {
        let templateInstace = _.get(extras, 'templateInstance');
        if (!templateInstace) {
            templateInstace = await Communication.templateModel.findOne({
                where: where,
            });
        }
        let templateId = templateInstace.id;
        if (!templateId) {
            return Promise.reject(
                err(HTTP_STATUS_CODES.BAD_REQUEST, `templateId is required.`)
            );
        }
        let smsGlobalSettings = Communication.smsSettings || {};
        const mock = {
            ...smsGlobalSettings,
            ...providerFields,
            extras,
        };
        const generatedTemplate = await Communication.templateModel.generateTemplate(
            templateId,
            dataFields,
            mock
        );

        generatedTemplate.body =
            generatedTemplate.body || generatedTemplate.text || '';
        // TODO: check for multiple ontacts
        return await Communication.messageProvider.sms.send({
            ...smsGlobalSettings,
            ...generatedTemplate,
            ...providerFields,
            extras,
            options,
        });
    };

    Communication.sendPushNotification = async function ({
        templateId,
        providerFields,
    }) {
        if (!templateId) {
            return Promise.reject(
                err(HTTP_STATUS_CODES.BAD_REQUEST, `templateId is required`)
            );
        }
        const generatedTemplate = await Communication.templateModel.generateTemplate(
            templateId,
            'pushNotification'
        );
        let pushNotificationGlobalSettings =
            Communication.pushNotificationSettings || {};
        return await Communication.messageProvider.pushNotification.send({
            ...pushNotificationGlobalSettings,
            ...providerFields,
            ...generatedTemplate,
        });
    };

    Communication.initSettings = async function (settings) {
        Object.keys(settings).forEach((setting) => {
            Communication[setting] = settings[setting];
        });
        storeGlobalSettings({
            Communication,
            Template: Communication.templateModel,
        });
    };

    function storeGlobalSettings({ Communication, Template }) {
        const identifierType = ['email', 'sms', 'pushNotification'];
        const SettingModel = Communication.settingModel;
        let globalSettings = {};
        let settings;
        // if (!SettingModel) {

        if ((settings = Communication.communicationSettings['Communication'])) {
            let keyVal = {};
            let identifier = identifierType.shift();
            do {
                _.filter(settings, (item) => {
                    let [type, key] = item.key.split('_');
                    if (type === identifier) {
                        keyVal[key] = item.value;
                    }
                });
                Communication[`${identifier}Settings`] = { ...keyVal };
                keyVal = {};
            } while ((identifier = identifierType.shift()));
        }
        // }
    }

    Communication.ValidateUserIds = async (userIds) => {
        let validUsers = [],
            invalidUsers = [];
        let dbUsers = await Communication.app.models.User.find({
            fields: ['id'],
        });
        dbUsers = dbUsers.map((item) => {
            return item.id;
        });
        for (let userId of userIds) {
            if (_.find(dbUsers, (dbUser) => dbUser.toString() === userId)) {
                validUsers.push(userId);
            } else {
                invalidUsers.push(userId);
            }
        }
        return [validUsers, invalidUsers];
    };

    Communication.getEmailsFromRange = async (rangeFilter, userMap = false) => {
        if (Communication.customEmailFilter) {
            return await Communication.customEmailFilter(rangeFilter, userMap);
        }
        let users = await Communication.app.models.User.find(rangeFilter);
        let response = {};
        if (userMap) {
            // should be always 1-1 email-userId mapping
            users.map((i) => {
                if (i.email) {
                    //if 2 emails found , last found will be used to get information
                    response[i.email] = i.id.toString();
                }
            });
        }
        users = users.map((i) => i.email);
        users = users.filter((i) => i);
        users = _.uniq(users);

        if (userMap) {
            return {
                userMap: response,
                toEntities: users,
            };
        }
        return users;
    };

    const getNormalizedPhone = (phone = {}) => {
        return _.get(phone, 'countryCode', '') + _.get(phone, 'phone', '');
    };

    Communication.getPhonesFromRange = async (rangeFilter, userMap = false) => {
        if (Communication.customPhoneFilter) {
            return await Communication.customPhoneFilter(rangeFilter, userMap);
        }
        let users = await Communication.app.models.User.find(rangeFilter);
        let response = {};
        if (userMap) {
            // should be always 1-1 email-userId mapping
            users.map((i) => {
                if (i.phone) {
                    // normalize phone
                    const _phone = getNormalizedPhone(i.phone || {});
                    response[_phone] = i.id.toString();
                }
            });
        }
        users = users.map((i) => getNormalizedPhone(i.phone || {}));
        users = users.filter((i) => i);
        users = _.uniq(users);

        if (userMap) {
            return {
                userMap: response,
                toEntities: users,
            };
        }
        return users;
    };

    Communication.observe('before email', async (data) => {
        // let _meta
        let options = data.options || {};
        let scheduleId;
        if (data.extras && data.extras.jobSlug) {
            // _meta = {}
            // _meta.jobId = data.extras.jobSlug
            scheduleId = data.extras.jobSlug;
        }
        let _data = _.omit(data, ['extras', 'options']);
        const commInstance = await Communication.create(
            {
                channel: 'email',
                data: _data,
                scheduleId,
            },
            options
        );
        NEXT_LOCK > 0 && NEXT_LOCK--;
        if (data.extras) {
            data.extras.commInstance = commInstance;
        }
    });

    Communication.observe('before email', async (data) => {
        // check if this is a scheduled mail
        let commTrackingInstance = _.get(
            data,
            `extras.commTrackingInstance`,
            false
        );

        if (!commTrackingInstance) {
            return;
        }

        let updateSentEmails = [
            ...(commTrackingInstance.sent || []),
            Array.isArray(data.to) ? data.to[0] : data.to, // assuming there will always be a single provider.to
        ];
        updateSentEmails = _.uniq(updateSentEmails);

        await commTrackingInstance.updateAttributes({
            sent: [...updateSentEmails],
        });

        let scheduleInstance = _.get(data, `extras.scheduleInstance`, false);
    });

    Communication.observe('before sms', async (data) => {
        let options = data.options || {};
        // let _meta
        let scheduleId;
        if (data.extras && data.extras.jobSlug) {
            // _meta = {}
            // _meta.jobId = data.extras.jobSlug
            scheduleId = data.extras.jobSlug;
        }
        data = _.omit(data, ['extras', 'options']);
        await Communication.create(
            {
                channel: 'sms',
                data,
                scheduleId,
            },
            options
        );
    });

    var originalSetup = Communication.setup;

    Communication.setup = async function () {
        originalSetup.apply(this, arguments);
        Communication = this;

        Communication.remoteMethod('sendEmail', {
            accepts: [
                { arg: 'where', type: 'object', required: true },
                {
                    arg: 'data',
                    description: 'dataFields',
                    type: 'object',
                },
                { arg: 'providerFields', type: 'object' },
                { arg: 'userIds', type: ['string'] },
                { arg: 'range', type: 'object' },
                { arg: 'extras', type: 'object' },
                { arg: 'options', type: 'object', http: 'optionsFromRequest' },
            ],
            returns: {
                arg: 'response',
                type: 'object',
                root: true,
            },
        });
        Communication.remoteMethod('sendSms', {
            accepts: [
                { arg: 'where', type: 'object', required: true },
                {
                    arg: 'data',
                    description: 'dataFields',
                    type: 'object',
                },
                { arg: 'providerFields', type: 'object' },
                { arg: 'userIds', type: ['string'] },
                { arg: 'range', type: 'object' },
                { arg: 'extras', type: 'object' },
                { arg: 'options', type: 'object', http: 'optionsFromRequest' },
            ],
        });
        Communication.remoteMethod('sendPushNotification', {
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
    };

    Communication.setup();

    Communication.observe('before save', async (ctx) => {
        let instance = ctx.instance || ctx.data;
        if (ctx.isNewInstance) {
            let userId =
                ctx.options.accessToken && ctx.options.accessToken.userId;
            if (userId) {
                instance.userId = userId;
            }
        }
    });

    Communication.validateWhere = async (templateWhere) => {
        templateWhere = { ...templateWhere, enabled: true };
        // TODO: should this be find? what if multiple templates satisfy the query
        const templateInstance = await Communication.templateModel.findOne({
            where: templateWhere,
        });

        //check for template enabled?
        const templateId = templateInstance && templateInstance.id;
        if (!templateId) {
            return pe(HTTP_STATUS_CODES.BAD_REQUEST, 'Invalid template query.');
        }
        return templateInstance;
    };
    return Communication;
};
