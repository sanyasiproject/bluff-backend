import type { ObjectId } from 'mongodb';
import type { Collections } from '../db/documents.js';
import type { AppSettings } from '../types.js';

/** app-wide switches set by admins; kept in memory so every room join can check them for free */
export class SettingsService {
  private guests = true;

  constructor(private readonly cols: Collections) {}

  /** reads the saved settings once at startup; guest play is on until an admin turns it off */
  async load(): Promise<void> {
    const doc = await this.cols.settings.findOne({ _id: 'app' });
    this.guests = doc?.guestsAllowed ?? true;
  }

  get guestsAllowed(): boolean {
    return this.guests;
  }

  async view(): Promise<AppSettings> {
    const doc = await this.cols.settings.findOne({ _id: 'app' });
    const by = doc?.updatedBy ? await this.cols.users.findOne({ _id: doc.updatedBy }, { projection: { displayName: 1 } }) : null;
    return {
      guestsAllowed: doc?.guestsAllowed ?? true,
      updatedBy: by?.displayName ?? null,
      updatedAt: doc?.updatedAt.toISOString() ?? null,
    };
  }

  async setGuestsAllowed(on: boolean, by: ObjectId | null): Promise<AppSettings> {
    await this.cols.settings.updateOne(
      { _id: 'app' },
      { $set: { guestsAllowed: on, updatedBy: by, updatedAt: new Date() } },
      { upsert: true },
    );
    this.guests = on;
    return this.view();
  }
}
