const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// محاولة اتصال MongoDB (اختياري — السيرفر يعمل بدونه)
try {
  const mongoose = require('mongoose');
    const dbURI = "mongodb+srv://zaad054130_db_user:jGhqy0Uu23nRkN7W@cluster0.aqt7qfq.mongodb.net/nimbuzz_db?retryWrites=true&w=majority";
  mongoose.connect(dbURI)
    .then(() => console.log("[DATABASE] CONNECTED SUCCESSFULLY!"))
    .catch((err) => console.log("[DATABASE] OFFLINE MODE (no mongo) — chat/login-demo still works:", err.message));
} catch (e) {
  console.log("[DATABASE] mongoose not available, running in memory mode");
}

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
app.set('io', io);

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
      await require('./botManager').checkBotCommands(io, msg);
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

    try {
      await require('./data/botManager').checkBotCommands(
        io,
        { roomId: socket.id, nickname: 'مستخدم Nimbuzz', text },
        socket.id,
      );
    } catch (error) {
      console.error('[BOT COMMAND ERROR]:', error);
      socket.emit('bot_reply', { text: 'تعذر تنفيذ الأمر حالياً. يرجى المحاولة مرة أخرى.' });
    }
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
