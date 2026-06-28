/**
 * SocialShop API — Package 6  (v0.6.0)
 * -------------------------------------------------------
 * NEW in P6:
 *   • Upload ảnh thật (Local / Cloudinary)  — /api/upload
 *   • Thanh toán VNPay + MoMo               — /api/payment
 *   • Fix: requireAuth destructure đúng trong message/story/search routes
 */

require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const path    = require('path');
const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error.middleware');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── Middleware cơ bản ─────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // for VNPay/MoMo form callbacks
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Kết nối database ──────────────────────────────────────────────────────
connectDB();

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name:    'SocialShop API',
    status:  'ok',
    version: '0.6.0',
    features: ['auth','posts','users','products','orders','notifications',
               'admin','messages','stories','search','upload','payment'],
  });
});

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth.routes'));
app.use('/api/posts',         require('./routes/post.routes'));
app.use('/api/users',         require('./routes/user.routes'));
app.use('/api/products',      require('./routes/product.routes'));
app.use('/api/orders',        require('./routes/order.routes'));
app.use('/api/notifications', require('./routes/notification.routes'));
app.use('/api/admin',         require('./routes/admin.routes'));
app.use('/api/messages',      require('./routes/message.routes'));
app.use('/api/stories',       require('./routes/story.routes'));
app.use('/api/search',        require('./routes/search.routes'));
app.use('/api/upload',        require('./routes/upload.routes'));    // NEW P6
app.use('/api/payment',       require('./routes/payment.routes'));   // NEW P6

// ── Socket.io — Real-time Chat ────────────────────────────────────────────
const { Message, Conversation } = require('./models/Message');
const jwt       = require('jsonwebtoken');
const User      = require('./models/User');

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Chưa đăng nhập'));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findById(decoded.id);
    if (!user) return next(new Error('Token không hợp lệ'));
    socket.user = user;
    next();
  } catch {
    next(new Error('Token không hợp lệ'));
  }
});

const onlineUsers = new Map(); // userId → socketId

io.on('connection', (socket) => {
  const userId = String(socket.user._id);
  onlineUsers.set(userId, socket.id);
  io.emit('online_users', Array.from(onlineUsers.keys()));

  socket.on('join_conversation', (conversationId) => {
    socket.join(`conv:${conversationId}`);
  });

  socket.on('send_message', async ({ conversationId, text, image }) => {
    try {
      const conv = await Conversation.findById(conversationId);
      if (!conv) return;

      const msg = await Message.create({
        conversation: conversationId,
        sender:       socket.user._id,
        text, image,
        readBy: [socket.user._id],
      });
      conv.lastMessage    = msg._id;
      conv.lastMessageAt  = new Date();
      await conv.save();

      await msg.populate('sender', 'username avatar');
      io.to(`conv:${conversationId}`).emit('new_message', msg);

      // Push notification cho người nhận nếu đang online
      const others = conv.participants.filter(p => String(p) !== userId);
      for (const pid of others) {
        const sid = onlineUsers.get(String(pid));
        if (sid) {
          io.to(sid).emit('notification', {
            type:  'message',
            actor: { _id: userId, username: socket.user.username },
            content: text?.slice(0, 60) || '📷 Ảnh',
            conversationId,
          });
        }
      }
    } catch {
      socket.emit('error', { message: 'Gửi tin nhắn thất bại' });
    }
  });

  socket.on('start_conversation', async ({ targetUserId }, callback) => {
    try {
      let conv = await Conversation.findOne({
        participants: { $all: [socket.user._id, targetUserId], $size: 2 },
      });
      if (!conv) {
        conv = await Conversation.create({ participants: [socket.user._id, targetUserId] });
      }
      socket.join(`conv:${conv._id}`);
      const sid = onlineUsers.get(String(targetUserId));
      if (sid) io.to(sid).emit('conversation_started', { conversationId: conv._id });
      callback({ conversationId: conv._id });
    } catch {
      callback({ error: 'Không thể tạo cuộc trò chuyện' });
    }
  });

  socket.on('typing', ({ conversationId }) => {
    socket.to(`conv:${conversationId}`).emit('typing', {
      userId, username: socket.user.username,
    });
  });

  socket.on('stop_typing', ({ conversationId }) => {
    socket.to(`conv:${conversationId}`).emit('stop_typing', { userId });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('online_users', Array.from(onlineUsers.keys()));
  });
});

// ── Error handlers ────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n🚀 SocialShop API v0.6.0 — http://localhost:${PORT}`);
  console.log(`   Socket.io  : ws://localhost:${PORT}`);
  console.log(`   Upload     : /api/upload  (Local${process.env.CLOUDINARY_CLOUD_NAME ? ' + Cloudinary' : ''})`);
  console.log(`   Payment    : /api/payment (VNPay + MoMo — sandbox)\n`);
});
