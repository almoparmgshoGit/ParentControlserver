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

// Basic Security
app.use(helmet({
    contentSecurityPolicy: false,
}));

// Session Setup
app.use(session({
    secret: process.env.SESSION_SECRET || 'parent-control-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Manual Kinde Client Setup
const kindeClient = new KindeClient({
    domain: process.env.KINDE_ISSUER_URL,
    clientId: process.env.KINDE_CLIENT_ID,
    clientSecret: process.env.KINDE_CLIENT_SECRET,
    redirectUri: process.env.KINDE_REDIRECT_URI,
    logoutRedirectUri: process.env.KINDE_LOGOUT_REDIRECT_URI,
    grantType: GrantType.AUTHORIZATION_CODE
});

// 1. Login Route
app.get("/login", async (req, res) => {
    const loginUrl = await kindeClient.login(req);
    res.redirect(loginUrl.href);
});

// 2. Callback Route
app.get("/callback", async (req, res) => {
    try {
        await kindeClient.getToken(req);
        const user = await kindeClient.getUserDetails(req);

        if (user && user.email === process.env.ALLOWED_ADMIN_EMAIL) {
            res.redirect("/");
        } else {
            // Unauthorized email
            res.status(403).send("<h1>Access Denied</h1><p>Unauthorized email address.</p><a href='/logout'>Logout</a>");
        }
    } catch (error) {
        console.error("Auth Error:", error);
        res.redirect("/login");
    }
});

// 3. Logout Route
app.get("/logout", async (req, res) => {
    const logoutUrl = await kindeClient.logout(req);
    res.redirect(logoutUrl.href);
});

// 4. Protection Middleware
const adminOnly = async (req, res, next) => {
    try {
        if (await kindeClient.isAuthenticated(req)) {
            const user = await kindeClient.getUserDetails(req);
            if (user.email === process.env.ALLOWED_ADMIN_EMAIL) {
                return next();
            }
            return res.status(403).send("Unauthorized Email");
        }
    } catch (e) {}
    res.redirect("/login");
};

// Protect the dashboard
app.use("/", adminOnly, express.static(path.join(__dirname, 'public')));

// Devices indexing
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
                break;
            }
        }
        io.emit('UPDATE_DEVICE_LIST', Object.values(devices));
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
