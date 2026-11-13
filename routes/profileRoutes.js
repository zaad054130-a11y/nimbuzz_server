const express = require('express');
const mongoose = require('mongoose');
const ProfileAvatar = require('../models/ProfileAvatar');

const MAX_IMAGE_BYTES = 512 * 1024;
const FIREBASE_PROJECT_ID = 'talkinchat-pro-server';

function normalizeNickname(nickname) {
  return String(nickname || '').trim().toLowerCase();
}

function imageMimeType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

async function findGeneratedNicknameByEmail(email, apiKey) {
  const uri = new URL(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
  );
  uri.searchParams.set('key', apiKey);
  const response = await fetch(uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'generated_accounts' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'email' },
            op: 'EQUAL',
            value: { stringValue: email },
          },
        },
        limit: 1,
      },
    }),
  });
  if (!response.ok) return null;

  const rows = await response.json();
  for (const row of rows) {
    const nickname = row?.document?.fields?.nickname?.stringValue;
    if (typeof nickname === 'string' && nickname.trim()) return nickname.trim();
  }
  return null;
}

function createProfileRoutes({ firebaseApiKey, io }) {
  const router = express.Router();

  router.put('/avatar', async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ msg: 'قاعدة بيانات الصور غير متاحة حاليًا.' });
      }

      const authorization = req.get('authorization') || '';
      const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
      if (!tokenMatch) {
        return res.status(401).json({ msg: 'انتهت جلسة الحساب. سجّل الدخول مجددًا.' });
      }

      const lookupUrl = new URL(
        'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
      );
      lookupUrl.searchParams.set('key', firebaseApiKey);
      const lookupResponse = await fetch(lookupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: tokenMatch[1] }),
      });
      if (!lookupResponse.ok) {
        return res.status(401).json({ msg: 'تعذر التحقق من الحساب لمزامنة الصورة.' });
      }

      const lookupData = await lookupResponse.json();
      const firebaseUser = lookupData.users?.[0];
      if (!firebaseUser?.localId) {
        return res.status(401).json({ msg: 'جلسة الحساب غير صالحة.' });
      }

      const canonicalNickname =
        String(firebaseUser.displayName || '').trim() ||
        (await findGeneratedNicknameByEmail(firebaseUser.email, firebaseApiKey));
      const requestedNickname = String(req.body?.nickname || '').trim();
      if (
        !canonicalNickname ||
        normalizeNickname(canonicalNickname) !== normalizeNickname(requestedNickname)
      ) {
        return res.status(403).json({ msg: 'اسم الحساب لا يطابق جلسة المستخدم.' });
      }

      const encodedImage = req.body?.imageData;
      if (
        typeof encodedImage !== 'string' ||
        encodedImage.length === 0 ||
        encodedImage.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedImage)
      ) {
        return res.status(400).json({ msg: 'بيانات الصورة غير صالحة أو حجمها كبير.' });
      }

      const imageBytes = Buffer.from(encodedImage, 'base64');
      if (
        imageBytes.length === 0 ||
        imageBytes.length > MAX_IMAGE_BYTES ||
        imageBytes.toString('base64') !== encodedImage
      ) {
        return res.status(400).json({ msg: 'حجم الصورة يتجاوز الحد المسموح.' });
      }
      const mimeType = imageMimeType(imageBytes);
      if (!mimeType) {
        return res.status(400).json({ msg: 'نوع الصورة غير مدعوم.' });
      }

      const avatar = await ProfileAvatar.findOneAndUpdate(
        { firebaseUid: firebaseUser.localId },
        {
          firebaseUid: firebaseUser.localId,
          nickname: canonicalNickname,
          nicknameKey: normalizeNickname(canonicalNickname),
          imageData: encodedImage,
          mimeType,
        },
        { new: true, upsert: true, runValidators: true },
      );
      io.emit('profile_avatar_updated', { nickname: avatar.nickname });
      return res.json({ updatedAt: avatar.updatedAt.toISOString() });
    } catch (error) {
      console.error('[PROFILE AVATAR] Unable to save image:', error.message);
      return res.status(500).json({ msg: 'تعذر حفظ صورة الملف الشخصي على الخادم.' });
    }
  });

  router.get('/:nickname/avatar', async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ msg: 'قاعدة بيانات الصور غير متاحة حاليًا.' });
      }
      const nicknameKey = normalizeNickname(req.params.nickname);
      if (!nicknameKey) {
        return res.status(400).json({ msg: 'اسم المستخدم مطلوب.' });
      }
      const avatar = await ProfileAvatar.findOne({ nicknameKey })
        .sort({ updatedAt: -1 })
        .lean();
      if (!avatar) return res.status(404).json({ msg: 'لا توجد صورة لهذا الحساب.' });

      res.set('Cache-Control', 'no-store');
      return res.json({
        imageData: avatar.imageData,
        mimeType: avatar.mimeType,
        updatedAt: avatar.updatedAt.toISOString(),
      });
    } catch (error) {
      console.error('[PROFILE AVATAR] Unable to load image:', error.message);
      return res.status(500).json({ msg: 'تعذر تحميل صورة الملف الشخصي.' });
    }
  });

  return router;
}

module.exports = createProfileRoutes;
