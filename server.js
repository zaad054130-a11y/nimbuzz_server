require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// محاولة اتصال MongoDB (اختياري — السيرفر يعمل بدونه)
try {
  const mongoose = require('mongoose');
  const dbURI = process.env.MONGODB_URI;
  if (dbURI) {
    mongoose.connect(dbURI)
      .then(() => console.log("[DATABASE] CONNECTED SUCCESSFULLY!"))
      .catch((err) => console.log("[DATABASE] OFFLINE MODE — persistent data is unavailable:", err.message));
  } else {
    console.warn("[DATABASE] MONGODB_URI is not configured; persistent data is unavailable.");
  }
} catch (e) {
  console.log("[DATABASE] mongoose not available, running in memory mode");
}
// --- نماذج قاعدة البيانات الدائمة (الرتب، المحادثات الخاصة، طلبات الصداقة) ---
const mongoose = require('mongoose');
const RoomRoleSchema = new mongoose.Schema({
  roomId: { type: String, unique: true, required: true },
  owner: { type: String, required: true }, // المالك الأصلي المحمي
  coOwners: { type: [String], default: [] }, // أونر ممنوح
  admins: { type: [String], default: [] }, // مشرفين
  banned: { type: [String], default: [] }, // المحظورين من الدخول
});

const PrivateMsgSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  text: { type: String, required: true },
  at: { type: Date, default: Date.now },
});
const FriendReqSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  status: { type: String, default: 'pending' },
  at: { type: Date, default: Date.now },
});

const RoomRole = mongoose.models.RoomRole || mongoose.model('RoomRole', RoomRoleSchema);
const PrivateMsg = mongoose.models.PrivateMsg || mongoose.model('PrivateMsg', PrivateMsgSchema);
const FriendReq = mongoose.models.FriendReq || mongoose.model('FriendReq', FriendReqSchema);

// Base Route
app.get('/', (req, res) => {
  res.send('Nimbuzz Server is Running Successfully');
});

// ربط روترات المصادقة والغرف (مع حماية من غياب DB)
try { app.use('/api/auth', require('./routes/auth')); }
catch (e) { console.log('[ROUTES] auth disabled:', e.message); }
try { app.use('/api/rooms', require('./routes/roomRoutes')); }
catch (e) { console.log('[ROUTES] rooms disabled:', e.message); }
app.use('/api/chat', require('./routes/chat'));

// 🔐 دخول البوت — فحص حقيقي 100% من Firebase (نفس مصدر حسابات النمبز الحقيقي)
// حسابات النمبز تُنشأ في Firebase Auth + Firestore (collection: generated_accounts)
// لذا نتحقق من الحساب بنفس الطريقة تماماً بدلاً من MongoDB.
const FIREBASE_WEB_API_KEY = 'AIzaSyDk6ZvANIJfZVG9me426rxSsIALhcenP5A';
const FIREBASE_PROJECT_ID = 'talkinchat-pro-server';

