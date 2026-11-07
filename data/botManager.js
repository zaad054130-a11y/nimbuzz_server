const BOT_NAME = "مساعد السيرفر التلقائي";

/**
 * دالة للتحقق من أوامر المستخدم واستدعاء البوت للغرفة
 */
function checkBotCommands(io, msg) {
    try {
        // التأكد من وجود رسالة، ونص، ومن أنها ليست مرسلة من البوت نفسه
        if (!msg || !msg.text || msg.nickname === BOT_NAME) return;

        const text = msg.text.trim();
        const roomId = msg.roomId;

        // 1. التحقق الدقيق من كلمة "مساعدة" أو "help" (تطابق تام ومكتوبة داخل غرفة)
        if ((text === 'مساعدة' || text === 'help') && roomId) {
            const responseText = 
                `🔔 أهلاً بك! أنا البوت المساعد للغرفة. كيف يمكنني خدمتك؟ يرجى كتابة استفسارك هنا.\n\n` +
                `🔔 Hello! I am the room assistant bot. How can I help you? Please type your inquiry here.`;

            sendBotMessage(io, roomId, responseText);
            return; 
        }

        // 2. التحقق الدقيق من أمر استدعاء البوت للغرفة
        if (text.startsWith('ادخل غرفة ')) {
            const targetRoom = text.replace('ادخل غرفة ', '').trim();
            if (!targetRoom) return;

            const chat = require('./routes/chat'); // تأكد من صحة مسار المجلد لديك أونلاين
            const mem = chat.__roomMembers(targetRoom);

            if (mem) {
                // التأكد من عدم تكرار البوت في الغرفة المستهدفة
                const botExists = mem.some(m => m.nickname === BOT_NAME);
                
                if (!botExists) {
                    const newBot = {
                        socketId: null,
                        nickname: BOT_NAME,
                        isBot: true,
                        joinedAt: new Date().toISOString()
                    };
                    mem.push(newBot);

                    // بث حدث انضمام البوت إلى جميع المتواجدين في الغرفة لتحديث القائمة فوراً
                    io.to(targetRoom).emit('user_joined_room', {
                        roomId: targetRoom,
                        user: newBot,
                        members: mem
                    });
                }

                // إرسال رسالة تأكيد النجاح داخل الغرفة المستهدفة مباشرة وليس الخاص
                const successText = `🤖 [✔] تم حضور البوت بنجاح إلى الغرفة [${targetRoom}] وهو جاهز لخدمتكم والتفاعل معكم!`;
                sendBotMessage(io, targetRoom, successText);
                console.log(`[BOT SYSTEM] البوت انضم بنجاح إلى الغرفة أونلاين: ${targetRoom}`);
            }
        }
    } catch (error) {
        console.error('[BOT COMMAND ERROR]:', error);
    }
}

/**
 * دالة الترحيب والتوديع التلقائي للبوت
 */
function botGreetOrFarewell(io, eventType, roomId, nickname) {
    try {
        if (nickname === BOT_NAME || !roomId) return;

        let responseText = "";
        if (eventType === 'join') {
            responseText = `🌹 أهلاً وسهلاً بك يا ${nickname} نورت الغرفة ✨`;
        } else if (eventType === 'leave') {
            responseText = `👋 مع السلامة يا ${nickname}، نشوفك على خير.`;
        }

        if (responseText) {
            sendBotMessage(io, roomId, responseText);
        }
    } catch (error) {
        console.error('[BOT GREET ERROR]:', error);
    }
}

/**
 * دالة مساعدة موحدة لبث رسائل البوت إلى الغرفة المحددة
 */
function sendBotMessage(io, roomId, text) {
    const botMessage = {
        id: `bot_msg_${Date.now()}`,
        roomId: roomId,
        nickname: BOT_NAME,
        text: text,
        isBot: true,
        createdAt: new Date().toISOString()
    };
    
    setTimeout(() => {
        io.to(roomId).emit('new_message', botMessage);
    }, 1000);
}

module.exports = {
    checkBotCommands,
    botGreetOrFarewell
};
