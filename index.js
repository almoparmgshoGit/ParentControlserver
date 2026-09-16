require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const path = require('path');
const { setupKinde, protectRoute, getUser } = require("@kinde-oss/kinde-node-express");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Basic Security
app.use(helmet({
    contentSecurityPolicy: false,
}));

// Kinde Configuration for Express SDK
const config = {
    clientId: process.env.KINDE_CLIENT_ID,
    issuerBaseUrl: process.env.KINDE_ISSUER_URL,
    siteUrl: process.env.KINDE_SITE_URL,
    secret: process.env.KINDE_CLIENT_SECRET,
    redirectUrl: process.env.KINDE_REDIRECT_URI,
    postLogoutRedirectUrl: process.env.KINDE_LOGOUT_REDIRECT_URI,
    unAuthorisedUrl: process.env.KINDE_SITE_URL + "/unauthorised",
};

// This sets up /login, /logout, /register, and the callback route automatically
setupKinde(config, app);

// Protection Middleware with Admin Email check
const adminOnly = (req, res, next) => {
    const user = getUser(req);
    if (user && user.email === process.env.ALLOWED_ADMIN_EMAIL) {
        return next();
    }
    // If authenticated but not admin, redirect or show error
    if (user) {
        return res.status(403).send("<h1>Access Denied</h1><p>This email is not authorized to access the control panel.</p><a href='/logout'>Logout</a>");
    }
    // If not authenticated, setupKinde's protectRoute would usually handle this,
    // but we use our own check here to ensure email matching.
    res.redirect("/login");
};

// Protect the entire dashboard
app.use("/", protectRoute, adminOnly, express.static(path.join(__dirname, 'public')));

app.get("/unauthorised", (req, res) => {
    res.status(403).send("<h1>Unauthorised</h1><p>You do not have permission to view this page.</p>");
});

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
