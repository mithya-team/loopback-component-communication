const _ = require('lodash');
const schedule = require('node-schedule');

const isValidDates = function (dateArr) {
    if (!Array.isArray(dateArr)) return false;
    let success = true;
    _.map(dateArr, (i) => {
        i = new Date(i);
        if (i.getTime() !== i.getTime()) {
            success = false;
        }
    });
    return success;
};
module.exports = (ScheduledCommunication) => {
    schedule.cancelJob;
    ScheduledCommunication.addSchedule = async function (
        name,
        type,
        { id, recurrenceRule, scheduledAt, data },
        task,
        optionsFromRequest
    ) {
        let runningSchedule = await getRunningSchedules(name);

        if (runningSchedule) {
            return runningSchedule;
        }
        if (!task) {
            return Promise.reject(new Error(`task is required.`));
        }
        let rule = new schedule.RecurrenceRule();
        let jobSlug, job, options;
        let scheduledAtCopy = scheduledAt && [...scheduledAt];
        if (recurrenceRule) {
            options = {
                name,
                recurrenceRule,
            };

            job = schedule.scheduleJob(
                options.name,
                options,
                async function (fireDate) {
                    task({ ...data, extras: { jobSlug } });
                }.bind(this, jobSlug)
            );

            job = _.omit(job, ['callback', '_eventsCount']);
        } else if (scheduledAt) {
            if (!Array.isArray(scheduledAt)) {
                scheduledAt = [scheduledAt];
            }
            if (isValidDates(scheduledAt) || !_.isEmpty(scheduledAt)) {
                let date = scheduledAt.shift();
                date = new Date(date);
                options = {
                    name,
                    date,
                };

                job = schedule.scheduleJob(
                    options.name,
                    options.date,
                    async function (fireDate) {
                        task({ ...data, extras: { jobSlug } });
                        console.log(job);
                    }.bind(this, jobSlug)
                );
                if (!job) {
                    return Promise.reject(new Error(`Invalid dates.`));
                }
                job = _.omit(job, ['callback', '_eventsCount']);
                while ((date = scheduledAt.shift())) {
                    date = new Date(date);
                    job.schedule(date);
                }
            } else {
                return Promise.reject(new Error(`Invalid scheduled dates.`));
            }
        }
        let prevSchedule = await findScheduleByName(name);
        if (!_.isEmpty(prevSchedule)) {
            await prevSchedule.updateAttributes({
                ...job,
                type,
                recurrenceRule,
                scheduledAt: scheduledAtCopy,
                data,
            });
            jobSlug = prevSchedule.id;
            return setRunningSchedule(prevSchedule.slug, {
                type,
                job,
                options,
            });

            // return job
        } else {
            let newSchedule = await ScheduledCommunication.create(
                {
                    ...job,
                    type,
                    recurrenceRule,
                    scheduledAt: scheduledAtCopy,
                    data,
                },
                optionsFromRequest
            );
            jobSlug = newSchedule.id;
            return setRunningSchedule(newSchedule.slug, { type, job, options });
            // return job
        }
    };

    ScheduledCommunication.stopSchedule = async function (id) {
        let stoppedSchedule = await ScheduledCommunication.upsertWithWhere(
            { id },
            { enabled: false }
        );
        let jobSlug = stoppedSchedule.slug;
        let schedule = await getRunningSchedules(null, jobSlug);
        if (schedule && schedule.job) {
            schedule.job.cancel();
            return schedule;
        }
    };

    ScheduledCommunication.startSchedule = async function (id) {
        let startedSchedule = await ScheduledCommunication.upsertWithWhere(
            { id },
            { enabled: true }
        );
        let jobSlug = startedSchedule.slug;
        let schedule = await getRunningSchedules(null, jobSlug);
        if (schedule && schedule.job) {
            schedule.job.reschedule(schedule.options);
            return schedule;
        } else {
            let [job] = await ScheduledCommunication.init([startedSchedule]);
            return getRunningSchedules(null, jobSlug);
        }
    };

    const findScheduleByName = async function (name) {
        return (
            (await ScheduledCommunication.findOne({ where: { name } })) || {}
        );
    };

    const getRunningSchedules = async function (name, slug) {
        slug = slug || (await findScheduleByName(name)).slug;
        if (name || slug) {
            return ScheduledCommunication.scheduledJobs[slug];
        }
        return ScheduledCommunication.scheduledJobs;
    };

    const setRunningSchedule = function (slug, scData) {
        ScheduledCommunication.scheduledJobs[slug] = {
            ...scData,
            slug,
        };
        return ScheduledCommunication.scheduledJobs[slug];
    };

    ScheduledCommunication.init = async function (incompleteSchedules) {
        incompleteSchedules =
            incompleteSchedules ||
            (await ScheduledCommunication.find({
                where: {
                    enabled: true,
                },
            }));
        let jobs = [];
        for (let schedule of incompleteSchedules) {
            let type = schedule.type;
            if (!type) {
                continue;
            }
            let cb;
            if (type === 'email') {
                cb = getEmailCb();
            } else if (type === 'sms') {
                cb = getSmsCb();
            }
            let j = await ScheduledCommunication.addSchedule(
                schedule.name,
                type,
                { ...schedule.toJSON() },
                cb
            );
            jobs.push(j);
            console.log(
                `Running schedule [${jobs.length}/${incompleteSchedules.length}] ${j.slug}`
            );
        }

        return jobs;
    };

    ScheduledCommunication.on('attached', async () => {
        ScheduledCommunication.scheduledJobs = {};
        await ScheduledCommunication.init();
    });

    ScheduledCommunication.observe('before save', async (ctx) => {
        const instance = ctx.instance || ctx.data;
        if (ctx.isNewInstance) {
            instance.enabled = true;
            if (ctx.options.accessToken) {
                let userId = ctx.options.accessToken.userId;
                instance.createdBy = userId;
            }
        }
    });

    const getEmailCb = function (data) {
        return ScheduledCommunication.app.models.Communication.sendEmail;
    };

    const getSmsCb = function (data) {
        return ScheduledCommunication.app.models.Communication.sendSms;
    };

    ScheduledCommunication.observe('access', function (ctx, next) {
        if (ctx.options.authorizedRoles && !ctx.options.authorizedRoles.ADMIN) {
            ctx.query.where = ctx.query.where || {};
            ctx.query.where.deleted = false;
        }
        next();
    });

    return ScheduledCommunication;
};
