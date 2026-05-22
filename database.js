const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'doculock.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
    }
});

function addColumnIfMissing(tableName, columnDefinition) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`, (err) => {
        if (err && !/duplicate column name/i.test(err.message)) {
            console.error(`Error updating ${tableName}:`, err.message);
        }
    });
}

// Initialize Tables
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT
        )
    `);

    addColumnIfMissing('users', 'dark_mode INTEGER DEFAULT 0');
    addColumnIfMissing('users', 'predictive_text INTEGER DEFAULT 1');

    db.run(`
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            title TEXT,
            content TEXT,
            format TEXT DEFAULT 'docx',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER,
            content TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (document_id) REFERENCES documents(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS document_permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER,
            user_id INTEGER,
            permission_level TEXT DEFAULT 'view',
            granted_by INTEGER,
            source_share_link_id INTEGER,
            granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(document_id, user_id),
            FOREIGN KEY (document_id) REFERENCES documents(id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (granted_by) REFERENCES users(id)
        )
    `);

    addColumnIfMissing('document_permissions', 'source_share_link_id INTEGER');

    db.run(`
        CREATE TABLE IF NOT EXISTS share_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER,
            token TEXT UNIQUE,
            permission_level TEXT DEFAULT 'view',
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME,
            access_count INTEGER DEFAULT 0,
            last_accessed DATETIME,
            FOREIGN KEY (document_id) REFERENCES documents(id),
            FOREIGN KEY (created_by) REFERENCES users(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS document_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER,
            user_id INTEGER,
            username TEXT,
            message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (document_id) REFERENCES documents(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
});

module.exports = db;