// 🔎 تحويل اسم المستخدم (nickname) إلى بريد عبر Firestore generated_accounts
async function findNimbuzzEmailByNickname(nickname) {
    const norm = String(nickname || '').trim();
    if (!norm) return null;
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery?key=${FIREBASE_WEB_API_KEY}`;
    const body = {
        structuredQuery: {
            from: [{ collectionId: 'generated_accounts' }],
            where: {
                fieldFilter: {
                    field: { fieldPath: 'nickname' },
                    op: 'EQUAL',
                    value: { stringValue: norm },
                },
            },
            limit: 1,
        },
    };
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (r.status < 200 || r.status >= 300) return null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
        const fields = row && row.document && row.document.fields;
        if (fields && fields.email && fields.email.stringValue) {
            return fields.email.stringValue;
        }
    }
    return null;
}

app.post('/api/bot/login', async (req, res) => {
    try {
        const { identity, password } = req.body || {};
        if (!identity || !password) {
            return res.status(400).json({ msg: 'اكتب اسم المستخدم وكلمة المرور' });
        }

        const identityStr = String(identity).trim();

        // 1) تحديد البريد: إما أنه بريد مباشرة، أو اسم مستخدم نبحث عنه في Firestore
        let email = null;
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identityStr)) {
            email = identityStr;
        } else {
            email = await findNimbuzzEmailByNickname(identityStr);
        }

        // في حال كان nickname مخزّناً في Mongo (خيار احتياطي لو توفّر) — نحاول أيضاً
        if (!email) {
            try {
                const mongoose = require('mongoose');
                if (mongoose.connection && mongoose.connection.readyState === 1) {
                    const User = mongoose.models.User || require('./models/User');
                    const found = await User.findOne({ nickname: identityStr });
                    if (found && found.email) email = found.email;
                }
            } catch (_) { /* تجاهل */ }
        }

        if (!email) {
            return res.status(400).json({ msg: '❌ هذا الحساب غير موجود في شبكة النمبز!' });
        }

        // 2) التحقق من كلمة المرور عبر Firebase Auth (المصدر الحقيقي للحسابات)
        const signInUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`;
        const sr = await fetch(signInUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
        });
        const sdata = await sr.json();

        if (sr.status < 200 || sr.status >= 300) {
            const code = sdata && sdata.error && sdata.error.message ? sdata.error.message : '';
            if (code.includes('PASSWORD') || code.includes('INVALID_LOGIN') || code.includes('EMAIL_NOT_FOUND')) {
                return res.status(400).json({ msg: '❌ كلمة المرور غير صحيحة!' });
            }
            return res.status(400).json({ msg: '❌ تعذر التحقق من الحساب عبر Firebase: ' + code });
        }

        // 🔒 نجح التحقق من Firebase — الحساب حقيقي
        const displayName = (sdata.displayName && String(sdata.displayName).trim()) || identityStr;
        return res.json({
            msg: 'تم دخول البوت بنجاح من حساب النمبز الحقيقي (Firebase)',
            token: sdata.idToken || ('demo-' + Date.now()),
            user: {
                id: sdata.localId || ('bot-' + identityStr.replace(/[^a-z0-9_-]/gi, '')),
                nickname: displayName,
                email: sdata.email || email,
            },
        });

    } catch (err) {
        return res.status(400).json({ msg: '❌ تعذر التحقق: ' + err.message });
    }
});


// --- حفظ دائم للغرف والرسائل في ملفات JSON (تبقى بعد إغلاق السيرفر) ---
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, 'data');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
function loadJson(name, fallback) {
  try {
    const f = path.join(DATA_DIR, name);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {}
  return fallback;
}
function saveJson(name, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data), 'utf8'); } catch (_) {}
}

// --- Socket.io للغرف الحية ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(
  '/api/profiles',
  require('./routes/profileRoutes')({ firebaseApiKey: FIREBASE_WEB_API_KEY, io }),
);
app.set('io', io);
// جلب سجل المحادثات الخاصة بين شخصين
app.get('/api/private-messages', async (req, res) => {
  try {
    const { u1, u2 } = req.query;
    if (!u1 || !u2 || mongoose.connection.readyState !== 1) return res.json([]);
    const msgs = await PrivateMsg.find({
      $or: [
        { from: u1, to: u2 },
        { from: u2, to: u1 },
      ],
    }).sort({ at: 1 }).limit(200).lean();
    return res.json(msgs);
  } catch (e) {
    return res.json([]);
  }
});

// جلب قائمة الأصدقاء وطلبات الصداقة المعلقة للمستخدم
app.get('/api/friends/:nickname', async (req, res) => {
  try {
    const user = String(req.params.nickname || '').trim();
    if (!user || mongoose.connection.readyState !== 1) return res.json({ friends: [], pending: [] });
    const accepted = await FriendReq.find({
      status: 'accepted',
      $or: [{ from: user }, { to: user }],
    }).lean();
    const friends = accepted.map(r => (r.from === user ? r.to : r.from));
    const pending = await FriendReq.find({ to: user, status: 'pending' }).lean();
    return res.json({ friends, pending });
  } catch (e) {
    return res.json({ friends, pending });
  }
});

