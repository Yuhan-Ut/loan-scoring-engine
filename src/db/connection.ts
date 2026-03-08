import path from 'path';
import sqlite3 from 'sqlite3';
import { config } from '../config';

let db: sqlite3.Database | null = null;

export function getDb(): sqlite3.Database {
  if (!db) {
    const dbPath = path.resolve(process.cwd(), config.databaseFile);
    sqlite3.verbose();
    db = new sqlite3.Database(dbPath);
  }

  return db;
}

