const express = require('express');
const router = express.Router();

// مخزن رسائل داخل الذاكرة (يعمل حتى بدون MongoDB)
// roomId -> [{ sender, nickname, text, at }]
const history = {};
function roomHist(id) {
  if (!history[id]) history[id] = [];
  return history[id];
}

// مخزن أعضاء الغرف الحالية: roomId -> [{ nickname, joinedAt }]
const members = {};
function roomMembers(id) {
  if (!members[id]) members[id] = [];
  return members[id];
}

function liveRoomMembers(id, io) {
  const roomId = String(id);
  const socketIds = io?.sockets?.adapter?.rooms?.get(roomId);
  const live = [];
  if (socketIds) {
    for (const socketId of socketIds) {
      const socket = io.sockets.sockets.get(socketId);
      const nickname = String(socket?.data?.nickname || '').trim();
      if (!nickname) continue;
      const previous = roomMembers(roomId).find(
        member => member.socketId === socketId,
      );
      live.push({
        nickname,
        joinedAt: previous?.joinedAt || new Date().toISOString(),
        socketId,
      });
    }
  }
  live.push(...roomMembers(roomId).filter(member => member.isBot && !member.socketId));
  members[roomId] = live;
  return live;
}

// جلب سجل رسائل غرفة
router.get('/history/:roomId', (req, res, next) => {
  const id = String(req.params.roomId || '').trim();
  try {
    res.json({ roomId: id, messages: roomHist(id).slice(-100) });
  } catch (e) { next(e); }
});

// جلب أعضاء غرفة (الحاضرين الآن)
router.get('/members/:roomId', (req, res, next) => {
  const id = String(req.params.roomId || '').trim();
  try {
    res.json({
      roomId: id,
      members: liveRoomMembers(id, req.app.get('io')),
    });
  } catch (e) { next(e); }
});

// بديل: جلب السجل/الأعضاء عبر query parameter (لمساحات الأسماء التي تحتوي رموزاً)
router.get('/history', (req, res, next) => {
  try {
    const id = String((req.query && req.query.roomId) || '').trim();
    res.json({ roomId: id, messages: roomHist(id).slice(-100) });
  } catch (e) { next(e); }
});
router.get('/members', (req, res, next) => {
  try {
    const id = String((req.query && req.query.roomId) || '').trim();
    res.json({
      roomId: id,
      members: liveRoomMembers(id, req.app.get('io')),
    });
  } catch (e) { next(e); }
});

// دخول عضو للغرفة: يسجل حضوره + يضيف رسالة نظام "دخل"
router.post('/join', (req, res) => {
  const { roomId, nickname } = req.body || {};
  if (!roomId || !nickname) return res.status(400).json({ msg: 'roomId و nickname مطلوبان' });
  const mem = roomMembers(roomId);
  if (!mem.find(m => m.nickname === nickname)) {
    mem.push({ nickname, joinedAt: new Date().toISOString() });
  }
  const h = roomHist(roomId);
  h.push({ sender: 'system', nickname: 'النظام', text: '__join__:' + nickname, at: new Date().toISOString() });
  if (h.length > 300) h.splice(0, h.length - 300);
  const io = req.app.get('io');
  if (io) io.to(String(roomId)).emit('member_joined', { roomId: String(roomId), nickname });
  res.json({ ok: true, members: mem });
});

// مغادرة عضو للغرفة: يزيله + رسالة نظام "غادر"
router.post('/leave', (req, res) => {
  const { roomId, nickname } = req.body || {};
  if (!roomId || !nickname) return res.status(400).json({ msg: 'roomId و nickname مطلوبان' });
  const mem = roomMembers(roomId);
  const idx = mem.findIndex(m => m.nickname === nickname);
  if (idx !== -1) mem.splice(idx, 1);
  const h = roomHist(roomId);
  h.push({ sender: 'system', nickname: 'النظام', text: '__leave__:' + nickname, at: new Date().toISOString() });
  if (h.length > 300) h.splice(0, h.length - 300);
  const io = req.app.get('io');
  if (io) io.to(String(roomId)).emit('member_left', { roomId: String(roomId), nickname });
  res.json({ ok: true, members: mem });
});

// إرسال رسالة لغرفة (REST — يستخدمه البوت أو أي عميل)
router.post('/send', (req, res) => {
  const { roomId, sender, nickname, text } = req.body || {};
  if (!roomId || !text) return res.status(400).json({ msg: 'roomId و text مطلوبان' });
  const msg = { sender: sender || 'anon', nickname: nickname || 'زائر', text, at: new Date().toISOString() };
  const h = roomHist(roomId);
  h.push(msg);
  if (h.length > 300) h.splice(0, h.length - 300);
  const io = req.app.get('io');
  if (io) io.to(String(roomId)).emit('room_message', { roomId: String(roomId), ...msg });
  res.json({ ok: true, message: msg });
});

module.exports = router;
module.exports.__history = history;
module.exports.__roomHist = roomHist;
module.exports.__members = members;
module.exports.__roomMembers = roomMembers;
module.exports.__liveRoomMembers = liveRoomMembers;
