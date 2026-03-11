const express = require("express");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

const app = express();
app.use(express.json());

const DB_FILE      = "./keys.json";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "change_me";

function loadDB() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "{}");
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function cleanExpired(db) {
    const now = Date.now();
    for (const key in db) {
        if (db[key].expiresAt < now) delete db[key];
    }
    saveDB(db);
    return db;
}

// ── Generate (called by bot) ──────────────────────────────────
// POST /generate { secret, userId, discordId, discordTag }
app.post("/generate", (req, res) => {
    const { secret, userId, discordId, discordTag } = req.body;

    if (secret !== ADMIN_SECRET)
        return res.status(403).json({ success: false, reason: "Unauthorized" });

    if (!userId || !discordId)
        return res.status(400).json({ success: false, reason: "Missing fields" });

    let db = loadDB();
    db = cleanExpired(db);

    // Check for existing active key for this userId
    const existing = Object.values(db).find(
        e => e.userId === String(userId) && e.expiresAt > Date.now()
    );
    if (existing) {
        return res.json({
            success: false,
            reason: "already_active",
            key: existing.key,
            expiresAt: existing.expiresAt
        });
    }

    const key       = uuidv4();
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h

    db[key] = {
        key,
        userId:     String(userId),
        discordId:  String(discordId),
        discordTag: discordTag || "unknown",
        used:       false,
        usedAt:     null,
        createdAt:  Date.now(),
        expiresAt
    };

    saveDB(db);
    return res.json({ success: true, key, expiresAt });
});

// ── Verify (called by Lua script) ─────────────────────────────
// POST /verify { key, userId }
app.post("/verify", (req, res) => {
    const { key, userId } = req.body;
    if (!key || !userId)
        return res.status(400).json({ valid: false, reason: "Missing fields" });

    let db = loadDB();
    db = cleanExpired(db);

    const entry = db[key];
    if (!entry)
        return res.json({ valid: false, reason: "Key not found or expired" });
    if (entry.userId !== String(userId))
        return res.json({ valid: false, reason: "Key not registered to this user" });
    if (entry.used)
        return res.json({ valid: false, reason: "Key already used" });
    if (entry.expiresAt < Date.now()) {
        delete db[key];
        saveDB(db);
        return res.json({ valid: false, reason: "Key expired" });
    }

    // One-time use — mark it
    db[key].used   = true;
    db[key].usedAt = Date.now();
    saveDB(db);

    return res.json({ valid: true, expiresAt: entry.expiresAt });
});

// ── Admin: revoke a key ───────────────────────────────────────
// DELETE /revoke { secret, userId }
app.delete("/revoke", (req, res) => {
    const { secret, userId } = req.body;
    if (secret !== ADMIN_SECRET)
        return res.status(403).json({ success: false });

    let db = loadDB();
    let removed = 0;
    for (const key in db) {
        if (db[key].userId === String(userId)) {
            delete db[key];
            removed++;
        }
    }
    saveDB(db);
    return res.json({ success: true, removed });
});

// ── Admin: list all keys ──────────────────────────────────────
// GET /keys?secret=xxx
app.get("/keys", (req, res) => {
    if (req.query.secret !== ADMIN_SECRET)
        return res.status(403).json([]);

    const db = loadDB();
    cleanExpired(db);
    return res.json(Object.values(db));
});

app.get("/", (req, res) => res.send("reidu key server online"));

app.listen(3000, () => console.log("[Server] Running on :3000"));