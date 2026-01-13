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

module.exports = (CommunicationTracking) => {
    CommunicationTracking.initSettings = async function (settings) {
        Object.keys(settings).forEach((setting) => {
            CommunicationTracking[setting] = settings[setting];
        });
    };
    return CommunicationTracking;
};
