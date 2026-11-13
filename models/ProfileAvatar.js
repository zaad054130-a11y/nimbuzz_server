const mongoose = require('mongoose');

const ProfileAvatarSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true },
  nickname: { type: String, required: true },
  nicknameKey: { type: String, required: true, index: true },
  imageData: { type: String, required: true },
  mimeType: {
    type: String,
    required: true,
    enum: ['image/jpeg', 'image/png', 'image/webp'],
  },
}, { timestamps: true });

module.exports = mongoose.model('ProfileAvatar', ProfileAvatarSchema);
