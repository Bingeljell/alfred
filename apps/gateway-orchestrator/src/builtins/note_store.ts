import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type NoteRecord = {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
};

type NoteState = { notes: NoteRecord[] };

export class NoteStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "builtins", "notes.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ notes: [] }, null, 2), "utf8");
    }
  }

  async add(sessionId: string, text: string): Promise<NoteRecord> {
    const state = await this.read();
    const note: NoteRecord = {
      id: randomUUID(),
      sessionId,
      text,
      createdAt: new Date().toISOString()
    };

    state.notes.push(note);
    await this.write(state);
    return note;
  }

  async listBySession(sessionId: string): Promise<NoteRecord[]> {
    const state = await this.read();
    return state.notes.filter((note) => note.sessionId === sessionId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  private async read(): Promise<NoteState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as NoteState;
    if (!parsed || !Array.isArray(parsed.notes)) {
      return { notes: [] };
    }
    return parsed;
  }

  private async write(state: NoteState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
