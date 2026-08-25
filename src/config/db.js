const mongoose = require('mongoose');
require("dotenv").config();

// If a query runs before the initial connection finishes (e.g. right after a
// fresh deploy), mongoose queues it rather than failing immediately. Keep
// that wait short and consistent with the other timeouts below, so a
// student never sits on an unexplained hang.
mongoose.set('bufferTimeoutMS', 8000);

const Connection = () => {
     return mongoose.connect(process.env.MONGO_URI, {
        // Fail fast and predictably instead of hanging for mongoose's very
        // long defaults (30s server selection) — a payment request should
        // never sit silently for that long.
        serverSelectionTimeoutMS: 8000,
        socketTimeoutMS: 20000,
        connectTimeoutMS: 8000,
     })
}

module.exports = {Connection}
