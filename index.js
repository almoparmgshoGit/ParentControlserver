require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');
const { setupKinde, protectRoute } = require("@kinde-oss/kinde-nodejs-sdk");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Basic Security
app.use(helmet({
    contentSecurityPolicy: false,
}));

// Session Setup (Required for Kinde)
app.use(session({
    secret: process.env.SESSION_SECRET || 'kinde-secret-123',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

const kindeConfig = {
    clientId: process.env.KINDE_CLIENT_ID,
    issuerBaseUrl: process.env.KINDE_ISSUER_URL,
    siteUrl: process.env.KINDE_SITE_URL,
    secret: process.env.KINDE_CLIENT_SECRET,
    redirectUri: process.env.KINDE_REDIRECT_URI,
    postLogoutRedirectUri: process.env.KINDE_LOGOUT_REDIRECT_URI,
};

const kindeClient = setupKinde(kindeConfig);

// Kinde Auth Routes
app.get("/login", kindeClient.login(), (req, res) => {});
app.get("/register", kindeClient.register(), (req, res) => {});
app.get("/callback", kindeClient.callback(), async (req, res) => {
    const user = await kindeClient.getUser(req);
    if (user && user.email === process.env.ALLOWED_ADMIN_EMAIL) {
        res.redirect("/");
    } else {
        // If email doesn't match, logout immediately
        res.redirect("/logout");
    }
});
app.get("/logout", kindeClient.logout());

// Protection Middleware with Admin Email check
const adminOnly = async (req, res, next) => {
    if (await kindeClient.isAuthenticated(req)) {
        const user = await kindeClient.getUser(req);
        if (user.email === process.env.ALLOWED_ADMIN_EMAIL) {
            return next();
        }
        return res.status(403).send("Unauthorized Email");
    }
    res.redirect("/login");
};

app.use("/", adminOnly, express.static(path.join(__dirname, 'public')));

// Devices indexed by their unique deviceId
let devices = {};

io.on('connection', (socket) => {
    console.log('⚡ Connection:', socket.id);

    socket.on('REQUEST_SYNC', () => {
        socket.emit('UPDATE_DEVICE_LIST', Object.values(devices));
    });

    socket.on('DEVICE_REGISTER', (data) => {
        if (!data.deviceId) return;
        devices[data.deviceId] = {
            ...data,
            socketId: socket.id,
            online: true,
            lastSeen: new Date()
        };
        console.log('📱 Registered:', data.model, 'ID:', data.deviceId);
        io.emit('UPDATE_DEVICE_LIST', Object.values(devices));
    });

    socket.on('SCREEN_FRAME', (data) => {
        io.emit('UPDATE_SCREEN_FRAME', { frame: data.frame });
    });

    socket.on('LOCATION_UPDATE', (data) => {
        io.emit('UPDATE_LOCATION', data);
    });

    socket.on('START_MIRRORING', (deviceId) => {
        const dev = devices[deviceId];
        if (dev) io.to(dev.socketId).emit('START_STREAM');
    });

    socket.on('STOP_MIRRORING', (deviceId) => {
        const dev = devices[deviceId];
        if (dev) {
            io.to(dev.socketId).emit('STOP_STREAM');
            io.emit('HIDE_SCREEN_VIEW');
        }
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
                console.log('❌ Device Offline:', devices[id].model);
                break;
            }
        }
        io.emit('UPDATE_DEVICE_LIST', Object.values(devices));
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
