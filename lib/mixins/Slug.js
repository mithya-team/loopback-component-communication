const _ = require('lodash');

module.exports = (Model, options) => {
    let fields = options.fields || ['name'];
    if (_.isString(fields)) {
        fields = [fields];
    }
    Model.defineProperty('slug', { type: String });
    Model.validatesUniquenessOf('slug', { message: 'is not unique' });
    Model.observe('access', function (ctx, next) {
        if (ctx.query.where && ctx.query.where.id) {
            ctx.query.where.or = [
                {
                    id: ctx.query.where.id,
                },
                {
                    slug: ctx.query.where.id,
                },
            ];
            ctx.query.where = _.omit(ctx.query.where, ['id']);
        }
        next();
    });

    Model.getBaseSlug = (instance) => {
        return _.snakeCase(
            _.trim(
                _.join(
                    _.map(fields, (field) => instance[field]),
                    ' '
                )
            )
        );
    };
    Model.findUniqueSlug = async (instance) => {
        const baseSlug = Model.getBaseSlug(instance);
        const regex = new RegExp(`^${baseSlug}(_[0-9]*){0,1}$`);
        const similarInstances = await Model.find({
            where: {
                slug: {
                    like: regex,
                },
            },
            fields: ['slug'],
        });
        if (!similarInstances.length) {
            return baseSlug;
        }
        let maxCount = 0;
        _.forEach(similarInstances, (similarInstance) => {
            const match = similarInstance.slug.match(regex);
            let count;
            if (match[1]) {
                count = _.toInteger(match[1].slice(1));
            }
            if (count > maxCount) {
                maxCount = count;
            }
        });
        return baseSlug + '_' + (maxCount + 1);
    };

    Model.observe('before save', async (ctx, next) => {
        const instance = ctx.instance || ctx.data;
        let where = {};
        if (instance.id) {
            where.id = instance.id;
        } else {
            where = ctx.where;
        }
        let createNewSlug = false;
        if (!ctx.isNewInstance) {
            const prevInstance = await Model.findOne({ where });
            createNewSlug = !prevInstance.slug;
        } else {
            createNewSlug = !instance.slug;
        }
        if (createNewSlug) {
            const baseSlug = Model.getBaseSlug(instance);
            if (baseSlug && baseSlug !== '_') {
                instance.slug = await Model.findUniqueSlug(instance);
            }
        }
        // next();
    });

    Model.updateSlug = async () => {
        const instances = await Model.find();
        for (let i = 0; i < instances.length; i++) {
            const instance = instances[i];
            if (!instance.slug) {
                const baseSlug = Model.getBaseSlug(instance);
                if (baseSlug && baseSlug !== '_') {
                    const slug = await Model.findUniqueSlug(instance);
                    await instance.updateAttributes({ slug });
                }
            }
        }
    };
    // Model.updateSlug();
};
