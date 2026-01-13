module.exports = (Model, options) => {
    Model.defineProperty('created', { type: Date, default: '$now' });
    Model.defineProperty('updated', { type: Date, default: '$now' });

    Model.observe('before save', (ctx, next) => {
        const instance = ctx.instance || ctx.data;

        if (ctx.isNewInstance) {
            instance.created = new Date();
        }
        instance.updated = new Date();
        next();
    });
};
