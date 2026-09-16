require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');
const { KindeClient, GrantType } = require("@kinde-oss/kinde-nodejs-sdk");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(helmet({ contentSecurityPolicy: false }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'stable-key-999',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Setup Kinde with explicit config
const kindeClient = new KindeClient({
    domain: process.env.KINDE_ISSUER_URL,
    clientId: process.env.KINDE_CLIENT_ID,
    clientSecret: process.env.KINDE_CLIENT_SECRET,
    redirectUri: process.env.KINDE_REDIRECT_URI,
    logoutRedirectUri: process.env.KINDE_LOGOUT_REDIRECT_URI,
    grantType: GrantType.AUTHORIZATION_CODE
});

app.get("/login", async (req, res) => {
    try {
        const loginUrl = await kindeClient.login(req);
        const url = loginUrl && loginUrl.href ? loginUrl.href : loginUrl;
        res.redirect(url);
    } catch (e) {
        console.error("Login Error:", e);
        res.status(500).send("Login initialization failed");
    }
});

app.get("/callback", async (req, res) => {
    try {
        await kindeClient.getToken(req);
        const user = await kindeClient.getUserDetails(req);
        if (user && user.email === process.env.ALLOWED_ADMIN_EMAIL) {
            res.redirect("/");
        } else {
            res.status(403).send("<h1>Forbidden</h1><p>Email not allowed.</p><a href='/logout'>Logout</a>");
        }
    } catch (e) {
        console.error("Callback Error:", e);
        res.redirect("/login");
    }
});

app.get("/logout", async (req, res) => {
    try {
        const logoutUrl = await kindeClient.logout(req);
        const url = logoutUrl && logoutUrl.href ? logoutUrl.href : logoutUrl;
        res.redirect(url);
    } catch (e) {
        res.redirect("/");
    }
});

const adminOnly = async (req, res, next) => {
    try {
        if (await kindeClient.isAuthenticated(req)) {
            const user = await kindeClient.getUserDetails(req);
            if (user.email === process.env.ALLOWED_ADMIN_EMAIL) return next();
        }
    } catch (e) {}
    res.redirect("/login");
};

app.use("/", adminOnly, express.static(path.join(__dirname, 'public')));

// Socket logic remains unchanged and stable
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
