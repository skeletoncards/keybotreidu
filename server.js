const express = require("express");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

const app = express();
app.use(express.json());

const DB_FILE      = "./keys.json";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "change_me";

// ── In-memory store as primary (survives file write failures) ──
// On Render free tier the filesystem resets on restart, so we keep
// the live DB in memory and only use the file as a cold-start cache.
let memDB = {};

function loadDB() {
    // First call: hydrate from file if it exists
    if (Object.keys(memDB).length === 0) {
        try {
            if (fs.existsSync(DB_FILE)) {
                const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
                memDB = parsed;
            }
        } catch (e) {
            console.warn("[DB] Could not read keys.json:", e.message);
        }
    }
    return memDB;
}

function saveDB(data) {
    memDB = data;
    // Best-effort file write (will fail silently on read-only / ephemeral FS)
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.warn("[DB] Could not persist keys.json (ephemeral FS?):", e.message);
    }
}

function cleanExpired(db) {
    const now = Date.now();
    let changed = false;
    for (const key in db) {
        if (db[key].expiresAt < now) {
            delete db[key];
            changed = true;
        }
    }
    if (changed) saveDB(db);
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

    // Return existing active key if present
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
        verifyCount: 0,
        lastVerified: null,
        createdAt:  Date.now(),
        expiresAt
    };

    saveDB(db);
    return res.json({ success: true, key, expiresAt });
});

// ── Verify (called by Lua script) ─────────────────────────────
// POST /verify { key, userId }
// Keys are valid for their full 24h window and can be re-verified
// (e.g. after executor reset or session file loss). They are still
// userId-bound so sharing a key with someone else won't work.
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
        return res.json({ valid: false, reason: "not registered to this user" });

    if (entry.expiresAt < Date.now()) {
        delete db[key];
        saveDB(db);
        return res.json({ valid: false, reason: "expired" });
    }

    // Track usage for logging — but never block re-verification
    db[key].verifyCount  = (db[key].verifyCount || 0) + 1;
    db[key].lastVerified = Date.now();
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
