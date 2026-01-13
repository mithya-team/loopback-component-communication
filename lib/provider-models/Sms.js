const Twilio = require('twilio');
module.exports = function (Sms) {
    let twilio;
    Sms.init = function (sid, token) {
        twilio = new Twilio(sid, token);
    };

    Sms.send = async function ({ from, to, body }) {
        let result;

        result = await twilio.messages.create({
            from,
            to,
            body,
        });
        return result;
    };

    return Sms;
};
