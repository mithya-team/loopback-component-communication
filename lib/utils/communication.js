'use strict';
const htmlToText = require('html-to-text');
const HTTP_STATUS_CODES = require('http-status-codes');

const validateData = (data) => {
    if (!data.to || !data.html || !data.from || !data.subject) {
        return Promise.reject({
            statusCode: HTTP_STATUS_CODES.BAD_REQUEST,
            message: '[to,from,html,subject] is required.',
        });
    }
    if (!data.body) {
        data.body = htmlToText.fromString(data.html);
    }
    return data;
};

module.exports = { validateData };
