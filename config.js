var PROXY = process.env.SUBS_PROXY;

module.exports = {
    "CENTRAL": "http://api9.strem.io",
    "SECRET": "03ed24e865bf4025423cce0018804609e2aaa2e3",
};

if (PROXY) module.exports.proxy = {
    host: PROXY.split(":")[0],
    port: parseInt(PROXY.split(":")[1])
};
