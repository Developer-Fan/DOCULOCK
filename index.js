const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const db = require('./database');
const Groq = require('groq-sdk');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Groq
const GROQ_API_KEY = process.env.GROQ_API_KEY || "YOUR_GROQ_API_KEY_HERE";
const groq = new Groq({ apiKey: GROQ_API_KEY });

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: true,
        credentials: true
    }
});

io.use((socket, next) => {
    const auth = getAuthFromRequest(socket.request);
    if (auth) {
        socket.request.auth = auth;
        socket.request.session = { userId: auth.userId, username: auth.username };
    }
    next();
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) return reject(err);
        resolve(this);
    });
});

const AUTH_COOKIE_NAME = 'doculock_auth';
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.SESSION_SECRET || 'doculock-auth-secret';

function parseCookies(header = '') {
    return header.split(';').reduce((cookies, part) => {
        const index = part.indexOf('=');
        if (index === -1) return cookies;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
        return cookies;
    }, {});
}

function signAuthValue(value) {
    return crypto.createHmac('sha256', AUTH_SECRET).update(value).digest('base64url');
}

function createAuthToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = signAuthValue(body);
    return `${body}.${signature}`;
}

function verifyAuthToken(token) {
    if (!token || typeof token !== 'string') return null;
    const [body, signature] = token.split('.');
    if (!body || !signature) return null;

    const expectedSignature = signAuthValue(body);
    const expectedBuffer = Buffer.from(expectedSignature);
    const providedBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== providedBuffer.length) return null;
    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) return null;

    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload || !payload.userId || !payload.username) return null;
        return payload;
    } catch {
        return null;
    }
}

function getAuthFromRequest(req) {
    const cookies = parseCookies(req.headers?.cookie || '');
    return verifyAuthToken(cookies[AUTH_COOKIE_NAME]);
}

function attachAuthContext(req, res, next) {
    req.session = req.session || {};
    const auth = getAuthFromRequest(req);
    if (auth) {
        req.auth = auth;
        req.session.userId = auth.userId;
        req.session.username = auth.username;
    }
    next();
}

function setAuthCookie(res, auth) {
    const secure = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
    let cookie = `${AUTH_COOKIE_NAME}=${createAuthToken(auth)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}`;
    if (secure) cookie += '; Secure';
    res.setHeader('Set-Cookie', cookie);
}