// سجل المحادثات والغرف دائم، أما الحضور فيبدأ فارغاً بعد كل تشغيل.
try {
  const chat = require('./routes/chat');
  const savedHist = loadJson('chat_history.json', {});
  for (const [k, v] of Object.entries(savedHist)) {
    if (Array.isArray(v)) chat.__roomHist(k).push(...v.slice(-300));
  }
  console.log('[DATA] chat history loaded:', Object.keys(savedHist).length, 'rooms');
} catch (e) { console.log('[DATA] chat load skipped:', e.message); }
try {
  const rr = require('./routes/roomRoutes');
  const savedRooms = loadJson('rooms.json', []);
  if (Array.isArray(savedRooms)) {
    for (const r of savedRooms) rr.__addRoom(r);
    console.log('[DATA] rooms loaded:', savedRooms.length);
  }
  // حفظ تلقائي كل 15 ثانية
  setInterval(() => {
    try {
      const chat = require('./routes/chat');
      saveJson('chat_history.json', chat.__history || {});
      saveJson('members.json', chat.__members || {});
      saveJson('rooms.json', rr.__allRooms());
    } catch (_) {}
  }, 15000);
  // حفظ عند الإغلاق
  const doSave = () => {
    try {
      const chat = require('./routes/chat');
      saveJson('chat_history.json', chat.__history || {});
      saveJson('members.json', chat.__members || {});
      saveJson('rooms.json', rr.__allRooms());
    } catch (_) {}
  };
  process.on('SIGINT', () => { doSave(); process.exit(0); });
  process.on('SIGTERM', () => { doSave(); process.exit(0); });
} catch (e) { console.log('[DATA] rooms load skipped:', e.message); }

