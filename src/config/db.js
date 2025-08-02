const mongoose = require('mongoose');
require("dotenv").config();
const Connection  =() =>{
    return mongoose.connect(process.env.MONGO_URI)
}

module.exports = {Connection}