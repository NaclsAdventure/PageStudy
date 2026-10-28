import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { StudyRecord } from './types';

interface PageStudyDB extends DBSchema {
  records: {
    key: string;
    value: StudyRecord;
    indexes: {
      'by-updated': number;
      'by-url': string;
      'by-status': string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<PageStudyDB>> | null = null;

function getDb(): Promise<IDBPDatabase<PageStudyDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PageStudyDB>('pagestudy', 1, {
      upgrade(db) {
        const store = db.createObjectStore('records', { keyPath: 'id' });
        store.createIndex('by-updated', 'updatedAt');
        store.createIndex('by-url', 'page.url');
        store.createIndex('by-status', 'status');
      },
    });
  }
  return dbPromise;
}

export async function saveRecord(record: StudyRecord): Promise<void> {
  const db = await getDb();
  await db.put('records', { ...record, updatedAt: Date.now() });
}

export async function getRecord(id: string): Promise<StudyRecord | undefined> {
  const db = await getDb();
  return db.get('records', id);
}

export async function listRecords(): Promise<StudyRecord[]> {
  const db = await getDb();
  const all = await db.getAll('records');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function findRecordsByUrl(url: string): Promise<StudyRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex('records', 'by-url', url);
}

export async function deleteRecord(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('records', id);
}

export async function clearRecords(): Promise<void> {
  const db = await getDb();
  await db.clear('records');
}

export async function exportRecords(): Promise<StudyRecord[]> {
  return listRecords();
}

export async function importRecords(records: StudyRecord[]): Promise<number> {
  const db = await getDb();
  let count = 0;
  const tx = db.transaction('records', 'readwrite');
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.page) continue;
    await tx.store.put(record);
    count += 1;
  }
  await tx.done;
  return count;
}
