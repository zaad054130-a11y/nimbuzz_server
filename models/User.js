const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    email: { type: String, default: "" },       
    phone: { type: String, default: "" },       
    password: { type: String, required: true },  
    language: { type: String, default: "ar" },   
    accountType: { type: String, default: "user" }, 

    nickname: { type: String, required: true },  
    avatar: { type: String, default: "" },        
    age: { type: Number, default: null },        
    country: { type: String, default: "" },      
    city: { type: String, default: "" },         

    balance: { type: Number, default: 0 },       
    receivedGifts: { type: Number, default: 0 }, 

    allowPrivateCalls: { type: Boolean, default: true }, 
    runInBackground: { type: Boolean, default: true },   

    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],          
    friendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],   
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]     
}, { timestamps: true }); 

module.exports = mongoose.model('User', UserSchema);
