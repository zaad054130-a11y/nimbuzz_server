const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const router = express.Router();

// رموز التحقق المؤقتة (تبقى في الذاكرة لأنها مؤقتة بطبيعتها)
const verificationCodes = {};

function _sanitizeUser(user) {
  return {
    id: user._id.toString(),
    email: user.email || '',
    phone: user.phone || '',
    nickname: user.nickname,
    age: user.age ?? 0,
    country: user.country || '',
    avatar: user.avatar || '',
    balance: user.balance ?? 0,
  };
}

// 🌐 1. مسار إنشاء حساب جديد (Register) — محفوظ في MongoDB
router.post('/register', async (req, res) => {
    try {
        const { email, phone, password, nickname, age, country } = req.body;

        if (!password || !nickname) {
            return res.status(400).json({ msg: "الرجاء إدخال اسم المستخدم وكلمة المرور!" });
        }

        const nicknameTaken = await User.findOne({
          nickname: { $regex: `^${nickname}$`, $options: 'i' },
        });
        if (nicknameTaken) {
          return res.status(400).json({ msg: "اسم المستخدم هذا مأخوذ بالفعل!" });
        }
        if (email) {
          const emailTaken = await User.findOne({ email });
          if (emailTaken) {
            return res.status(400).json({ msg: "هذا البريد الإلكتروني مسجل بالفعل!" });
          }
        }
        if (phone) {
          const phoneTaken = await User.findOne({ phone });
          if (phoneTaken) {
            return res.status(400).json({ msg: "رقم الهاتف هذا مسجل بالفعل!" });
          }
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const created = await User.create({
          email: email || "",
          phone: phone || "",
          password: hashedPassword,
          nickname,
          age: age || 0,
          country: country || "",
        });
        return res.status(201).json({
          msg: "تم إنشاء حسابك في Nimbuzz بنجاح!",
          user: _sanitizeUser(created),
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🔐 2. مسار تسجيل الدخول (Login) — من MongoDB مع bcrypt + JWT
router.post('/login', async (req, res) => {
    try {
        const { identity, password } = req.body;

        if (!identity || !password) {
            return res.status(400).json({ msg: "الرجاء ملء جميع الحقول المطلوبة!" });
        }

        const found = await User.findOne({
          $or: [{ nickname: identity }, { email: identity }, { phone: identity }],
        });
        if (!found) return res.status(400).json({ msg: "الحساب غير موجود! تأكد من البيانات." });

        let ok = false;
        try {
          ok = await bcrypt.compare(password, found.password);
        } catch (_) {
          ok = false;
        }
        if (!ok && found.password === password) {
          // ترحيل تلقائي: تشفير كلمة المرور القديمة
          found.password = await bcrypt.hash(password, 10);
          await found.save();
          ok = true;
        }
        if (!ok) return res.status(400).json({ msg: "كلمة المرور غير صحيحة!" });

        const token = jwt.sign(
          { id: found._id.toString(), nickname: found.nickname },
          process.env.JWT_SECRET || 'nimbuzz_dev_secret',
          { expiresIn: '7d' },
        );

        res.json({
          msg: "تم تسجيل الدخول بنجاح! أهلاً بك مجدداً.",
          token,
          user: _sanitizeUser(found),
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 📩 3. مسار إرسال رمز التحقق للبريد أو الهاتف (Send Code)
router.post('/send-code', async (req, res) => {
    const { identity } = req.body;
    if (!identity) return res.status(400).json({ msg: "الرجاء إدخال البريد أو رقم الهاتف!" });

    const user = await User.findOne({
      $or: [{ email: identity }, { phone: identity }, { nickname: identity }],
    });
    if (!user) return res.status(404).json({ msg: "هذا الحساب غير مسجل لدينا!" });

    // توليد رمز تحقق عشوائي ذكي من 4 أرقام
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    verificationCodes[identity] = code; // حفظ الرمز مؤقتاً

    console.log(`[Nimbuzz Security] رمز التحقق المرسل إلى (${identity}) هو: ${code}`);
    res.json({ msg: `تم إرسال رمز التحقق بنجاح! (الرمز للتجربة: ${code})`, identity });
});

// 🔄 4. مسار التحقق من الرمز وتحديث كلمة المرور الجديدة (Verify & Reset)
router.post('/reset-password-with-code', async (req, res) => {
    const { identity, code, newPassword } = req.body;

    if (!identity || !code || !newPassword) {
        return res.status(400).json({ msg: "الرجاء ملء جميع الحقول المطلوبة!" });
    }

    if (verificationCodes[identity] !== code) {
        return res.status(400).json({ msg: "رمز التحقق غير صحيح! أعد المحاولة." });
    }

    const user = await User.findOne({
      $or: [{ email: identity }, { phone: identity }, { nickname: identity }],
    });
    if (!user) return res.status(404).json({ msg: "حدث خطأ غير متوقع، لم يتم العثور على الحساب." });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    delete verificationCodes[identity]; // تنظيف الذاكرة من الرمز المستخدم

    res.json({ msg: "تم تعيين كلمة المرور الجديدة بنجاح! يمكنك الآن الدخول بها." });
});

module.exports = router;
