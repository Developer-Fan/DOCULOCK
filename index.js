const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./database');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Groq
const GROQ_API_KEY = process.env.GROQ_API_KEY || "YOUR_GROQ_API_KEY_HERE";
const groq = new Groq({ apiKey: GROQ_API_KEY });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'apple-style-doculock-secret-key-123!',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if deploying with HTTPS
}));

// --- Middleware: Verify Auth ---
function isAuthenticated(req, res, next) {
    if (req.session.userId) {
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
            req.session.userId = user.id;
            req.session.username = user.username;
            res.json({ success: true, message: 'Logged in.' });
        } else {
            res.status(400).json({ error: 'Invalid credentials.' });
        }
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logged out.' });
});

app.get('/api/me', isAuthenticated, (req, res) => {
    res.json({ username: req.session.username });
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
    db.run(`INSERT INTO documents (user_id, title, content, format) VALUES (?, ?, ?, ?)`, 
    [req.session.userId, title || 'Untitled', content || '', format || 'docx'], function(err) {
        if (err) return res.status(500).json({ error: 'Database error.' });
        res.json({ id: this.lastID, success: true });
    });
});

app.get('/api/docs/:id', isAuthenticated, (req, res) => {
    db.get(`SELECT * FROM documents WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error.' });
        if (!row) return res.status(404).json({ error: 'Not found.' });
        res.json(row);
    });
});

app.put('/api/docs/:id', isAuthenticated, (req, res) => {
    const { title, content, format } = req.body;
    db.run(`UPDATE documents SET title = ?, content = ?, format = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
    [title, content, format, req.params.id, req.session.userId], function(err) {
        if (err) return res.status(500).json({ error: 'Database error.' });
        res.json({ success: true });
    });
});

app.delete('/api/docs/:id', isAuthenticated, (req, res) => {
    db.run(`DELETE FROM documents WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId], function(err) {
        if (err) return res.status(500).json({ error: 'Database error.' });
        res.json({ success: true });
    });
});

// --- AI Chat/Completion Route ---
app.post('/api/ai/chat', isAuthenticated, async (req, res) => {
    const { message, documentContent } = req.body;
    
    const promptSystem = `You are Llama 3, a highly intelligent AI assistant integrated into a document editor called DocuLock. 
If the user asks you to modify, rewrite, or write something into the document, you MUST output the new document content wrapped in EXACTLY these delimiters:
$$NEW_CONTENT_START$$
(new document content here)
$$NEW_CONTENT_END$$

If you are only providing chat advice or answering a question without making a direct edit to the document, just reply normally. If you do edit, you can optionally provide a regular message explaining the edit before or after the delimiter blocks.`;

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
app.post('/api/ai/autocomplete', isAuthenticated, async (req, res) => {
    const { contextText } = req.body;
    try {
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

// Map export routes dynamically below...
const exportRoutes = require('./export-routes');
app.use('/api/export', isAuthenticated, exportRoutes);


app.listen(PORT, () => {
    console.log(`DocuLock Server running on http://localhost:${PORT}`);
});
