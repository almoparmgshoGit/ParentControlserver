require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// لتمكين قراءة البيانات المرسلة من فورم تسجيل الدخول (POST request)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// تم إيقاف Helmet مؤقتاً لحل مشكلة البطء الشديد والـ Timeout الناتجة عن حظر الاتصالات على الـ IP المباشر
// app.use(helmet({ contentSecurityPolicy: false }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'stable-key-999',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // يجب أن تكون false لأننا نستخدم http وليس https حالياً
        maxAge: 24 * 60 * 60 * 1000 // الجلسة تستمر لمدة يوم كامل
    }
}));

// --- صفحة تسجيل الدخول المدمجة ---
app.get("/login", (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect("/");
    }

    // تصميم بسيط وأنيق لصفحة تسجيل الدخول متوافق مع لوحة التحكم
    res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>تسجيل الدخول - ParentControl</title>
            <style>
                body {
                    background-color: #121212;
                    color: #ffffff;
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                }
                .login-container {
                    background-color: #1e1e1e;
                    padding: 30px;
                    border-radius: 8px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                    width: 100%;
                    max-width: 400px;
                    text-align: center;
                }
                h2 { margin-bottom: 20px; color: #bb86fc; }
                .input-group {
                    margin-bottom: 15px;
                    text-align: right;
                }
                label { display: block; margin-bottom: 5px; color: #a0a0a0; }
                input {
                    width: 100%;
                    padding: 10px;
                    border: 1px solid #333;
                    border-radius: 4px;
                    background-color: #2d2d2d;
                    color: white;
                    box-sizing: border-box;
                }
                input:focus {
                    border-color: #bb86fc;
                    outline: none;
                }
                button {
                    width: 100%;
                    padding: 12px;
                    background-color: #bb86fc;
                    border: none;
                    border-radius: 4px;
                    color: #121212;
                    font-weight: bold;
                    font-size: 16px;
                    cursor: pointer;
                    margin-top: 10px;
                    transition: background 0.3s;
                }
                button:hover { background-color: #9965db; }
                .error { color: #cf6679; margin-top: 15px; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="login-container">
                <h2>ParentControl</h2>
                <p style="color: #a0a0a0; margin-bottom: 20px;">لوحة تحكم المسؤول</p>
                <form action="/login" method="POST">
                    <div class="input-group">
                        <label for="email">البريد الإلكتروني</label>
                        <input type="email" id="email" name="email" required autocomplete="username">
                    </div>
                    <div class="input-group">
                        <label for="password">كلمة المرور</label>
                        <input type="password" id="password" name="password" required autocomplete="current-password">
                    </div>
                    <button type="submit">تسجيل الدخول</button>
                </form>
                ${req.query.error ? \`<div class="error">البريد الإلكتروني أو كلمة المرور غير صحيحة!</div>\` : ''}
            </div>
        </body>
        </html>
    `);
});

// --- معالجة طلب تسجيل الدخول ---
app.post("/login", (req, res) => {
    const { email, password } = req.body;

    const adminEmail = process.env.ALLOWED_ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    // التحقق من البيانات وتطابقها تماماً مع الموجود في الـ .env
    if (email === adminEmail && password === adminPassword) {
        req.session.isAdmin = true;
        req.session.userEmail = email;
        return res.redirect("/");
    } else {
        return res.redirect("/login?error=1");
    }
});

// --- تسجيل الخروج ---
app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/login");
    });
});

// --- حماية المسارات (Middleware) ---
const adminOnly = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.redirect("/login");
};

// تطبيق الحماية على المجلد العام للوحة التحكم
app.use("/", adminOnly, express.static(path.join(__dirname, 'public')));

// منطق الـ Socket.io (مستقر ولم يتغير)
let devices = {};
io.on('connection', (socket) => {
    socket.on('REQUEST_SYNC', () => socket.emit('UPDATE_DEVICE_LIST', Object.values(devices)));
    socket.on('DEVICE_REGISTER', (data) => {
        if (!data.deviceId) return;
        devices[data.deviceId] = { ...data, socketId: socket.id, online: true, lastSeen: new Date() };
        io.emit('UPDATE_DEVICE_LIST', Object.values(devices));
    });
    socket.on('SCREEN_FRAME', (data) => io.emit('UPDATE_SCREEN_FRAME', { frame: data.frame }));
    socket.on('LOCATION_UPDATE', (data) => io.emit('UPDATE_LOCATION', data));
    socket.on('START_MIRRORING', (deviceId) => {
        const dev = devices[deviceId];
        if (dev) io.to(dev.socketId).emit('START_STREAM');
    });
    socket.on('STOP_MIRRORING', (deviceId) => {
        const dev = devices[deviceId];
        if (dev) { io.to(dev.socketId).emit('STOP_STREAM'); io.emit('HIDE_SCREEN_VIEW'); }
    });
    socket.on('REQUEST_LOCATION', (deviceId) => {
        const dev = devices[deviceId];
        if (dev) io.to(dev.socketId).emit('GET_LOCATION');
    });
    socket.on('SEND_LOCK_COMMAND', (deviceId) => {
        const dev = devices[deviceId];
        if (dev) io.to(dev.socketId).emit('REMOTE_LOCK');
    });
    socket.on('SEND_UNINSTALL_COMMAND', (deviceId) => {
        const dev = devices[deviceId];
        if (dev) io.to(dev.socketId).emit('REMOTE_UNINSTALL');
    });
    socket.on('disconnect', () => {
        for (let id in devices) {
            if (devices[id].socketId === socket.id) {
                devices[id].online = false;
                break;
            }
        }
        io.emit('UPDATE_DEVICE_LIST', Object.values(devices));
    });
});

server.listen(3000, '0.0.0.0', () => console.log(`🚀 Server running on port 3000`));
