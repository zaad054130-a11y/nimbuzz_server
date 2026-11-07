const express = require('express');
const router = express.Router();
const Room = require('../models/Room');

function normalizeRoomName(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ');
}

// 1. إنشاء غرفة جديدة (عامة مجانية أو خاصة برقم سري)
router.post('/create', async (req, res) => {
    try {
        const { name, description, isPrivate, password, creatorId } = req.body;

        const newRoom = new Room({
            name,
            description,
            isPrivate,
            password: isPrivate ? password : "", // إضافة الرقم السري فقط إذا كانت الغرفة خاصة
            creator: creatorId,
            members: [creatorId] // المالك يدخل للغرفة تلقائياً عند إنشائها
        });

        await newRoom.save();
        res.status(201).json({ msg: "تم إنشاء الغرفة بنجاح!", room: newRoom });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. أمر الطرد أو الحظر أو حظر الـ IP ومنح الإدارة
router.post('/action', async (req, res) => {
    try {
        const { roomId, actionUserId, targetUserId, targetIP, actionType } = req.body;
        // actionUserId: الشخص الذي ينفذ الأمر (المالك أو الإدارة)
        // targetUserId: الشخص المستهدف بالأمر (المطرود أو المحظور)
        // actionType: نوع الأمر (kick / banUser / banIP / makeAdmin)

        const room = await Room.findById(roomId);
        if (!room) return res.status(404).json({ msg: "الغرفة غير موجودة!" });

        // التحقق من الصلاحيات (يجب أن يكون المنفذ هو المالك أو في قائمة الإدارة)
        const isCreator = room.creator.toString() === actionUserId;
        const isAdmin = room.admins.includes(actionUserId);
        if (!isCreator && !isAdmin) {
            return res.status(403).json({ msg: "عذراً، أنت لا تملك صلاحيات التحكم في هذه الغرفة!" });
        }

        // تنفيذ الأمر بناءً على النوع المختار (actionType)
        if (actionType === 'kick') {
            // الطرد: إزالة المستخدم من قائمة الأعضاء المتواجدين حالياً
            room.members = room.members.filter(id => id.toString() !== targetUserId);
            await room.save();
            return res.json({ msg: "تم طرد المستخدم من الغرفة بنجاح!" });
        } 
        
        else if (actionType === 'banUser') {
            // حظر الحساب: إزالته من الأعضاء وإضافته لقائمة الحظر
            room.members = room.members.filter(id => id.toString() !== targetUserId);
            if (!room.bannedUsers.includes(targetUserId)) {
                room.bannedUsers.push(targetUserId);
            }
            await room.save();
            return res.json({ msg: "تم حظر حساب المستخدم من دخول الغرفة!" });
        } 
        
        else if (actionType === 'banIP') {
            // حظر الـ IP الكامل للجهاز لضمان عدم الدخول بجهاز آخر
            room.members = room.members.filter(id => id.toString() !== targetUserId);
            if (targetIP && !room.bannedIPs.includes(targetIP)) {
                room.bannedIPs.push(targetIP);
            }
            await room.save();
            return res.json({ msg: "تم حظر الـ IP الخاص بجهاز المستخدم بالكامل!" });
        } 
        
        else if (actionType === 'makeAdmin') {
            // منح عضوية الإدارة (هذه الصلاحية للمالك فقط)
            if (!isCreator) return res.status(403).json({ msg: "المالك فقط من يمكنه تعيين إدارة!" });
            if (!room.admins.includes(targetUserId)) {
                room.admins.push(targetUserId);
            }
            await room.save();
            return res.json({ msg: "تم منح المستخدم صلاحية الإدارة في الغرفة بنجاح!" });
        }

        res.status(400).json({ msg: "نوع الأمر غير معروف!" });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- غرف داخل الذاكرة (تعمل حتى بدون MongoDB) ---
// الغرف التي ينشئها الأشخاص من التطبيق أو البوت تظهر هنا
const memRooms = [];

// Socket.io instance (injected from server.js) so REST-created rooms reach clients instantly
let _io = null;
function setIo(io) { _io = io; }

// تحويل الغرفة إلى الشكل الموحد الذي تفهمه التطبيقات
function toPublic(r) {
  return {
    _id: String(r._id || r.id || r.name),
    name: String(r.name || '').trim(),
    description: String(r.description || ''),
    membersCount: parseInt(String(r.membersCount || 0)) || 0,
    isPrivate: !!r.isPrivate,
    createdAt: r.createdAt,
  };
}

// بث قائمة الغرف المحدثة لكل العملاء المتصلين فوراً (بدونه لا تظهر الغرف الجديدة للمستخدمين)
function broadcastRooms(extra) {
  try {
    if (!_io) return;
    const list = memRooms.filter(r => r && r._id && r.name).map(toPublic);
    _io.emit('rooms_list', list);
    if (extra) _io.emit('room_created', extra);
  } catch (_) {}
}

// 3. عرض كل الغرف (من MongoDB إن توفرت، وإلا من الذاكرة فقط — بدون غرف وهمية)
router.get('/list', async (req, res) => {
    let dbRooms = null;
    // 1) نحاول جلب الغرف من MongoDB إن كانت متصلة (بدون ما نعطّل أي حاجة لو فشلت)
    try {
        const mongoose = require('mongoose');
        if (mongoose.connection && mongoose.connection.readyState === 1) {
            const rooms = await Room.find().sort({ createdAt: -1 }).limit(100);
            dbRooms = rooms.map(r => ({
                _id: String(r._id),
                name: r.name,
                description: r.description || '',
                membersCount: (r.members || []).length,
                isPrivate: !!r.isPrivate,
            }));
        }
    } catch (_) { dbRooms = null; }

    // 2) عدد الأعضاء الحقيقي من مخزن الشات الحيّ
    const realCounts = {};
    try {
        const chat = require('./chat');
        const mems = chat.__members || {};
        for (const [id, list] of Object.entries(mems)) {
            realCounts[String(id)] = Array.isArray(list) ? list.length : 0;
        }
    } catch (_) {}

    // 3) الغرف المحفوظة في الذاكرة (غرف التطبيق/البوت)
    const mem = memRooms
        .filter(r => r && r._id && r.name)
        .filter(r => normalizeRoomName(r.name).length > 0)
        .filter(r => !(String(r.name) === String(r._id) && String(r.description || '').includes('نشطة')))
        .reduce((acc, r) => {
            const key = normalizeRoomName(r.name);
            const exists = acc.some(item => normalizeRoomName(item.name) === key);
            if (!exists) {
                acc.push({
                    ...r,
                    name: key,
                    membersCount: realCounts[String(r._id)] ?? realCounts[String(r.name)] ?? r.membersCount ?? 0,
                });
            }
            return acc;
        }, []);

    if (Array.isArray(dbRooms) && dbRooms.length) {
        // دمج غرف DB مع غرف الذاكرة بدون تكرار الأسماء
        const names = new Set(dbRooms.map(r => String(r.name)));
        const out = [...dbRooms, ...mem.filter(r => !names.has(String(r.name)))];
        return res.json({ rooms: out, offline: false });
    }
    return res.json({ rooms: mem, offline: true });
});

// 4. إنشاء غرفة بسيطة بدون DB (يستخدمها البوت أو أي عميل)
router.post('/create-simple', (req, res) => {
    const { name, description } = req.body || {};
    const n = normalizeRoomName(name);
    if (!n) return res.status(400).json({ msg: 'اسم الغرفة مطلوب' });
    // منع التكرار: لو الاسم موجود رجّع نفس الغرفة
    const found = memRooms.find(r => normalizeRoomName(r.name) === n);
    if (found) return res.json({ ok: true, room: found, id: String(found._id), existed: true });
    const room = {
        _id: 'room-' + Date.now(),
        name: n,
        description: String(description || 'غرفة حية جديدة'),
        membersCount: 0,
        createdAt: new Date().toISOString(),
        fromApp: true,
    };
    memRooms.unshift(room);
    broadcastRooms({ room: toPublic(room) });
    res.json({ ok: true, room, id: String(room._id) });
});

// 5. مزامنة غرف تطبيق النمبز: يستقبل قائمة الغرف المحلية ويدمجها لتظهر للبوت
router.post('/sync', (req, res) => {
    const { rooms } = req.body || {};
    if (!Array.isArray(rooms)) return res.status(400).json({ msg: 'rooms يجب أن تكون قائمة' });
    let added = 0;
    const addedNames = [];
    for (const r of rooms) {
        const n = normalizeRoomName((r && r.name) || '');
        if (!n) continue;
        if (memRooms.find(x => normalizeRoomName(x.name) === n)) continue;
        memRooms.push({
            _id: String((r && r.id) || 'room-' + Date.now() + '-' + added),
            name: n,
            description: String((r && r.desc) || 'غرفة من تطبيق النمبز'),
            membersCount: parseInt(String((r && r.count) || '0')) || 0,
            createdAt: new Date().toISOString(),
            fromApp: true,
        });
        added++;
        addedNames.push(n);
    }
    // بث القائمة فوراً حتى تظهر الغرف المزامَنة للبوت وللجميع بدون انتظار
    if (added > 0) broadcastRooms({ rooms: memRooms.map(toPublic) });
    res.json({ ok: true, added, addedNames, total: memRooms.length, rooms: memRooms });
});

// 5.5 🗑️ مسح كل الغرف القديمة مرة واحدة (يبقي الغرفة العامة فقط)
router.post('/wipe-all', (req, res) => {
    const keepLobby = req.body && req.body.keepLobby !== false;
    const keep = keepLobby ? memRooms.filter(r => String(r._id) === 'lobby') : [];
    const removedCount = memRooms.length - keep.length;
    const removedIds = memRooms
        .filter(r => String(r._id) !== 'lobby')
        .map(r => String(r._id));
    memRooms.length = 0;
    memRooms.push(...keep);
    // تنظيف سجلات وأعضاء الغرف المحذوفة
    try {
        const chat = require('./chat');
        for (const id of removedIds) {
            delete chat.__history[id];
            delete chat.__members[id];
        }
    } catch (_) {}
    broadcastRooms(null);
    res.json({ ok: true, removed: removedCount, remaining: memRooms.length });
});

// 6. حذف غرفة من الذاكرة + تنظيف سجلها وأعضائها
router.delete('/:id', (req, res) => {
    const id = String(req.params.id);
    const idx = memRooms.findIndex(r => String(r._id) === id);
    if (idx === -1) return res.status(404).json({ msg: 'الغرفة غير موجودة' });
    if (String(memRooms[idx]._id) === 'lobby') {
        return res.status(400).json({ msg: 'لا يمكن حذف الغرفة العامة' });
    }
    const removed = memRooms.splice(idx, 1)[0];
    // تنظيف سجل شات الغرفة المحذوفة وأعضائها أيضاً حتى لا تبقى بيانات يتيمة
    try { const chat = require('./chat'); delete chat.__history[String(removed._id)]; delete chat.__members[String(removed._id)]; } catch (_) {}
    broadcastRooms(null);
    res.json({ ok: true, removed });
});

// دوال مساعدة للحفظ الدائم (يستخدمها server.js)
function addRoomSafe(r) {
    if (!r || !r._id) return;
    if (memRooms.find(x => String(x._id) === String(r._id))) return;
    const roomName = normalizeRoomName(r.name || r._id);
    if (!roomName) return;
    if (memRooms.find(x => normalizeRoomName(x.name) === roomName)) return;
    memRooms.push({
        _id: String(r._id),
        name: roomName,
        description: String(r.description || ''),
        membersCount: parseInt(String(r.membersCount || '0')) || 0,
        createdAt: String(r.createdAt || new Date().toISOString()),
        fromApp: !!r.fromApp,
    });
}

module.exports = router;
module.exports.__setIo = setIo;
module.exports.__addRoom = addRoomSafe;
module.exports.__allRooms = () => memRooms;