function clearAuthCookie(res) {
    const secure = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
    let cookie = `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    if (secure) cookie += '; Secure';
    res.setHeader('Set-Cookie', cookie);
}

const activeCollaborators = new Map();

function buildShareUrl(token, req) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return `${baseUrl}/editor.html?share=${token}`;
}

function colorForIdentifier(identifier) {
    const palette = ['#4f8cff', '#ff6b6b', '#20c997', '#f59f00', '#845ef7', '#15aabf'];
    let hash = 0;
    for (let index = 0; index < identifier.length; index++) {
        hash = (hash * 31 + identifier.charCodeAt(index)) >>> 0;
    }
    return palette[hash % palette.length];
}

function getRoomName(documentId) {
    return `document:${documentId}`;
}

function getCollaboratorList(documentId) {
    const room = activeCollaborators.get(Number(documentId));
    return room ? Array.from(room.values()) : [];
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    return fallback;
}

function canEditWithPermission(permissionLevel) {
    return ['edit', 'admin', 'owner'].includes(permissionLevel);
}

async function grantDocumentPermission(documentId, userId, permissionLevel, grantedBy, sourceShareLinkId = null) {
    if (!documentId || !userId) return;

    const existing = await dbGet(
        'SELECT id FROM document_permissions WHERE document_id = ? AND user_id = ?',
        [documentId, userId]
    );

    if (existing) {
        await dbRun(
            'UPDATE document_permissions SET permission_level = ?, granted_by = ?, source_share_link_id = ?, granted_at = CURRENT_TIMESTAMP WHERE id = ?',
            [permissionLevel, grantedBy || null, sourceShareLinkId, existing.id]
        );
        return;
    }

    await dbRun(
        'INSERT INTO document_permissions (document_id, user_id, permission_level, granted_by, source_share_link_id) VALUES (?, ?, ?, ?, ?)',
        [documentId, userId, permissionLevel, grantedBy || null, sourceShareLinkId]
    );
}

async function getPermissionAccess(documentId, userId) {
    if (!userId) return null;

    return dbGet(
        `SELECT document_permissions.permission_level, document_permissions.source_share_link_id, share_links.id AS active_share_link_id, share_links.expires_at
         FROM document_permissions
         LEFT JOIN share_links ON share_links.id = document_permissions.source_share_link_id
         WHERE document_permissions.document_id = ? AND document_permissions.user_id = ?`,
        [documentId, userId]
    );
}

async function resolveDocumentAccess(documentId, userId = null, shareToken = null) {
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [documentId]);
    if (!document) return null;

    if (userId && Number(document.user_id) === Number(userId)) {
        return {
            document,
            accessType: 'owner',
            permissionLevel: 'owner',
            canEdit: true
        };
    }

    const sharedPermission = await getPermissionAccess(documentId, userId);
    if (sharedPermission) {
        const activeShareLink = sharedPermission.active_share_link_id && (!sharedPermission.expires_at || new Date(sharedPermission.expires_at) >= new Date());
        if (!sharedPermission.source_share_link_id || activeShareLink) {
            return {
                document,
                accessType: 'shared',
                permissionLevel: sharedPermission.permission_level || 'view',
                canEdit: canEditWithPermission(sharedPermission.permission_level)
            };
        }
    }

    if (shareToken) {
        const shareLink = await dbGet(
            'SELECT * FROM share_links WHERE token = ? AND document_id = ?',
            [shareToken, documentId]
        );

        if (shareLink) {
            const expired = shareLink.expires_at && new Date(shareLink.expires_at) < new Date();
            if (!expired) {
                return {
                    document,
                    shareLink,
                    accessType: 'share',
                    permissionLevel: shareLink.permission_level || 'view',
                    canEdit: canEditWithPermission(shareLink.permission_level)
                };
            }
        }
    }

    return null;
}

async function persistCollaborativeUpdate(documentId, title, content, format) {
    const normalizedFormat = ['docx', 'tex', 'board'].includes(format) ? format : 'docx';
    await dbRun(
        'UPDATE documents SET title = ?, content = ?, format = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [title, content, normalizedFormat, documentId]
    );
}

function updatePresence(documentId) {
    io.to(getRoomName(documentId)).emit('collab:presence', {
        documentId: Number(documentId),
        collaborators: getCollaboratorList(documentId),
        count: getCollaboratorList(documentId).length
    });
}

function upsertCollaborator(documentId, socketId, patch) {
    const key = Number(documentId);
    const room = activeCollaborators.get(key) || new Map();
    const existing = room.get(socketId) || {};
    room.set(socketId, {
        ...existing,
        ...patch,
        socketId,
        documentId: key
    });
    activeCollaborators.set(key, room);
    updatePresence(key);
}

function removeCollaborator(documentId, socketId) {
    const key = Number(documentId);
    const room = activeCollaborators.get(key);
    if (!room) return;
    room.delete(socketId);
    if (room.size === 0) {
        activeCollaborators.delete(key);
    }
    updatePresence(key);
}

function disconnectCollaboratorSockets(documentId, userId) {
    const key = Number(documentId);
    const room = activeCollaborators.get(key);
    if (!room) return;

    for (const [socketId, collaborator] of room.entries()) {
        if (Number(collaborator.userId) !== Number(userId)) continue;

        const socket = io.sockets.sockets.get(socketId);
        if (!socket) {
            removeCollaborator(key, socketId);
            continue;
        }

        socket.emit('collab:error', { message: 'Your access to this document was removed by the owner.' });
        socket.disconnect(true);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(attachAuthContext);

// --- Middleware: Verify Auth ---
function isAuthenticated(req, res, next) {
    if (req.auth || req.session.userId) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
}

// --- Auth Routes ---
app.post('/api/register', async (req, res) => {
    const { username, password, confirmPassword, honeypot } = req.body;

    // Anti-bot: If honeypot is filled, it's a bot
    if (honeypot) return res.status(400).json({ error: 'Bot detected.' });
    if (!username || !password || !confirmPassword) return res.status(400).json({ error: 'Missing fields.' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hashedPassword], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username taken.' });
                return res.status(500).json({ error: 'Database error.' });
            }
            setAuthCookie(res, { userId: this.lastID, username });
            req.session.userId = this.lastID;
            req.session.username = username;
            res.json({ success: true, message: 'Account created successfully.' });
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password, honeypot } = req.body;

    // Anti-bot feature
    if (honeypot) return res.status(400).json({ error: 'Bot detected.' });

    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error.' });
        if (!user) return res.status(400).json({ error: 'Invalid credentials.' });

        const match = await bcrypt.compare(password, user.password);
        if (match) {
            setAuthCookie(res, { userId: user.id, username: user.username });
            req.session.userId = user.id;
            req.session.username = user.username;
            res.json({ success: true, message: 'Logged in.' });
        } else {
            res.status(400).json({ error: 'Invalid credentials.' });
        }
    });
});

app.post('/api/logout', (req, res) => {
    if (typeof req.session?.destroy === 'function') {
        req.session.destroy(() => {});
    }
    clearAuthCookie(res);
    res.json({ success: true, message: 'Logged out.' });
});

app.get('/api/me', isAuthenticated, (req, res) => {
    res.json({ username: req.auth?.username || req.session.username });
});

// --- Document Routes ---
app.get('/api/docs', isAuthenticated, (req, res) => {
    db.all(`SELECT id, title, format, updated_at FROM documents WHERE user_id = ? ORDER BY updated_at DESC`, [req.session.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error.' });
        res.json(rows);
    });
});

app.post('/api/docs', isAuthenticated, (req, res) => {
    const { title, content, format } = req.body;
    const normalizedFormat = ['docx', 'tex', 'board'].includes(format) ? format : 'docx';
    db.run(`INSERT INTO documents (user_id, title, content, format) VALUES (?, ?, ?, ?)`,
    [req.session.userId, title || 'Untitled', content || '', normalizedFormat], function(err) {
        if (err) return res.status(500).json({ error: 'Database error.' });
        res.json({ id: this.lastID, success: true });
    });
});

app.get('/api/docs/:id', isAuthenticated, (req, res) => {
    (async () => {
        try {
            const access = await resolveDocumentAccess(req.params.id, req.session.userId);
            if (!access || !access.document) return res.status(404).json({ error: 'Not found.' });
            res.json({
                document: access.document,
                accessType: access.accessType,
                permissionLevel: access.permissionLevel,
                canEdit: access.canEdit
            });
        } catch (err) {
            res.status(500).json({ error: 'Database error.' });
        }
    })();
});

app.put('/api/docs/:id', isAuthenticated, (req, res) => {
    (async () => {
        const { title, content, format } = req.body;
        try {
            const access = await resolveDocumentAccess(req.params.id, req.session.userId);
            if (!access || !access.document) return res.status(404).json({ error: 'Not found.' });
            if (!access.canEdit) return res.status(403).json({ error: 'Forbidden.' });

            await persistCollaborativeUpdate(req.params.id, title, content, format);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: 'Database error.' });
        }
    })();
});

app.delete('/api/docs/:id', isAuthenticated, async (req, res) => {
    try {
        const document = await dbGet('SELECT id FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!document) return res.status(403).json({ error: 'Forbidden.' });

        await dbRun('DELETE FROM document_chat_messages WHERE document_id = ?', [req.params.id]);
        await dbRun('DELETE FROM versions WHERE document_id = ?', [req.params.id]);
        await dbRun('DELETE FROM document_permissions WHERE document_id = ?', [req.params.id]);
        await dbRun('DELETE FROM share_links WHERE document_id = ?', [req.params.id]);
        await dbRun('DELETE FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);

        activeCollaborators.delete(Number(req.params.id));
        io.to(getRoomName(req.params.id)).emit('document:deleted', { documentId: Number(req.params.id) });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.delete('/api/docs/:id/collaborators/:permissionId', isAuthenticated, async (req, res) => {
    try {
        const document = await dbGet('SELECT id FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!document) return res.status(403).json({ error: 'Forbidden' });

        const collaborator = await dbGet(
            `SELECT document_permissions.id, document_permissions.user_id, users.username
             FROM document_permissions
             INNER JOIN users ON users.id = document_permissions.user_id
             WHERE document_permissions.id = ? AND document_permissions.document_id = ?`,
            [req.params.permissionId, req.params.id]
        );

        if (!collaborator) return res.status(404).json({ error: 'Collaborator not found.' });

        await dbRun('DELETE FROM document_permissions WHERE id = ? AND document_id = ?', [req.params.permissionId, req.params.id]);
        disconnectCollaboratorSockets(req.params.id, collaborator.user_id);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.get('/api/shared-docs', isAuthenticated, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT DISTINCT documents.id, documents.title, documents.content, documents.format, documents.updated_at,
                    document_permissions.permission_level,
                    users.username AS owner_username
             FROM document_permissions
             INNER JOIN documents ON documents.id = document_permissions.document_id
             INNER JOIN users ON users.id = documents.user_id
             LEFT JOIN share_links ON share_links.id = document_permissions.source_share_link_id
             WHERE document_permissions.user_id = ?
               AND documents.user_id != ?
               AND (
                    document_permissions.source_share_link_id IS NULL
                    OR (
                        share_links.id IS NOT NULL
                        AND (share_links.expires_at IS NULL OR share_links.expires_at > CURRENT_TIMESTAMP)
                    )
               )
             ORDER BY documents.updated_at DESC`,
            [req.session.userId, req.session.userId]
        );

        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.get('/api/docs/:id/share-links', isAuthenticated, async (req, res) => {
    try {
        const document = await dbGet('SELECT id FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!document) return res.status(403).json({ error: 'Forbidden' });

        const links = await dbAll(
            'SELECT id, token, permission_level, created_at, expires_at, access_count, last_accessed FROM share_links WHERE document_id = ? ORDER BY created_at DESC',
            [req.params.id]
        );

        res.json(links);
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.get('/api/docs/:id/share-info', isAuthenticated, async (req, res) => {
    try {
        const document = await dbGet('SELECT id FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!document) return res.status(403).json({ error: 'Forbidden' });

        const links = await dbAll(
            `SELECT id, token, permission_level, created_at, expires_at, access_count, last_accessed
             FROM share_links
             WHERE document_id = ?
             ORDER BY created_at DESC`,
            [req.params.id]
        );

        const collaborators = await dbAll(
            `SELECT document_permissions.id,
                    document_permissions.permission_level,
                    document_permissions.granted_at,
                    document_permissions.source_share_link_id,
                    users.username,
                    share_links.token AS share_token,
                    share_links.expires_at AS share_expires_at
             FROM document_permissions
             INNER JOIN users ON users.id = document_permissions.user_id
             LEFT JOIN share_links ON share_links.id = document_permissions.source_share_link_id
             WHERE document_permissions.document_id = ?
             ORDER BY document_permissions.permission_level DESC, users.username COLLATE NOCASE ASC`,
            [req.params.id]
        );

        res.json({ links, collaborators });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.post('/api/docs/:id/share-links', isAuthenticated, async (req, res) => {
    const { permissionLevel = 'edit', expiresAt = null } = req.body;
    try {
        const document = await dbGet('SELECT id, user_id FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!document) return res.status(403).json({ error: 'Forbidden' });

        const normalizedPermission = permissionLevel === 'view' ? 'view' : 'edit';
        const token = crypto.randomBytes(16).toString('hex');

        await dbRun(
            'INSERT INTO share_links (document_id, token, permission_level, created_by, expires_at) VALUES (?, ?, ?, ?, ?)',
            [req.params.id, token, normalizedPermission, req.session.userId, expiresAt || null]
        );

        res.json({
            success: true,
            token,
            permissionLevel: normalizedPermission,
            url: buildShareUrl(token, req)
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.delete('/api/share-links/:linkId', isAuthenticated, async (req, res) => {
    try {
        const link = await dbGet(
            `SELECT share_links.id, share_links.document_id
             FROM share_links
             JOIN documents ON documents.id = share_links.document_id
             WHERE share_links.id = ? AND documents.user_id = ?`,
            [req.params.linkId, req.session.userId]
        );

        if (!link) return res.status(403).json({ error: 'Forbidden' });

        await dbRun('DELETE FROM share_links WHERE id = ?', [req.params.linkId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.get('/api/share/:token', async (req, res) => {
    try {
        const shareLink = await dbGet('SELECT * FROM share_links WHERE token = ?', [req.params.token]);
        if (!shareLink) return res.status(404).json({ error: 'Share link not found.' });

        const expired = shareLink.expires_at && new Date(shareLink.expires_at) < new Date();
        if (expired) return res.status(410).json({ error: 'Share link expired.' });

        const document = await dbGet('SELECT id, title, content, format, updated_at FROM documents WHERE id = ?', [shareLink.document_id]);
        if (!document) return res.status(404).json({ error: 'Document not found.' });

        if (req.session.userId) {
            await grantDocumentPermission(
                shareLink.document_id,
                req.session.userId,
                shareLink.permission_level || 'view',
                shareLink.created_by,
                shareLink.id
            );
        }

        await dbRun(
            'UPDATE share_links SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?',
            [shareLink.id]
        );

        res.json({
            document,
            shareToken: req.params.token,
            permissionLevel: shareLink.permission_level || 'view',
            canEdit: shareLink.permission_level === 'edit'
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.put('/api/share/:token', async (req, res) => {
    const { title, content, format } = req.body;
    try {
        const shareLink = await dbGet('SELECT * FROM share_links WHERE token = ?', [req.params.token]);
        if (!shareLink) return res.status(404).json({ error: 'Share link not found.' });

        const expired = shareLink.expires_at && new Date(shareLink.expires_at) < new Date();
        if (expired) return res.status(410).json({ error: 'Share link expired.' });

        if (shareLink.permission_level !== 'edit') {
            return res.status(403).json({ error: 'This share link is view-only.' });
        }

        await persistCollaborativeUpdate(shareLink.document_id, title, content, format);
        await dbRun(
            'UPDATE share_links SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?',
            [shareLink.id]
        );

        io.to(getRoomName(shareLink.document_id)).emit('document:update', {
            documentId: Number(shareLink.document_id),
            title,
            content,
            format,
            source: 'share-api',
            updatedAt: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.get('/api/settings', isAuthenticated, async (req, res) => {
    try {
        const user = await dbGet('SELECT username, dark_mode, predictive_text FROM users WHERE id = ?', [req.session.userId]);
        if (!user) return res.status(404).json({ error: 'Not found.' });

        res.json({
            username: user.username,
            darkMode: normalizeBoolean(user.dark_mode),
            predictiveText: normalizeBoolean(user.predictive_text, true)
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.put('/api/settings', isAuthenticated, async (req, res) => {
    const darkMode = normalizeBoolean(req.body.darkMode);
    const predictiveText = normalizeBoolean(req.body.predictiveText, true);

    try {
        await dbRun(
            'UPDATE users SET dark_mode = ?, predictive_text = ? WHERE id = ?',
            [darkMode ? 1 : 0, predictiveText ? 1 : 0, req.session.userId]
        );
        res.json({ success: true, darkMode, predictiveText });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.post('/api/change-password', isAuthenticated, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'Missing fields.' });
    }

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New passwords do not match.' });
    }

    try {
        const user = await dbGet('SELECT password FROM users WHERE id = ?', [req.session.userId]);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const matches = await bcrypt.compare(currentPassword, user.password);
        if (!matches) {
            return res.status(400).json({ error: 'Current password is incorrect.' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbRun('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.session.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

app.post('/api/docs/:id/invite', isAuthenticated, async (req, res) => {
    const { username, permissionLevel = 'view' } = req.body;

    if (!username) return res.status(400).json({ error: 'Username is required.' });

    try {
        const document = await dbGet('SELECT id, user_id FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!document) return res.status(403).json({ error: 'Forbidden' });

        const invitedUser = await dbGet('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)', [username.trim()]);
        if (!invitedUser) return res.status(404).json({ error: 'User not found.' });

        const normalizedPermission = permissionLevel === 'edit' ? 'edit' : 'view';
        await grantDocumentPermission(document.id, invitedUser.id, normalizedPermission, req.session.userId, null);

        res.json({ success: true, username: invitedUser.username, permissionLevel: normalizedPermission });
    } catch (err) {
        res.status(500).json({ error: 'Database error.' });
    }
});

// --- AI Chat/Completion Route ---
app.post('/api/ai/chat', isAuthenticated, async (req, res) => {
    const { message, documentContent, tone, persona } = req.body;

    // Tone presets for system prompt modification
    const toneModifiers = {
        'Academic': 'Write in an academic, formal tone with proper citations and structured arguments.',
        'Creative': 'Write in a creative, engaging tone with vivid descriptions and varied sentence structure.',
        'Concise': 'Write in a concise, direct tone. Be brief and to the point without unnecessary elaboration.',
        'Expand': 'Write with more detail and elaboration. Provide comprehensive explanations and examples.'
    };

    // AI Personas
    const personaInstructions = {
        'Editor': 'You are a professional editor. Focus on grammar, clarity, structure, and flow. Provide detailed feedback on how to improve the writing.',
        'Brainstormer': 'You are a creative brainstorming partner. Generate new ideas, expand on concepts, suggest examples, and help the user think deeper about their topic.',
        'Critic': 'You are a constructive critic. Analyze the writing for logical consistency, arguments, evidence, and provide thoughtful critique without being harsh.',
        'Summarizer': 'You are a summarization expert. Distill the key points into a concise summary that captures the essence of the content.',
        'Llama': 'You are Llama 3, a highly intelligent AI assistant integrated into a document editor called DocuLock.'
    };

    const toneInstruction = tone && toneModifiers[tone] ? `\nTone: ${toneModifiers[tone]}` : '';
    const personaBase = personaInstructions[persona] || personaInstructions['Llama'];

    const promptSystem = `${personaBase}
If the user asks you to modify, rewrite, or write something into the document, you MUST output the new document content wrapped in EXACTLY these delimiters:
$$NEW_CONTENT_START$$
(new document content here)
$$NEW_CONTENT_END$$

If you are only providing chat advice or answering a question without making a direct edit to the document, just reply normally. If you do edit, you can optionally provide a regular message explaining the edit before or after the delimiter blocks.${toneInstruction}`;

    const promptContext = documentContent
        ? `Here is the current content of my document for context:\n` + documentContent + `\n\nUser question: ` + message
        : `User question: ` + message;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: promptSystem },
                { role: 'user', content: promptContext }
            ],
            model: 'llama-3.3-70b-versatile',
        });

        const rawReply = chatCompletion.choices[0]?.message?.content || "";
        let chatReply = rawReply;
        let diff = null;

        // Parse edits
        const editMatch = rawReply.match(/\$\$NEW_CONTENT_START\$\$\s*([\s\S]*?)\s*\$\$NEW_CONTENT_END\$\$/);
        if (editMatch) {
            diff = editMatch[1];
            chatReply = rawReply.replace(editMatch[0], '').trim();
            if(!chatReply) chatReply = "I have proposed edits to the document.";
        }

        res.json({ reply: chatReply, edits: diff });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'AI Error', details: err.message });
    }
});

// --- Ghost Text Autocomplete ---
app.post('/api/ai/autocomplete', async (req, res) => {
    const { contextText, documentId, shareToken } = req.body;
    try {
        const userId = req.session.userId || null;
        let access = null;

        if (documentId && userId) {
            access = await resolveDocumentAccess(documentId, userId);
        }

        if (!access && documentId && shareToken) {
            access = await resolveDocumentAccess(documentId, null, shareToken);
        }

        if (!access || !access.canEdit) {
            return res.status(403).json({ error: 'Autocomplete is unavailable for this document.' });
        }

        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "You are an autocomplete engine inside a document editor (like GitHub Copilot). Provide ONLY the exact next few words or the rest of the sentence based on the context. No pleasantries, no markdown blocks, no quotes. Just the raw continuation string." },
                { role: "user", content: `Context:\n${contextText}` }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.3,
            max_tokens: 20
        });
        res.json({ prediction: completion.choices[0]?.message?.content || "" });
    } catch (err) {
        console.error("Autocomplete Error: ", err);
        res.status(500).json({ error: 'AI Error' });
    }
});

// --- Citation Manager ---
app.post('/api/ai/cite', isAuthenticated, async (req, res) => {
    const { query } = req.body;
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "You are a BibTeX generator. The user provides a query for a paper, concept, or author. You MUST output ONLY the raw valid BibTeX entry for the most likely intended paper/source. Do not wrap in markdown or backticks." },
                { role: "user", content: `Find the BibTeX for: ${query}` }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.2
        });
        res.json({ bibtex: completion.choices[0]?.message?.content || "" });
    } catch (err) {
        console.error("Cite Error: ", err);
        res.status(500).json({ error: 'AI Error' });
    }
});

// --- Version History ---
app.post('/api/documents/:id/versions', isAuthenticated, (req, res) => {
    const { content } = req.body;
    // ensure doc belongs to user
    db.get('SELECT id FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err, doc) => {
        if (!doc) return res.status(403).json({error: 'Forbidden'});
        db.run('INSERT INTO versions (document_id, content) VALUES (?, ?)', [req.params.id, content], function(err) {
            if (err) return res.status(500).json({error: 'DB error'});
            res.json({ success: true, versionId: this.lastID });
        });
    });
});

app.get('/api/documents/:id/versions', isAuthenticated, (req, res) => {
    db.get('SELECT id FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err, doc) => {
        if (!doc) return res.status(403).json({error: 'Forbidden'});
        db.all('SELECT id, created_at FROM versions WHERE document_id = ? ORDER BY created_at DESC', [req.params.id], (err, rows) => {
            res.json(rows || []);
        });
    });
});

app.get('/api/documents/:id/versions/:vid', isAuthenticated, (req, res) => {
    db.get('SELECT content FROM versions WHERE id = ? AND document_id = ?', [req.params.vid, req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({error: 'Not found'});
        res.json({ content: row.content });
    });
});

app.delete('/api/documents/:id/versions/:vid', isAuthenticated, (req, res) => {
    db.get('SELECT id FROM documents WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err, doc) => {
        if (!doc) return res.status(403).json({error: 'Forbidden'});
        db.run('DELETE FROM versions WHERE id = ? AND document_id = ?', [req.params.vid, req.params.id], function(err) {
            res.json({success: true});
        });
    });
});

io.on('connection', (socket) => {
    socket.on('collab:join', async ({ documentId, shareToken }) => {
        try {
            const userId = socket.request.session?.userId || null;
            const access = await resolveDocumentAccess(documentId, userId, shareToken || null);

            if (!access) {
                socket.emit('collab:error', { message: 'Access denied for this document.' });
                return;
            }

            socket.data.documentId = Number(documentId);
            socket.data.permissionLevel = access.permissionLevel;
            socket.data.canEdit = access.canEdit;

            const username = socket.request.session?.username || `Guest ${socket.id.slice(-4)}`;
            const collaborator = {
                socketId: socket.id,
                userId,
                username,
                color: colorForIdentifier(username),
                permissionLevel: access.permissionLevel,
                canEdit: access.canEdit,
                isTyping: false,
                cursor: null,
                lastSeen: new Date().toISOString()
            };

            socket.join(getRoomName(documentId));
            upsertCollaborator(documentId, socket.id, collaborator);

            const chatHistory = await dbAll(
                `SELECT id, document_id, user_id, username, message, created_at
                 FROM document_chat_messages
                 WHERE document_id = ?
                 ORDER BY created_at DESC, id DESC
                 LIMIT 50`,
                [documentId]
            );

            socket.emit('collab:sync', {
                documentId: Number(documentId),
                title: access.document.title,
                content: access.document.content,
                format: access.document.format,
                permissionLevel: access.permissionLevel,
                canEdit: access.canEdit,
                collaborators: getCollaboratorList(documentId)
            });

            socket.emit('collab:chat:history', {
                documentId: Number(documentId),
                messages: (chatHistory || []).reverse()
            });
        } catch (err) {
            socket.emit('collab:error', { message: 'Unable to join collaboration session.' });
        }
    });

    socket.on('collab:chat:send', async (payload = {}) => {
        const documentId = socket.data.documentId || payload.documentId;
        const rawMessage = typeof payload.message === 'string' ? payload.message.trim() : '';

        if (!documentId || !rawMessage) return;

        try {
            const access = await resolveDocumentAccess(documentId, socket.request.session?.userId || null);
            if (!access) {
                socket.emit('collab:error', { message: 'Access denied for this document.' });
                return;
            }

            const username = socket.request.session?.username || `Guest ${socket.id.slice(-4)}`;
            const insertResult = await dbRun(
                `INSERT INTO document_chat_messages (document_id, user_id, username, message)
                 VALUES (?, ?, ?, ?)`,
                [Number(documentId), socket.request.session?.userId || null, username, rawMessage]
            );

            const message = {
                id: insertResult.lastID,
                documentId: Number(documentId),
                userId: socket.request.session?.userId || null,
                username,
                message: rawMessage,
                createdAt: new Date().toISOString(),
                color: colorForIdentifier(username)
            };

            io.to(getRoomName(documentId)).emit('collab:chat:message', message);
        } catch (err) {
            socket.emit('collab:error', { message: 'Unable to send chat message.' });
        }
    });

    socket.on('document:update', async (payload = {}) => {
        const documentId = socket.data.documentId || payload.documentId;
        if (!documentId) return;
        if (!socket.data.canEdit) {
            socket.emit('collab:error', { message: 'This document is read-only.' });
            return;
        }

        try {
            const title = typeof payload.title === 'string' ? payload.title : '';
            const content = typeof payload.content === 'string' ? payload.content : '';
            const format = payload.format === 'tex' ? 'tex' : payload.format === 'board' ? 'board' : 'docx';

            await persistCollaborativeUpdate(documentId, title, content, format);
            upsertCollaborator(documentId, socket.id, { lastSeen: new Date().toISOString(), isTyping: false });

            socket.to(getRoomName(documentId)).emit('document:update', {
                documentId: Number(documentId),
                title,
                content,
                format,
                sourceSocketId: socket.id,
                updatedBy: socket.request.session?.username || 'Guest',
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            socket.emit('collab:error', { message: 'Failed to sync document.' });
        }
    });

    socket.on('cursor:update', (payload = {}) => {
        const documentId = socket.data.documentId || payload.documentId;
        if (!documentId) return;

        upsertCollaborator(documentId, socket.id, {
            cursor: payload.cursor || null,
            isTyping: Boolean(payload.isTyping),
            lastSeen: new Date().toISOString()
        });

        socket.to(getRoomName(documentId)).emit('cursor:update', {
            documentId: Number(documentId),
            socketId: socket.id,
            username: socket.request.session?.username || 'Guest',
            cursor: payload.cursor || null,
            isTyping: Boolean(payload.isTyping),
            color: colorForIdentifier(socket.request.session?.username || socket.id)
        });
    });

    socket.on('disconnect', () => {
        if (socket.data.documentId) {
            removeCollaborator(socket.data.documentId, socket.id);
        }
    });
});

// Map export routes dynamically below...
const exportRoutes = require('./export-routes');
app.use('/api/export', exportRoutes);

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`DocuLock Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;
module.exports.app = app;
module.exports.server = server;
