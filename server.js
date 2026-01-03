const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const db = require("./db"); // ✅ DB FILE

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use(bodyParser.json());

/* ================= NO-DB MODE ================= */
// 🔴 CHANGED const -> let (runtime switch)
let NO_DB = process.env.NO_DB === "true";
console.log("NO-DB MODE (START):", NO_DB);

let users = {};
let servers = {};
let channels = {};
let typingUsers = {};

/* ================= LOAD SERVERS ================= */
function loadServers() {
    if (NO_DB) return;
    db.safeQuery("SELECT * FROM servers", (err, rows) => {
        if (err) return console.error("SERVER LOAD ERROR:", err);
        rows.forEach(s => {
            servers[s.name] = {
                creatorId: s.creator_id,
                password: s.password,
                type: s.type
            };
        });
    });
}

/* ================= LOAD CHANNELS ================= */
function loadChannels() {
    if (NO_DB) return;
    db.safeQuery("SELECT * FROM channels", (err, rows) => {
        if (err) return console.error("CHANNEL LOAD ERROR:", err);
        rows.forEach(ch => {
            channels[ch.name] = {
                serverName: ch.server_name,
                creatorId: ch.creator_id,
                password: ch.password,
                type: ch.type || "text",
                messages: []
            };
            typingUsers[ch.name] = new Set();
        });
    });
}

/* ================= LOAD OLD MESSAGES ================= */
function loadMessages() {
    if (NO_DB) return;
    db.safeQuery("SELECT * FROM messages ORDER BY created_at ASC", (err, rows) => {
        if (err) return console.error("MESSAGES LOAD ERROR:", err);

        rows.forEach(m => {
            if (!channels[m.channel]) return;

            if (m.type === "text") {
                channels[m.channel].messages.push({
                    sender: m.sender,
                    text: m.content
                });
            } else if (m.type === "voice") {
                channels[m.channel].messages.push({
                    sender: m.sender,
                    data: m.content,
                    type: m.mime,
                    duration: m.duration
                });
            }
        });
    });
}

/* 🔴 INITIAL LOAD */
if (!NO_DB) {
    loadServers();
    loadChannels();
    loadMessages();
}

/* ================= HTTP ROUTES ================= */

// SIGNIN
app.post("/signin", (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).send("Username required");

    if (NO_DB) return res.send("OK");

    db.safeQuery("SELECT * FROM users WHERE username = ?", [username], (err, rows) => {
        if (err) return res.status(500).send("Database error");

        if (rows.length === 0) {
            db.safeQuery(
                "INSERT INTO users (username) VALUES (?)",
                [username],
                err2 => {
                    if (err2) return res.status(500).send("DB insert error");
                    return res.send("OK");
                }
            );
        } else {
            return res.send("OK");
        }
    });
});

/* ================= CREATE CHANNEL ================= */
app.post("/api/createChannel", (req, res) => {

    const { serverName, name, password, type, creator } = req.body;
    if (!name || !type || !creator)
        return res.json({ success: false, message: "Missing fields" });

    /* 🔴 ADDED: NO-DB TEMP CHANNEL SUPPORT */
    if (NO_DB) {
        if (channels[name])
            return res.json({ success: false, message: "Channel exists" });

        channels[name] = {
            serverName: serverName || "Default",
            creatorId: creator,
            password: password || null,
            type,
            messages: []
        };
        typingUsers[name] = new Set();

        io.emit("updateChannels", channels);
        return res.json({ success: true });
    }

    /* DB MODE (UNCHANGED) */
    db.safeQuery("SELECT * FROM channels WHERE name = ?", [name], (err, rows) => {
        if (err) return res.json({ success: false, message: "DB error" });
        if (rows.length > 0)
            return res.json({ success: false, message: "Channel exists" });

        db.safeQuery(
            "INSERT INTO channels (server_name, name, creator_id, password, type) VALUES (?,?,?,?,?)",
            [serverName || "Default", name, creator, password || null, type],
            err => {
                if (err)
                    return res.json({ success: false, message: "Insert error" });

                channels[name] = {
                    serverName: serverName || "Default",
                    creatorId: creator,
                    password,
                    type,
                    messages: []
                };
                typingUsers[name] = new Set();

                io.emit("updateChannels", channels);
                res.json({ success: true });
            }
        );
    });
});

/* ================= CREATE SERVER ================= */
app.post("/createserver", (req, res) => {
    if (NO_DB) {
        return res.json({ success: false, msg: "No-DB mode enabled" });
    }

    const { type, name, password } = req.body;
    if (!type || !name) return res.json({ success: false });

    db.safeQuery("SELECT * FROM servers WHERE name=?", [name], (err, rows) => {
        if (rows.length > 0) return res.json({ success: false });

        db.safeQuery(
            "INSERT INTO servers (name, creator_id, password, type) VALUES (?,?,?,?)",
            [name, "admin", password || null, type],
            err2 => {
                if (err2) return res.json({ success: false });
                servers[name] = { creatorId: "admin", password, type };
                res.json({ success: true });
            }
        );
    });
});

/* ================= SOCKET.IO ================= */
io.on("connection", socket => {

    /* 🔴 RUNTIME NO-DB SWITCH (UNCHANGED) */
    socket.on("no_db_mode", ({ enabled }) => {
        NO_DB = !!enabled;
        console.log("NO-DB MODE (RUNTIME):", NO_DB);

        if (!NO_DB) {
            servers = {};
            channels = {};
            typingUsers = {};
            loadServers();
            loadChannels();
            loadMessages();
        }
    });

    socket.on("setUsername", uname => {
        users[socket.id] = uname;

        /* 🔴 ADDED: SEND CHANNELS EVEN IN NO-DB */
        socket.emit("updateChannels", channels);
    });

    socket.on("joinChannel", ({ name, password }) => {

        if (!channels[name])
            return socket.emit("joinResult", { success: false });

        if (channels[name].password &&
            channels[name].password !== password)
            return socket.emit("joinResult", { success: false });

        socket.join(name);
        socket.emit("joinResult", {
            success: true,
            name,
            creatorId: channels[name].creatorId,
            type: channels[name].type,
            messages: channels[name].messages
        });
    });

    socket.on("channelMessage", ({ channel, text }) => {

        const sender = users[socket.id];
        const msg = { sender, text };

        channels[channel].messages.push(msg);

        if (!NO_DB) {
            db.safeQuery(
                "INSERT INTO messages (channel, sender, type, content) VALUES (?,?,?,?)",
                [channel, sender, "text", text]
            );
        }

        io.to(channel).emit("channelMessage", { channel, msg });
    });

    socket.on("voiceMessage", ({ channel, data, type, duration }) => {
        if (NO_DB) return;

        const sender = users[socket.id];

        db.safeQuery(
            "INSERT INTO messages (channel, sender, type, content, mime, duration) VALUES (?,?,?,?,?,?)",
            [channel, sender, "voice", data, type, duration]
        );

        channels[channel].messages.push({ sender, data, type, duration });
        io.to(channel).emit("voiceMessage", {
            channel,
            data,
            type,
            sender,
            duration
        });
    });

    socket.on("typing", ({ channel }) => {
        if (!NO_DB)
            socket.to(channel).emit("typing", { user: users[socket.id] });
    });

    socket.on("stopTyping", ({ channel }) => {
        if (!NO_DB)
            socket.to(channel).emit("stopTyping", { user: users[socket.id] });
    });

    socket.on("disconnect", () => delete users[socket.id]);
});

/* ================= START ================= */
server.listen(3000, () =>
    console.log("Server running at http://localhost:3000")
);
