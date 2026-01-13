'use strict';
const _ = require('lodash');
const { isValidCron } = require('cron-validator');
const communicationUtils = require('./communication');

const returnError = (statusCode = 500, message = 'Internal Server Error') => {};

const pe = (statusCode = 500, message) => {
    if (typeof statusCode === 'string') {
        message = statusCode;
        statusCode = 500;
    }
    const error = new Error();
    error.message = message;
    error.name = undefined;
    error.statusCode = statusCode;
    return Promise.reject(error);
};

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
module.exports = { pe, isValidDates, isValidCron, ...communicationUtils };
