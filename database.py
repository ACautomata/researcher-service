"""数据库层"""
import json
import os
import aiosqlite
from config import DB_PATH


async def init_db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS papers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT, original_name TEXT, ext TEXT,
                size_bytes INTEGER, status TEXT DEFAULT 'uploaded',
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS keywords (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                word TEXT NOT NULL, weight REAL DEFAULT 0, category TEXT,
                source_paper_id INTEGER,
                UNIQUE(word, category)
            );
            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL, category TEXT, source TEXT,
                status TEXT DEFAULT 'draft', paper_id INTEGER,
                keywords_json TEXT DEFAULT '[]',
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS problems (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL, description TEXT,
                source TEXT, source_type TEXT DEFAULT 'kb',
                category TEXT, severity TEXT DEFAULT 'medium',
                validated INTEGER DEFAULT 0, validating INTEGER DEFAULT 0,
                validation_method TEXT, validation_score REAL,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS ideas (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL, description TEXT,
                from_problem TEXT,
                novelty REAL DEFAULT 0, feasibility REAL DEFAULT 0,
                impact REAL DEFAULT 0, overall_score REAL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS algorithms (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL, code TEXT,
                language TEXT DEFAULT 'Python',
                from_idea TEXT,
                tested INTEGER DEFAULT 0, testing INTEGER DEFAULT 0,
                test_total INTEGER DEFAULT 0, test_passed INTEGER DEFAULT 0,
                perf_before_ms REAL DEFAULT 0, perf_after_ms REAL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL, status TEXT DEFAULT 'pending',
                progress INTEGER DEFAULT 0, step TEXT,
                result_json TEXT, error TEXT,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                updated_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime')),
                expires_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id INTEGER PRIMARY KEY,
                ai_api_base TEXT DEFAULT '',
                ai_api_key TEXT DEFAULT '',
                ai_model TEXT DEFAULT '',
                anthropic_api_key TEXT DEFAULT '',
                anthropic_base_url TEXT DEFAULT '',
                anthropic_model TEXT DEFAULT '',
                theme_color TEXT DEFAULT 'aurora',
                updated_at TEXT DEFAULT (datetime('now','localtime')),
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS domains (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now','localtime')),
                updated_at TEXT DEFAULT (datetime('now','localtime'))
            );
        """)
        await db.commit()
        try:
            await db.execute("ALTER TABLE user_settings ADD COLUMN theme_color TEXT DEFAULT 'aurora'")
            await db.commit()
        except Exception:
            pass
        try:
            await db.execute("ALTER TABLE papers ADD COLUMN domain_id INTEGER DEFAULT NULL")
            await db.commit()
        except Exception:
            pass
        try:
            await db.execute("ALTER TABLE papers ADD COLUMN markdown_content TEXT DEFAULT ''")
            await db.commit()
        except Exception:
            pass


async def db_query(sql, params=()):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(sql, params)
        return [dict(r) for r in await cur.fetchall()]


async def db_execute(sql, params=()):
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(sql, params)
        await db.commit()
        return cur.lastrowid


async def update_task(tid, progress, step, status="running", result=None, error=None):
    await db_execute(
        "UPDATE tasks SET progress=?,step=?,status=?,result_json=?,error=?,"
        "updated_at=datetime('now','localtime') WHERE id=?",
        (progress, step, status,
         json.dumps(result, ensure_ascii=False) if result else None,
         error, tid))