io.on('connection', (socket) => {
  // Helper: normalize join payload (accepts {roomId, room, nickname} object OR (roomId, nickname))
  // استخرج أفضل اسم متاح من أي شكل للحقول الواردة
  function pickName(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const keys = ['nickname', 'username', 'userName', 'user_name', 'name', 'sender', 'displayName', 'user', 'from'];
    for (const k of keys) {
      const v = obj[k];
      if (v != null) {
        const s = String(v).trim();
        if (s && s !== 'null' && s !== 'undefined') return s;
      }
    }
    // الحالة المتداخلة: { user: { name: ... } } أو { data: { nickname: ... } }
    const nested = obj.user || obj.data || obj.member || obj.from;
    if (nested && typeof nested === 'object') {
      for (const k of ['nickname', 'username', 'userName', 'name', 'sender']) {
        const v = nested[k];
        if (v != null) {
          const s = String(v).trim();
          if (s && s !== 'null' && s !== 'undefined') return s;
        }
      }
    }
    return '';
  }

  function parseJoin(a, b) {
    let roomId = '', nickname = '';
    if (a && typeof a === 'object') {
      roomId = String(a.roomId || a.room || a.roomName || a.name || '').trim();
      nickname = pickName(a);
    } else {
      roomId = String(a || '').trim();
      nickname = String(b || '').trim();
    }
    return { roomId: roomId || 'lobby', nickname: nickname || 'زائر' };
  }

  function doJoin(rawRoom, nickname) {
    const roomId = String(rawRoom || 'lobby');
    socket.join(roomId);
    socket.data = socket.data || {};
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;
    socket.data.roomIds = socket.data.roomIds || new Set();
    socket.data.roomIds.add(roomId);
    // Register member in the shared store so /members reflects live presence
    try {
      const chat = require('./routes/chat');
      const mem = chat.__roomMembers(roomId);
      if (nickname && !mem.find(m => m.nickname === nickname)) {
        mem.push({ nickname, joinedAt: new Date().toISOString(), socketId: socket.id });
      }
    } catch (_) {}
    SystemEvents.join(socket, roomId, nickname);
  }

  // ✅ دوال الأحداث النظامية الموحدة (انضمام/مغادرة/قائمة أعضاء)
  const SystemEvents = {
    join(sock, roomId, nickname) {
      const all = [];
      try {
        const chat = require('./routes/chat');
        const list = chat.__liveRoomMembers(roomId, io);
        for (const m of list) {
          const n = String((m && m.nickname) || '').trim();
          if (n) all.push(n);
        }
      } catch (_) {}
      if (nickname && !all.includes(nickname)) all.push(nickname);
      io.to(roomId).emit('user_joined', { roomId, nickname });
      io.to(roomId).emit('member_joined', { roomId, nickname });
      io.to(roomId).emit('room_members', { roomId, members: all });
      io.to(roomId).emit('members_list', { roomId, members: all });
    },
    leave(roomId, nickname) {
      const all = [];
      try {
        const chat = require('./routes/chat');
        const list = chat.__liveRoomMembers(roomId, io);
        for (const m of list) {
          const n = String((m && m.nickname) || '').trim();
          if (n) all.push(n);
        }
      } catch (_) {}
      io.to(roomId).emit('user_left', { roomId, nickname });
      io.to(roomId).emit('member_left', { roomId, nickname });
      io.to(roomId).emit('room_members', { roomId, members: all });
      io.to(roomId).emit('members_list', { roomId, members: all });
    },
  };

  async function doMessage(data) {
    data = data || {};
    const roomId = String(data.roomId || data.room || data.roomName || 'lobby');
    const chat = require('./routes/chat');
    const msg = {
      roomId,
      sender: data.sender || data.nickname || data.user || 'anon',
      nickname: data.nickname || data.user || data.sender || 'زائر',
      text: data.text || data.msg || '',
      at: new Date().toISOString(),
    };
    if (!msg.text) return;
    
    // ✅ أي مرسل رسالة في الغرفة يُسجَّل كعضو حاضر
    try {
      if (msg.nickname && msg.nickname !== 'زائر') {
        const mem = chat.__roomMembers(roomId);
        if (!mem.find(m => m.nickname === msg.nickname)) {
          mem.push({ nickname: msg.nickname, joinedAt: new Date().toISOString(), socketId: socket.id });
          SystemEvents.join(socket, roomId, msg.nickname);
        }
      }
    } catch (_) {}
    
    const h = chat.__roomHist(roomId);
    h.push(msg);
    if (h.length > 300) h.splice(0, h.length - 300);
    
    // Broadcast to EVERYONE in the room (including sender so all clients stay in sync)
    io.to(roomId).emit('room_message', msg);
    io.to(roomId).emit('message', msg);
    
    // 🤖 [تحديث مسار البوت والربط المباشر] القراءة من المجلد الرئيسي الخارجي مباشرة
    try {
      await require('./data/botManager').checkBotCommands(io, msg);
    } catch (error) {
      console.error('[BOT COMMAND ERROR]:', error);
    }
}

  // Join (support both object and positional signatures)
  socket.on('join_room', (a, b) => {
    const { roomId, nickname } = parseJoin(a, b);
    doJoin(roomId, nickname);
  });
  socket.on('join', (a, b) => {
    const { roomId, nickname } = parseJoin(a, b);
    require('./data/botManager').botGreetOrFarewell(io, 'join', roomId, nickname);
    doJoin(roomId, nickname);
  });

  // ✅ تطبيق النيمبوز يطلب قائمة الأعضاء بـ get_members — نرد فوراً بـ room_members
  socket.on('get_members', (a, b) => {
    const { roomId } = parseJoin(a, b);
    let all = [];
    try {
      const chat = require('./routes/chat');
      all = chat.__liveRoomMembers(roomId, io).map(m => String((m && m.nickname) || '').trim()).filter(Boolean);
    } catch (_) {}
    socket.emit('room_members', { roomId, members: all });
    socket.emit('members_list', { roomId, members: all });
  });

  socket.on('add_bot_to_room', (data) => {
    try {
      const { roomId, botName } = data || {};
      if (!roomId || !botName) {
        socket.emit('bot_error', { message: 'اسم الغرفة واسم البوت مطلوبان' });
        return;
      }

      const added = require('./data/botManager').addBotToRoom(io, roomId, botName);
      if (!added) {
        socket.emit('bot_error', { message: 'هذا البوت موجود بالفعل في الغرفة!' });
        return;
      }
      console.log(`[BOT SYSTEM] Bot "${botName}" successfully added to room: ${roomId}`);
    } catch (error) {
      console.error('[BOT SYSTEM] Error adding bot:', error);
      socket.emit('bot_error', { message: 'تعذر إضافة البوت إلى الغرفة' });
    }
  });

    socket.on('bot_command', async (data) => {
    const text = String((data && data.text) || '').trim();
    if (!text) {
      socket.emit('bot_reply', { text: 'اكتب الأمر الذي تريد تنفيذه.' });
      return;
    }

    // 🤖 1. أمر استدعاء البوت ودخوله للغرفة من الخاص
    if (text.startsWith('ادخل غرفة ')) {
      try {
        const targetRoom = text.replace('ادخل غرفة ', '').trim();
        const botName = "مساعد السيرفر التلقائي";

        if (!targetRoom) {
          socket.emit('bot_reply', { text: '⚠️ يرجى تحديد اسم الغرفة بدقة بعد الأمر.' });
          return;
        }

        // استخدام مسار الحروف الصغيرة المتوافق مع مشروعك تماماً
        const chat = require('./routes/chat');
        const mem = chat.__roomMembers(targetRoom) || [];

        const botExists = mem.some(m => m.nickname === botName);
        if (!botExists) {
          const newBot = {
            socketId: null,
            nickname: botName,
            isBot: true,
            joinedAt: new Date().toISOString()
          };
          mem.push(newBot);

          // بث التحديث للغرفة المستهدفة
          io.to(targetRoom).emit('user_joined_room', {
            roomId: targetRoom,
            user: newBot,
            members: mem
          });

          // إرسال رسالة نصية داخل الغرفة لتأكيد الحضور
          const botMessage = {
            roomId: targetRoom,
            sender: 'bot',
            nickname: botName,
            text: `🤖 [✔] تم حضور البوت بنجاح إلى الغرفة [${targetRoom}] لخدمتكم والتفاعل معكم!`,
            isBot: true,
            at: new Date().toISOString()
          };
          io.to(targetRoom).emit('room_message', botMessage);
          io.to(targetRoom).emit('message', botMessage);
        }

        socket.emit('bot_reply', { text: `ابشر تم ارسال البوت بنجاح وتفعيله داخل غرفة [${targetRoom}] 🤖` });
        console.log(`[BOT SPAWNED VIA PRIVATE] "${botName}" entered room: ${targetRoom}`);
        return;
      } catch (error) {
        console.error('[BOT SPAWN ERROR]:', error);
        socket.emit('bot_reply', { text: 'تعذر إدخال البوت للغرفة حالياً بسبب خطأ داخلي.' });
        return;
      }
    }

    // 🤖 2. أمر طرد البوت وخروجه من الغرفة عبر الخاص
    if (text.startsWith('اخرج من غرفة ')) {
      try {
        const targetRoom = text.replace('اخرج من غرفة ', '').trim();
        const botName = "مساعد السيرفر التلقائي";

        if (!targetRoom) {
          socket.emit('bot_reply', { text: '⚠️ يرجى تحديد اسم الغرفة بدقة بعد الأمر.' });
          return;
        }

        const chat = require('./routes/chat');
        const mem = chat.__roomMembers(targetRoom) || [];

        const botIndex = mem.findIndex(m => m.nickname === botName);
        if (botIndex !== -1) {
          mem.splice(botIndex, 1);

          // بث رسالة توديع داخل الشات
          const leaveMessage = {
            roomId: targetRoom,
            sender: 'bot',
            nickname: botName,
            text: `👋 في أمان الله! تم سحب المساعد برمجياً بطلب من المطور. نشوفكم على خير!`,
            isBot: true,
            at: new Date().toISOString()
          };
          io.to(targetRoom).emit('room_message', leaveMessage);
          io.to(targetRoom).emit('message', leaveMessage);

          // بث حدث المغادرة لتحديث القائمة
          io.to(targetRoom).emit('user_left_room', {
            roomId: targetRoom,
            nickname: botName,
            members: mem
          });

          socket.emit('bot_reply', { text: `✔ تم سحب البوت وإخراجه بنجاح من غرفة [${targetRoom}].` });
        } else {
          socket.emit('bot_reply', { text: `⚠️ البوت غير متواجد أصلاً داخل غرفة [${targetRoom}].` });
        }
        return;
      } catch (error) {
        console.error('[BOT LEAVE ERROR]:', error);
        socket.emit('bot_reply', { text: 'تعذر إخراج البوت حالياً بسبب خطأ داخلي.' });
        return;
      }
    }

    // كود التمرير التلقائي الأصلي المستقر (تم تعديل مساره إلى data ليتوافق مع السحاب)
    try {
      await require('./data/botManager').checkBotCommands(
        io,
        { roomId: socket.id, nickname: 'مستخدم Nimbuzz', text },
        socket.id,
      );
    } catch (error) {
      console.error('[BOT COMMAND ERROR]:', error);
      socket.emit('bot_reply', { text: 'تعذر تنفيذ الأمر حالياً.' });
    }
  });

  // تسجيل هوية المستخدم على السوكيت ليصله الخاص وطلبات الصداقة أينما كان
  socket.on('register_user', async (data) => {
    const nickname = String((data && data.nickname) || data || '').trim();
    if (!nickname) return;
    socket.data = socket.data || {};
    socket.data.nickname = nickname;
    socket.join('user:' + nickname);

    try {
      if (mongoose.connection.readyState === 1) {
        const pending = await FriendReq.find({ to: nickname, status: 'pending' }).lean();
        for (const reqItem of pending) {
          socket.emit('friend_request_received', {
            id: reqItem._id,
            from: reqItem.from,
            message: `لديك طلب صداقة جديد من ${reqItem.from}`,
          });
        }
      }
    } catch (_) {}
  });
  // جلب رتب الغرفة والمحظورين
  socket.on('get_room_roles', async (data) => {
    const roomId = String((data && data.roomId) || '').trim();
    const requester = String((data && data.nickname) || '').trim();
    if (!roomId) return;
    try {
      let roleDoc = await RoomRole.findOne({ roomId });
      if (!roleDoc && requester) {
        roleDoc = await RoomRole.create({ roomId, owner: requester, coOwners: [], admins: [], banned: [] });
      }
      if (roleDoc && roleDoc.banned.includes(requester) && roleDoc.owner !== requester) {
        socket.emit('kicked_from_room', {
          roomId,
          msg: `🚫 أنت محظور من دخول غرفة ${roomId}!`,
        });
        return;
      }
      io.to(roomId).emit('room_roles_updated', {
        roomId,
        owner: roleDoc ? roleDoc.owner : '',
        coOwners: roleDoc ? roleDoc.coOwners : [],
        admins: roleDoc ? roleDoc.admins : [],
        banned: roleDoc ? roleDoc.banned : [],
      });
    } catch (_) {}
  });

  // منح أو سحب الرتب (أونر / مشرف / عضو)
  socket.on('set_room_role', async (data) => {
    const { roomId, byUser, targetUser, role } = data || {};
    if (!roomId || !byUser || !targetUser) return;
    try {
      const roleDoc = await RoomRole.findOne({ roomId });
      if (!roleDoc) return;

      // حماية مطلقة للمالك الأصلي من السحب أو التعديل
      if (targetUser === roleDoc.owner) {
        socket.emit('admin_error', { msg: '🛡️ لا يمكن تعديل أو سحب رتبة مالك الغرفة الأصلي!' });
        return;
      }

      const isCreator = roleDoc.owner === byUser;
      const isCoOwner = roleDoc.coOwners.includes(byUser);

      // منح أو سحب الأونر للمالك الأصلي فقط
      if (role === 'owner' && !isCreator) {
        socket.emit('admin_error', { msg: 'فقط مالك الغرفة الأصلي يمكنه منح رتبة أونر!' });
        return;
      }
      if (!isCreator && !isCoOwner) {
        socket.emit('admin_error', { msg: 'ليس لديك صلاحية تعديل الرتب!' });
        return;
      }

      roleDoc.coOwners = roleDoc.coOwners.filter(u => u !== targetUser);
      roleDoc.admins = roleDoc.admins.filter(u => u !== targetUser);

      let label = 'عضو عادي';
      if (role === 'owner') {
        roleDoc.coOwners.push(targetUser);
        label = 'أونر (Owner) 👑';
      } else if (role === 'admin') {
        roleDoc.admins.push(targetUser);
        label = 'مشرف (Admin) 🛡️';
      }

      await roleDoc.save();
      io.to(roomId).emit('room_roles_updated', {
        roomId,
        owner: roleDoc.owner,
        coOwners: roleDoc.coOwners,
        admins: roleDoc.admins,
        banned: roleDoc.banned,
      });
      io.to(roomId).emit('room_message', {
        roomId,
        sender: 'system',
        nickname: 'النظام',
        text: `🎖️ قام ${byUser} بتعيين رتبة ${targetUser} إلى: ${label}`,
        at: new Date().toISOString(),
      });
    } catch (_) {}
  });

  // 🚫 الطرد أو الحظر أو فك الحظر الحقيقي
  socket.on('moderate_user', async (data) => {
    const { roomId, byUser, targetUser, action } = data || {};
    if (!roomId || !byUser || !targetUser) return;
    try {
      const roleDoc = await RoomRole.findOne({ roomId });
      if (!roleDoc) return;

      if (targetUser === roleDoc.owner) {
        socket.emit('admin_error', { msg: '🛡️ لا يمكن طرد أو حظر مالك الغرفة الأصلي!' });
        return;
      }

      const isCreator = roleDoc.owner === byUser;
      const isCoOwner = roleDoc.coOwners.includes(byUser);
      const isAdmin = roleDoc.admins.includes(byUser);

      if (!isCreator && !isCoOwner && !isAdmin) {
        socket.emit('admin_error', { msg: 'ليس لديك صلاحية إدارية!' });
        return;
      }
      if ((action === 'ban' || action === 'unban') && !isCreator && !isCoOwner) {
        socket.emit('admin_error', { msg: 'صلاحية الحظر وفك الحظر للمالك والأونر فقط!' });
        return;
      }
      if (isAdmin && !isCreator && !isCoOwner && roleDoc.coOwners.includes(targetUser)) {
        socket.emit('admin_error', { msg: 'لا يمكنك طرد عضو أعلى منك رتبة!' });
        return;
      }

      if (action === 'unban') {
        roleDoc.banned = roleDoc.banned.filter(u => u !== targetUser);
        await roleDoc.save();
        io.to(roomId).emit('room_roles_updated', {
          roomId,
          owner: roleDoc.owner,
          coOwners: roleDoc.coOwners,
          admins: roleDoc.admins,
          banned: roleDoc.banned,
        });
        io.to(roomId).emit('room_message', {
          roomId,
          sender: 'system',
          nickname: 'النظام',
          text: `✅ قام ${byUser} بفك الحظر عن ${targetUser}`,
          at: new Date().toISOString(),
        });
        return;
      }

      if (action === 'ban') {
        if (!roleDoc.banned.includes(targetUser)) roleDoc.banned.push(targetUser);
        roleDoc.coOwners = roleDoc.coOwners.filter(u => u !== targetUser);
        roleDoc.admins = roleDoc.admins.filter(u => u !== targetUser);
        await roleDoc.save();
        io.to(roomId).emit('room_roles_updated', {
          roomId,
          owner: roleDoc.owner,
          coOwners: roleDoc.coOwners,
          admins: roleDoc.admins,
          banned: roleDoc.banned,
        });
      }

      const roomSockets = io.sockets.adapter.rooms.get(roomId);
      if (roomSockets) {
        for (const sid of roomSockets) {
          const targetSock = io.sockets.sockets.get(sid);
          if (targetSock && targetSock.data && targetSock.data.nickname === targetUser) {
            targetSock.leave(roomId);
            if (targetSock.data.roomIds) targetSock.data.roomIds.delete(roomId);
            targetSock.emit('kicked_from_room', {
              roomId,
              byUser,
              msg: action === 'ban'
                ? `🚫 تم حظرك نهائياً من غرفة ${roomId} بواسطة ${byUser}`
                : `👢 تم طردك من غرفة ${roomId} بواسطة ${byUser}`,
            });
          }
        }
      }

      const chat = require('./routes/chat');
      const mem = chat.__roomMembers(roomId);
      for (let i = mem.length - 1; i >= 0; i--) {
        if (mem[i].nickname === targetUser) mem.splice(i, 1);
      }

      io.to(roomId).emit('room_message', {
        roomId,
        sender: 'system',
        nickname: 'النظام',
        text: action === 'ban'
          ? `🚫 تم حظر ${targetUser} من الغرفة بواسطة ${byUser}`
          : `👢 تم طرد ${targetUser} من الغرفة بواسطة ${byUser}`,
        at: new Date().toISOString(),
      });
      SystemEvents.leave(roomId, targetUser);
    } catch (_) {}
  });

  // 💬 إرسال رسالة خاصة حقيقية وحفظها في MongoDB
  socket.on('private_message', async (data) => {
    const from = String((data && data.from) || '').trim();
    const to = String((data && data.to) || '').trim();
    const text = String((data && data.text) || '').trim();
    if (!from || !to || !text) return;

    const msgObj = { from, to, text, at: new Date().toISOString() };
    try {
      if (mongoose.connection.readyState === 1) {
        await PrivateMsg.create(msgObj);
      }
    } catch (_) {}

    io.to('user:' + to).emit('private_message', msgObj);
    io.to('user:' + from).emit('private_message', msgObj);
  });

  // 🤝 إرسال طلب صداقة مع تنبيه فوري للمستلم
  socket.on('send_friend_request', async (data) => {
    const from = String((data && data.from) || '').trim();
    const to = String((data && data.to) || '').trim();
    if (!from || !to || from === to) return;

    try {
      if (mongoose.connection.readyState === 1) {
        const exists = await FriendReq.findOne({
          $or: [
            { from, to },
            { from: to, to: from },
          ],
        });
        if (exists) {
          socket.emit('friend_info', { msg: 'يوجد طلب صداقة مسبق أو أنتما أصدقاء بالفعل.' });
          return;
        }
        const created = await FriendReq.create({ from, to, status: 'pending' });
        io.to('user:' + to).emit('friend_request_received', {
          id: created._id,
          from,
          message: `لديك طلب صداقة جديد من ${from}`,
        });
        socket.emit('friend_info', { msg: `تم إرسال طلب الصداقة إلى ${to} بنجاح.` });
      }
    } catch (_) {}
  });

  // الرد على طلب الصداقة (قبول أو رفض)
  socket.on('respond_friend_request', async (data) => {
    const { from, to, accept } = data || {};
    if (!from || !to) return;
    try {
      if (mongoose.connection.readyState === 1) {
        await FriendReq.findOneAndUpdate(
          { from, to, status: 'pending' },
          { status: accept ? 'accepted' : 'rejected' },
        );
        if (accept) {
          io.to('user:' + from).emit('friend_info', { msg: `وافق ${to} على طلب صداقتك!` });
          io.to('user:' + to).emit('friend_info', { msg: `أصبحت الآن صديقاً لـ ${from}!` });
        }
      }
    } catch (_) {}
  });

  // Messages (support both 'room_message' and 'message')
  socket.on('room_message', doMessage);
  socket.on('message', doMessage);

  // Leave
  socket.on('leave_room', (a, b) => {
    const { roomId, nickname } = parseJoin(a, b);
    require('./data/botManager').botGreetOrFarewell(io, 'leave', roomId, nickname);
    socket.leave(roomId);
    if (socket.data && socket.data.roomIds) socket.data.roomIds.delete(roomId);
    // إزالة العضو من قائمة الحاضرين عند الخروج الصريح
    try {
      const chat = require('./routes/chat');
      const mem = chat.__roomMembers(roomId);
      for (let i = mem.length - 1; i >= 0; i--) {
        if (mem[i].socketId === socket.id || (mem[i].nickname === nickname && !mem[i].socketId)) {
          mem.splice(i, 1);
        }
      }
    } catch (_) {}
    SystemEvents.leave(roomId, nickname);
  });

  // عند انقطاع الاتصال: نزيل العضو من كل الغرف التي كان فيها ونبث مغادرته
  socket.on('disconnect', () => {
    try {
      const nickname = socket.data && socket.data.nickname;
      const roomIds = Array.from((socket.data && socket.data.roomIds) || []);
      if (!nickname || roomIds.length === 0) return;
      const sidClosed = socket.id;
      // ⚡ فترة سماح: لا نبثّ "خرج" فوراً، بل ننتظر لحظات قصيرة.
      // إن أعاد العميل الاتصال بنفس الاسم خلال هذه الفترة (شائع لدى البوت/الموبايل)
      // نلغي الخروج تماماً حتى لا يصبح البوت "أعمى" بعد انقطاع خاطف.
      setTimeout(() => {
        for (const roomId of roomIds) {
          try {
            const stillHere = io.sockets.adapter.rooms.get(roomId);
            let preserved = false;
            if (stillHere) {
              for (const sid of stillHere) {
                if (sid === sidClosed) continue;
                const other = io.sockets.sockets.get(sid);
                if (other && other.data && other.data.nickname === nickname) {
                  preserved = true;
                  break;
                }
              }
            }
            if (preserved) continue;
            const chat = require('./routes/chat');
            const mem = chat.__roomMembers(roomId);
            for (let i = mem.length - 1; i >= 0; i--) {
              if (mem[i].socketId === sidClosed || (mem[i].nickname === nickname && !mem[i].socketId)) {
                mem.splice(i, 1);
              }
            }
            SystemEvents.leave(roomId, nickname);
          } catch (_) {}
        }
      }, 1500);
    } catch (_) {}
  });
});

// Start Server
server.listen(PORT, () => {
  console.log('==========================================');
  console.log('[NIMBUZZ SERVER STATUS: ONLINE]');
  console.log('[RUNNING ON PORT: ' + PORT + ']');
  console.log('[SOCKET.IO: ENABLED]');
  console.log('==========================================');
  require('./data/botManager');


});
