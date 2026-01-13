'use strict';

const _ = require('lodash');
const {
    pe,
    isValidDates,
    isValidCron,
    validateData,
} = require('../utils/utils');
const scheduleStatus = require('../config/scheduleStatus.json');
const HTTP_STATUS_CODES = require('http-status-codes');
const { template } = require('lodash');
const schedule = require('node-schedule');
const moment = require('moment');
// TODO: make a lock file in order to check if some schedule is currently running

module.exports = (ScheduledCommunication) => {
    // ScheduledCommunication.validatesUniquenessOf('jobName');
    const getRecipients = async (channel, rangeFilter, userMap = false) => {
        let recipients;
        if (channel === 'email') {
            recipients = await ScheduledCommunication.app.models.Communication.getEmailsFromRange(
                rangeFilter,
                userMap
            );
            return recipients;
        }
        if (channel === 'sms') {
            recipients = await ScheduledCommunication.app.models.Communication.getPhonesFromRange(
                rangeFilter,
                userMap
            );
            return recipients;
        }
    };

    const getAlreadySentEntities = async (
        channel,
        templateWhere,
        scheduleInstance
    ) => {
        if (channel === 'email') {
            let alreadySentToEmails = await ScheduledCommunication.getAlreadySentEmails(
                templateWhere,
                scheduleInstance
            );
            return alreadySentToEmails;
        }
    };

    ScheduledCommunication.addSchedule = async (
        jobName, //jobName will be converted to slug
        channel,
        recurrenceRule,
        scheduledAt = [],
        templateWhere = {},
        wherePid = 3,
        sendOnce = false,
        dataFields = {},
        rangeFilter,
        options
    ) => {
        let existing = typeof options === 'boolean';
        let existingScheduleInstance, existingCommTrackingInstance;
        if (existing) {
            existingScheduleInstance = this.scheduleInstance;
            existingCommTrackingInstance = this.commTrackingInstance;
            if (!existingScheduleInstance) {
                return pe('existingScheduleInstance not found.');
            }
            if (!existingCommTrackingInstance) {
                return pe('existingCommTrackingInstance not found.');
            }
        }

        if (!recurrenceRule && _.isEmpty(scheduledAt)) {
            return pe(
                HTTP_STATUS_CODES.BAD_REQUEST,
                'recurrenceRule or scheduledAt is required'
            );
        }
        if (recurrenceRule && !_.isEmpty(scheduledAt)) {
            return pe(
                HTTP_STATUS_CODES.BAD_REQUEST,
                'Can specify only recurrenceRule or scheduledAt'
            );
        }
        if (recurrenceRule) {
            if (!isValidCron(recurrenceRule, { seconds: true })) {
                return pe(HTTP_STATUS_CODES.BAD_REQUEST, 'Invalid cron rule');
            }
        }

        if (!_.isEmpty(scheduledAt)) {
            if (!Array.isArray(scheduledAt)) {
                scheduledAt = [scheduledAt];
            }
            if (!isValidDates(scheduledAt)) {
                return pe(
                    HTTP_STATUS_CODES.BAD_REQUEST,
                    'Invalid scheduled dates'
                );
            }
        }

        if (_.isEmpty(templateWhere)) {
            return pe(
                HTTP_STATUS_CODES.BAD_REQUEST,
                'templateWhere is required'
            );
        }

        let templateInstance = await ScheduledCommunication.app.models.Communication.validateWhere(
            templateWhere
        );

        // Check if dataFields are satisfied

        await ScheduledCommunication.templateModel.getRequiredFields(
            templateWhere,
            dataFields
        );
        // TODO: check for similar schedule
        // TODO: check if slug already exist
        let recipients = [];
        // can wherePid be updated later?

        if (wherePid !== 2 && !existing) {
            //FIXME: error on wherePid 3?
            recipients = await getRecipients(channel, rangeFilter);
        }

        const task = ScheduledCommunication.getChannelTask(channel);
        let jobSlug;
        let job, scheduleInstance, commTrackingInstance;
        if (existing) {
            jobSlug = existingScheduleInstance.slug;
            job = existingScheduleInstance.name;
            scheduleInstance = existingScheduleInstance;
            sendOnce = existingScheduleInstance.sendOnce;
            commTrackingInstance = existingCommTrackingInstance;
        }
        const asyncTask = async function (fireDate) {
            // job;
            // scheduleInstance;
            scheduleInstance = await ScheduledCommunication.findById(
                scheduleInstance.id
            );
            templateInstance = await ScheduledCommunication.templateModel.findOne(
                { where: scheduleInstance.templateWhere }
            );

            commTrackingInstance = await ScheduledCommunication.app.models.CommunicationTracking.findById(
                commTrackingInstance.id
            );
            sendOnce = scheduleInstance.sendOnce;
            if (!job.pendingInvocations) {
                // re waking the new job
                job = ScheduledCommunication.scheduledJobs[jobSlug].job;
            }
            if (_.isEmpty(job.pendingInvocations())) {
                await scheduleInstance.updateAttributes({
                    status: scheduleStatus.COMPLETED,
                });
            }
            if (channel !== 'email' && channel !== 'sms') {
                return;
            }
            let userMap = {};
            if (wherePid !== 1) {
                let {
                    userMap: _userMap,
                    toEntities,
                    emails,
                } = await getRecipients(channel, rangeFilter, true);
                userMap = _userMap;
                let _toEntities = [...(toEntities || []), ...(emails || [])];
                //sendOnce will only work in !1 pid else it doesnt make sense
                if (sendOnce) {
                    let alreadySentToEntities = await getAlreadySentEntities(
                        channel,
                        templateWhere,
                        scheduleInstance
                    );
                    _toEntities = [...recipients, ..._toEntities];
                    _.remove(
                        _toEntities,
                        (entity) =>
                            !!_.find(alreadySentToEntities, (e) => e === entity)
                    );
                } else {
                    recipients = _toEntities; // necessary?
                }
                // recipients = [...recipients, ...emails];
                recipients = _.uniq(_toEntities);
            } else {
                recipients = [
                    ...recipients,
                    ...(scheduleInstance.recipients || []),
                ];
            }
            if (_.isEmpty(recipients)) {
                return;
            }

            ScheduledCommunication.scheduledJobs[jobSlug].status =
                scheduleStatus.RUNNING;

            if ((process.env.NODE_ENV || 'development') === 'development') {
                console.log({
                    templateWhere,
                    dataFields,
                    recipients,
                    sch: {
                        jobSlug,
                        userMap,
                        commTrackingInstance,
                        scheduleInstance,
                    },
                });
                return;
            }
            //Email Task for now
            task(
                templateWhere,
                dataFields,
                { to: recipients },
                undefined,
                undefined,
                {
                    jobSlug,
                    userMap,
                    commTrackingInstance,
                    scheduleInstance,
                    templateInstance,
                }
            )
                .then((e) => {
                    ScheduledCommunication.scheduledJobs[jobSlug].status =
                        scheduleStatus.IN_PROGRESS;
                })
                .catch((err) => {
                    console.error(
                        `Error while running async task for job ${jobSlug} --- ${err.message}`
                    );
                });
        }.bind(this, jobSlug, job, scheduleInstance);

        if (recurrenceRule) {
            job = createRecurrenceSchedule(jobName, recurrenceRule, asyncTask);
            job = _.omit(job, ['callback', '_eventsCount']);
            if (existing) {
                return setRunningSchedule(
                    jobSlug,
                    job,
                    scheduleInstance.toJSON()
                );
            }
        } else {
            // scheduledAt
            job = await createDateSchedule(
                jobName,
                [...scheduledAt],
                asyncTask,
                existing
            );
            if (job.status === scheduleStatus.COMPLETED || existing) {
                if (job.status === scheduleStatus.COMPLETED) {
                    await scheduleInstance.updateAttributes({
                        status: scheduleStatus.COMPLETED,
                    });
                }
                return setRunningSchedule(
                    jobSlug,
                    job,
                    scheduleInstance.toJSON()
                );
            }
            job = _.omit(job, ['callback', '_eventsCount']);
        }

        const newInstanceData = {
            ...job,
            jobName,
            channel,
            recurrenceRule,
            scheduledAt,
            templateWhere,
            wherePid,
            sendOnce,
            dataFields,
            rangeFilter,
            recipients: wherePid !== 2 ? recipients : [],
            status: scheduleStatus.IN_PROGRESS,
        };

        try {
            scheduleInstance = await ScheduledCommunication.create(
                newInstanceData,
                options
            );
            commTrackingInstance = await ScheduledCommunication.app.models.CommunicationTracking.create(
                { scheduleId: scheduleInstance.id.toString() },
                options
            );

            let templateScheduleIds = templateInstance.scheduleIds || [];

            templateScheduleIds = _.uniq([
                ...templateScheduleIds,
                scheduleInstance.id,
            ]);

            await templateInstance.updateAttributes({
                scheduleIds: templateScheduleIds,
            });

            await scheduleInstance.updateAttributes({
                trackingId: commTrackingInstance.id.toString(),
            });
        } catch (e) {
            job.cancel();
            throw e;
        }
        jobSlug = scheduleInstance.slug;
        return setRunningSchedule(jobSlug, job, scheduleInstance.toJSON());
    };
    //TODO: editing schedule

    ScheduledCommunication.editSchedule = async function (
        jobSlug,
        newData = {}
    ) {
        const scheduleInstance = await ScheduledCommunication.findById(jobSlug);
        if (!scheduleInstance) {
            return pe(HTTP_STATUS_CODES.BAD_REQUEST, `Invalid id.`);
        }

        // TODO: editing a reccurence rule schedule
        if (!_.isEmpty(scheduleInstance.recurrenceRule)) {
            return pe(
                HTTP_STATUS_CODES.NOT_IMPLEMENTED,
                `Reccurence editing not implemented.`
            );
        }

        return await editDateSchedule(scheduleInstance, newData);
    };

    const editDateSchedule = async (scheduleInstance, newData) => {
        //Handling for date schedule
        newData = _.pick(newData, [
            'scheduledAt',
            'jobName',
            'sendOnce',
            'wherePid',
            'templateWhere',
            'dataFields',
            'rangeFilter',
        ]);

        if (_.isEmpty(newData)) {
            return scheduleInstance.toJSON();
        }

        let jobSlug = scheduleInstance.slug;
        // find which dates are removed added

        // let changedDates = [
        //     ..._.difference(
        //         scheduleInstance.scheduledAt, // current
        //         newData.scheduledAt // new
        //     ),
        // ];

        // remove them from jobs too if there is one
        let schedule = ScheduledCommunication.scheduledJobs[jobSlug];
        if (!schedule || !schedule.job) {
            // job is stopped or completed, directly update the instance
            return await scheduleInstance.updateAttributes({
                ...newData,
            });
        }

        scheduleInstance = await scheduleInstance.updateAttributes({
            ...newData,
        });

        let newJob;

        // if (!_.isEmpty(changedDates)) {
        schedule.job.cancel && schedule.job.cancel();

        newJob = await createDateSchedule(
            newData.jobName || scheduleInstance.jobName,
            newData.scheduledAt || [],
            schedule.job.job || schedule.job.asyncTask,
            true
        );
        // }
        if (newJob.status !== scheduleStatus.COMPLETED) {
            await scheduleInstance.updateAttributes({
                status: scheduleStatus.IN_PROGRESS,
            });
        } else {
            if (scheduleInstance.status !== scheduleStatus.COMPLETED) {
                await scheduleInstance.updateAttributes({
                    status: scheduleStatus.COMPLETED,
                });
            }
        }
        return setRunningSchedule(
            jobSlug,
            newJob || schedule.job,
            scheduleInstance.toJSON()
        );
    };

    ScheduledCommunication.stopSchedule = async function (id) {
        const scheduleInstance = await ScheduledCommunication.findById(id);
        if (!scheduleInstance) {
            return pe(HTTP_STATUS_CODES.BAD_REQUEST, 'Invalid id.');
        }
        await scheduleInstance.updateAttributes({
            enabled: false,
            status: scheduleStatus.STOPPED,
        });

        let jobSlug = scheduleInstance.slug;

        let schedule = ScheduledCommunication.scheduledJobs[jobSlug];

        if (schedule && schedule.job) {
            _.isFunction(schedule.job.cancel) && schedule.job.cancel(); // check for case: schedule already stopped
            return setRunningSchedule(
                jobSlug,
                schedule.job,
                scheduleInstance.toJSON()
            );
        }

        return {
            ...scheduleInstance.toJSON(),
            error: 'Job is not running in the system',
        };
    };

    ScheduledCommunication.deleteSchedule = async function (id) {
        const scheduleInstance = await ScheduledCommunication.findById(id);
        if (!scheduleInstance) {
            return pe(HTTP_STATUS_CODES.BAD_REQUEST, 'Invalid id.');
        }
        const stoppedSchedule = await ScheduledCommunication.stopSchedule(id);
        return ScheduledCommunication.moveToTrash([id]);
    };

    ScheduledCommunication.startSchedule = async function (id) {
        const scheduleInstance = await ScheduledCommunication.findById(id);
        if (!scheduleInstance) {
            return pe(HTTP_STATUS_CODES.BAD_REQUEST, 'Invalid id.');
        }
        if (scheduleInstance.status === scheduleStatus.COMPLETED) {
            return pe(
                HTTP_STATUS_CODES.BAD_REQUEST,
                'Cannot start completed schedule.'
            );
        }
        await scheduleInstance.updateAttributes({
            enabled: true,
            status: scheduleStatus.IN_PROGRESS,
        });
        let jobSlug = scheduleInstance.slug;
        let schedule = ScheduledCommunication.scheduledJobs[jobSlug];
        if (schedule && schedule.job) {
            if (!_.isEmpty(schedule.scheduledAt)) {
                let jobCopy = await createDateSchedule(
                    schedule.name,
                    [...schedule.scheduledAt],
                    schedule.job.job,
                    true
                );
                if (jobCopy.status === scheduleStatus.COMPLETED) {
                    await scheduleInstance.updateAttributes({
                        enabled: true,
                        status: scheduleStatus.COMPLETED,
                    });
                    return setRunningSchedule(
                        jobSlug,
                        schedule.job,
                        scheduleInstance.toJSON()
                    );
                }
                schedule.job = jobCopy;
            } else {
                schedule.job = createRecurrenceSchedule(
                    schedule.name,
                    schedule.recurrenceRule,
                    schedule.job.job
                );
            }
            // schedule.job.reschedule(schedule.options);
            return schedule;
        } else {
            // let [job] = await ScheduledCommunication.init([scheduleInstance]);
            return setRunningSchedule(
                jobSlug,
                schedule.job,
                scheduleInstance.toJSON()
            );
        }
    };

    const originalSetup = ScheduledCommunication.setup;
    ScheduledCommunication.setup = async function () {
        originalSetup.apply(this, arguments);
        ScheduledCommunication = this;

        ScheduledCommunication.remoteMethod('addSchedule', {
            accepts: [
                { arg: 'jobName', type: 'string', required: true }, //job slug to keep track
                { arg: 'channel', type: 'string', required: true }, // email, sms
                { arg: 'recurrenceRule', type: 'string', required: false }, // cron rule
                { arg: 'scheduledAt', type: ['string'], required: false }, // future dates
                { arg: 'templateWhere', type: 'object', required: true }, // TemplateModel where query
                { arg: 'wherePid', type: 'number', required: false }, // [1,2,3] 1= immidiateWhere, 2= dynamicWhere, 3= bothWhere. 1 is default
                { arg: 'sendOnce', type: 'boolean', required: false }, // dont include users to which email has already been sent, usually will come with dynamicWhere
                { arg: 'dataFields', type: 'object', required: false }, // html required variables to replace if any
                { arg: 'rangeFilter', type: 'object', required: true }, // range query for recipient's (users)
                { arg: 'options', type: 'object', http: 'optionsFromRequest' },
            ],
            returns: {
                arg: 'response',
                root: true,
                type: 'object',
            },
            http: { path: '/:channel/schedule', verb: 'POST' },
        });

        ScheduledCommunication.remoteMethod('stopSchedule', {
            accepts: [{ arg: 'id', type: 'string', required: true }],
            returns: {
                arg: 'response',
                root: true,
                type: 'object',
            },
            http: { path: '/:id/stopSchedule', verb: 'PATCH' },
        });

        ScheduledCommunication.remoteMethod('startSchedule', {
            accepts: [{ arg: 'id', type: 'string', required: true }],
            returns: {
                arg: 'response',
                root: true,
                type: 'object',
            },
            http: { path: '/:id/startSchedule', verb: 'PATCH' },
        });
        ScheduledCommunication.remoteMethod('editSchedule', {
            accepts: [
                { arg: 'id', type: 'string', required: true },
                { arg: 'newData', type: 'object', required: true },
            ],
            returns: {
                arg: 'response',
                root: true,
                type: 'object',
            },
            http: { path: '/:id/editSchedule', verb: 'PATCH' },
        });
        ScheduledCommunication.remoteMethod('deleteSchedule', {
            accepts: [{ arg: 'id', type: 'string', required: true }],
            returns: {
                arg: 'response',
                root: true,
                type: 'object',
            },
            http: { path: '/:id/deleteSchedule', verb: 'DELETE' },
        });
        ScheduledCommunication.remoteMethod('getTargetUsers', {
            accepts: [{ arg: 'rangeFilter', type: 'object', required: true }],
            returns: {
                arg: 'response',
                root: true,
                type: 'object',
            },
            http: { path: '/getTargetUsers', verb: 'GET' },
        });
    };
    ScheduledCommunication.setup();

    ScheduledCommunication.init = async (scheduleInstances = []) => {
        let incompleteSchedules = await ScheduledCommunication.find({
            where: {
                enabled: true,
                status: {
                    nin: [scheduleStatus.COMPLETED, scheduleStatus.STOPPED],
                },
            },
            include: 'tracking',
        });

        incompleteSchedules = [...incompleteSchedules, ...scheduleInstances];
        let startCount = 1;
        for (const scheduleInstance of incompleteSchedules) {
            try {
                this.scheduleInstance = scheduleInstance;
                this.commTrackingInstance = scheduleInstance.tracking();
                const result = await ScheduledCommunication.addSchedule.call(
                    this,
                    scheduleInstance.jobName,
                    scheduleInstance.channel,
                    scheduleInstance.recurrenceRule,
                    scheduleInstance.scheduledAt,
                    scheduleInstance.templateWhere,
                    scheduleInstance.wherePid,
                    scheduleInstance.sendOnce,
                    scheduleInstance.dataFields,
                    scheduleInstance.rangeFilter,
                    true
                );
                result;
                console.info(
                    `[${startCount} of ${_.size(
                        incompleteSchedules
                    )}]  Started schedule with slug ${scheduleInstance.slug} ✅`
                );
                startCount++;
            } catch (error) {
                await scheduleInstance.updateAttributes({
                    status: scheduleStatus.STOPPED,
                    enabled: false,
                });
                console.error(
                    `Error occured while resuming schedule. Reason: ${error.message}`
                );
            }
        }
    };

    ScheduledCommunication.getChannelTask = (channel) => {
        channel = _.capitalize(channel);
        let task =
            ScheduledCommunication.app.models.Communication[`send${channel}`];
        if (!task || typeof task !== 'function') {
            return pe(
                HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
                `Task not found for channel ${channel}`
            );
        }
        return task;
    };

    const createRecurrenceSchedule = (jobName, recurrenceRule, asyncTask) => {
        let options = {
            jobName,
            recurrenceRule,
        };
        let job = schedule.scheduleJob(jobName, options, asyncTask);
        job = _.omit(job, ['callback', '_eventsCount']);
        return job;
    };
    const createDateSchedule = (
        jobName,
        scheduledAt,
        asyncTask,
        existing = false
    ) => {
        if (existing) {
            scheduledAt = _.filter(scheduledAt, (date) =>
                moment(date).isAfter(moment())
            );
            if (_.isEmpty(scheduledAt)) {
                return {
                    status: scheduleStatus.COMPLETED,
                    asyncTask,
                };
            }
        }
        let date = scheduledAt.shift();
        date = new Date(date);
        let options = {
            jobName,
            date,
        };

        let job = schedule.scheduleJob(
            options.jobName,
            options.date,
            asyncTask
        );

        if (!job) {
            return pe(HTTP_STATUS_CODES.BAD_REQUEST, `Invalid dates.`);
        }

        job = _.omit(job, ['callback', '_eventsCount']);

        while ((date = scheduledAt.shift())) {
            date = new Date(date);
            job.schedule(date);
        }
        job = _.omit(job, ['callback', '_eventsCount']);
        return job;
    };

    ScheduledCommunication.getTargetUsers = async (rangeFilter) => {
        const recipients = await ScheduledCommunication.app.models.Communication.getEmailsFromRange(
            rangeFilter
        );
        return { count: _.size(recipients) };
    };

    const setRunningSchedule = function (slug, job, scData = {}) {
        ScheduledCommunication.scheduledJobs[slug] = {
            slug,
            job: {
                ...((ScheduledCommunication.scheduledJobs[slug] &&
                    ScheduledCommunication.scheduledJobs[slug].job) ||
                    {}),
                ...job,
            },
            ...scData,
        };
        return ScheduledCommunication.scheduledJobs[slug];
    };

    ScheduledCommunication.initSettings = async function (settings) {
        Object.keys(settings).forEach((setting) => {
            ScheduledCommunication[setting] = settings[setting];
        });

        ScheduledCommunication.scheduledCommSettings =
            ScheduledCommunication.scheduledCommSettings || {};

        let batchSettings = {
            batchSize: 1000, // 1000 emails per batch
            batchDiff: 2000, //in ms
        };
        ScheduledCommunication.scheduledCommSettings = _.merge(
            {},
            batchSettings,
            ScheduledCommunication.scheduledCommSettings
        );
        // ScheduledCommunication.scheduledCommSettings.rateLimit = 10000; // per minute
        // ScheduledCommunication.scheduledCommSettings.refreshPeriod = 60000; // 1000 emails per batch
    };
    ScheduledCommunication.on('attached', async () => {
        ScheduledCommunication.scheduledJobs = {};
        setTimeout(async () => {
            try {
                await ScheduledCommunication.init();
            } catch (error) {
                console.error(error);
            }
        }, 5000);
    });

    // fixing this accorging to current implementation
    ScheduledCommunication.getAlreadySentEmails = async (
        templateWhere,
        scheduleInstance
    ) => {
        const templateInstance = await ScheduledCommunication.templateModel.findOne(
            {
                where: {
                    ...templateWhere,
                    enabled: true,
                },
                include: {
                    relation: 'schedules',
                    scope: { include: 'tracking' },
                },
            }
        );
        const templateInstanceJSON = templateInstance.toJSON();

        const emailsWhichWillBeSent = [];
        // lets loop through schedules
        for (const schedule of templateInstanceJSON.schedules) {
            if (schedule.id.toString() === scheduleInstance.id.toString()) {
                return _.uniq(emailsWhichWillBeSent);
            }
            if (schedule.status === scheduleStatus.IN_PROGRESS) {
                const toberecieved =
                    (await ScheduledCommunication.app.models.Communication.getEmailsFromRange(
                        schedule.rangeFilter
                    )) || [];
                emailsWhichWillBeSent.push(...toberecieved);
            } else if (schedule.status === scheduleStatus.COMPLETED) {
                const recieved = (schedule.tracking || {}).sent || [];
                emailsWhichWillBeSent.push(...recieved);
            }
        }
    };
    return ScheduledCommunication;
};
