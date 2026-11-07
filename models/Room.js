const mongoose = require('mongoose');

// تصميم قاعدة بيانات الغرف لتطبيق Nimbuzz
const RoomSchema = new mongoose.Schema({
    name: { type: String, required: true },       // اسم الغرفة
    description: { type: String, default: "" },  // وصف الغرفة
    isPrivate: { type: Boolean, default: false }, // هل الغرفة خاصة برقم سري؟
    password: { type: String, default: "" },      // الرقم السري للغرفة (إذا كانت خاصة)
    
    // رتب الغرفة والتحكم
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // مالك الغرفة
    admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],                // الإدارة
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],               // الأعضاء الحاليين داخل الغرفة

    // أنظمة العقوبات والحظر التي طلبتها
    bannedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // حظر الحساب من الغرفة
    bannedIPs: [{ type: String }]                                         // حظر الـ IP الكامل للكمبيوتر/الموبايل لمنع الدخول بجهاز آخر
}, { timestamps: true });

module.exports = mongoose.model('Room', RoomSchema);
