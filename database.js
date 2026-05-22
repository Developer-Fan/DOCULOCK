const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = process.env.VERCEL
    ? '/tmp/doculock.db'
    : path.resolve(__dirname, 'doculock.db');
const wasmPath = path.resolve(__dirname, 'node_modules', 'sql.js', 'dist');

function createTables(db) {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT
        )
    `);

    try {
        db.run(`ALTER TABLE users ADD COLUMN dark_mode INTEGER DEFAULT 0`);
    } catch (err) {
        if (!/duplicate column name/i.test(String(err.message || err))) throw err;
    }
    try {
        db.run(`ALTER TABLE users ADD COLUMN predictive_text INTEGER DEFAULT 1`);
    } catch (err) {
        if (!/duplicate column name/i.test(String(err.message || err))) throw err;
    }

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

    try {
        db.run(`ALTER TABLE document_permissions ADD COLUMN source_share_link_id INTEGER`);
    } catch (err) {
        if (!/duplicate column name/i.test(String(err.message || err))) throw err;
    }

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
}

function persistDatabase(db) {
    try {
        fs.writeFileSync(dbPath, Buffer.from(db.export()));
    } catch (err) {
        console.error('Error saving database:', err.message);
    }
}

const ready = initSqlJs({
    locateFile: (file) => path.join(wasmPath, file)
}).then((SQL) => {
    let db;
    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    createTables(db);
    persistDatabase(db);
    console.log(`Connected to the SQLite-compatible database at ${dbPath}.`);
    return db;
}).catch((err) => {
    console.error('Failed to initialize sql.js database:', err.message);
    throw err;
});

function bindParams(statement, params = []) {
    if (Array.isArray(params)) {
        statement.bind(params);
        return;
    }

    if (params && typeof params === 'object') {
        statement.bind(params);
        return;
    }

    statement.bind([]);
}

function executeSelect(db, sql, params, mode) {
    const statement = db.prepare(sql);
    try {
        bindParams(statement, params);
        const rows = [];
        while (statement.step()) {
            rows.push(statement.getAsObject());
            if (mode === 'get') break;
        }
        return mode === 'get' ? (rows[0] || undefined) : rows;
    } finally {
        statement.free();
    }
}

function executeRun(db, sql, params) {
    const statement = db.prepare(sql);
    try {
        bindParams(statement, params);
        statement.step();
        const lastIDRow = db.exec('SELECT last_insert_rowid() AS id');
        const lastID = lastIDRow?.[0]?.values?.[0]?.[0] ?? 0;
        const changes = typeof db.getRowsModified === 'function' ? db.getRowsModified() : 0;
        persistDatabase(db);
        return { lastID, changes };
    } finally {
        statement.free();
    }
}

const db = {
    get(sql, params = [], callback) {
        ready
            .then((database) => {
                try {
                    const row = executeSelect(database, sql, params, 'get');
                    callback?.(null, row);
                } catch (err) {
                    callback?.(err);
                }
            })
            .catch((err) => callback?.(err));
    },

    all(sql, params = [], callback) {
        ready
            .then((database) => {
                try {
                    const rows = executeSelect(database, sql, params, 'all');
                    callback?.(null, rows);
                } catch (err) {
                    callback?.(err);
                }
            })
            .catch((err) => callback?.(err));
    },

    run(sql, params = [], callback) {
        ready
            .then((database) => {
                try {
                    const result = executeRun(database, sql, params);
                    if (typeof callback === 'function') {
                        callback.call(result, null);
                    }
                } catch (err) {
                    if (typeof callback === 'function') {
                        callback.call({ lastID: 0, changes: 0 }, err);
                    }
                }
            })
            .catch((err) => {
                if (typeof callback === 'function') {
                    callback.call({ lastID: 0, changes: 0 }, err);
                }
            });
    },

    serialize(callback) {
        ready.then(() => {
            if (typeof callback === 'function') callback();
        });
    },

    close(callback) {
        ready
            .then((database) => {
                try {
                    persistDatabase(database);
                    database.close();
                    callback?.(null);
                } catch (err) {
                    callback?.(err);
                }
            })
            .catch((err) => callback?.(err));
    },

    ready
};

module.exports = db;
