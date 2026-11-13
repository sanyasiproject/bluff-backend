import type { ObjectId } from 'mongodb';
import type { Collections } from '../db/documents.js';
import type { AppSettings } from '../types.js';

/** the switches an admin can change */
export type SettingsChange = Partial<Pick<AppSettings, 'guestsAllowed' | 'pushInvites'>>;

/** app-wide switches set by admins; kept in memory so every room join and invite can check them for free */
export class SettingsService {
  private guests = true;
  private invites = true;

  constructor(private readonly cols: Collections) {}

  /** reads the saved settings once at startup; both switches are on until an admin turns them off */
  async load(): Promise<void> {
    const doc = await this.cols.settings.findOne({ _id: 'app' });
    this.guests = doc?.guestsAllowed ?? true;
    this.invites = doc?.pushInvites ?? true;
  }

  get guestsAllowed(): boolean {
    return this.guests;
  }

  /** the admin switch for invite notifications (the server also needs push keys) */
  get pushInvites(): boolean {
    return this.invites;
  }

  async view(): Promise<AppSettings> {
    const doc = await this.cols.settings.findOne({ _id: 'app' });
    const by = doc?.updatedBy ? await this.cols.users.findOne({ _id: doc.updatedBy }, { projection: { displayName: 1 } }) : null;
    return {
      guestsAllowed: doc?.guestsAllowed ?? true,
      pushInvites: doc?.pushInvites ?? true,
      updatedBy: by?.displayName ?? null,
      updatedAt: doc?.updatedAt.toISOString() ?? null,
    };
  }

  async update(change: SettingsChange, by: ObjectId | null): Promise<AppSettings> {
    await this.cols.settings.updateOne(
      { _id: 'app' },
      { $set: { ...change, updatedBy: by, updatedAt: new Date() } },
      { upsert: true },
    );
    if (change.guestsAllowed !== undefined) this.guests = change.guestsAllowed;
    if (change.pushInvites !== undefined) this.invites = change.pushInvites;
    return this.view();
  }
}
