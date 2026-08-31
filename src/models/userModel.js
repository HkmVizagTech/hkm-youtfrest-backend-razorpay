const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name:{type:String, required:true},
    email:{type:String, required:true},
    password:{type:String,required:true},
    // "user" is a legacy value kept so any accounts created before this
    // rename keep working. New accounts should use "volunteer".
    role:{type:String, enum:["admin", "user", "volunteer", "collegeadmin", "reception"], default:"volunteer"},
},{
    versionKey:false,
    timestamps:true
})


const userModel =  mongoose.model("user", userSchema);

module.exports = userModel