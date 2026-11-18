import type { ObjectId } from 'mongodb';
import type { Collections } from '../db/documents.js';
import type { AppSettings } from '../types.js';

/** the switches an admin can change */
export type SettingsChange = Partial<Pick<AppSettings, 'guestsAllowed' | 'pushInvites'>>;

/** the ranked season now on, for code with no settings service at hand (PublicUser, profiles); set on load and each new season */
let seasonNow = 1;

/** the ranked season now on (1 until the settings are loaded) */
export const rankedSeasonNow = (): number => seasonNow;

/** app-wide switches set by admins; kept in memory so every room join and invite can check them for free */
export class SettingsService {
  private guests = true;
  private invites = true;
  private season = 1;

  constructor(private readonly cols: Collections) {}

  /** reads the saved settings once at startup; both switches are on until an admin turns them off */
  async load(): Promise<void> {
    const doc = await this.cols.settings.findOne({ _id: 'app' });
    this.guests = doc?.guestsAllowed ?? true;
    this.invites = doc?.pushInvites ?? true;
    this.setSeason(doc?.rankedSeason ?? 1);
  }

  get guestsAllowed(): boolean {
    return this.guests;
  }

  /** the admin switch for invite notifications (the server also needs push keys) */
  get pushInvites(): boolean {
    return this.invites;
  }

  /** the ranked season now on; older documents have none: 1 */
  get rankedSeason(): number {
    return this.season;
  }

  async view(): Promise<AppSettings> {
    const doc = await this.cols.settings.findOne({ _id: 'app' });
    const by = doc?.updatedBy ? await this.cols.users.findOne({ _id: doc.updatedBy }, { projection: { displayName: 1 } }) : null;
    return {
      guestsAllowed: doc?.guestsAllowed ?? true,
      pushInvites: doc?.pushInvites ?? true,
      // the season ranked games are rated in right now
      rankedSeason: this.season,
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

  /** starts the next ranked season in one atomic write (older documents count as season 1); returns its number */
  async nextRankedSeason(by: ObjectId | null): Promise<number> {
    const doc = await this.cols.settings.findOneAndUpdate(
      { _id: 'app' },
      [
        {
          $set: {
            rankedSeason: { $add: [{ $ifNull: ['$rankedSeason', 1] }, 1] },
            guestsAllowed: { $ifNull: ['$guestsAllowed', true] },
            updatedBy: by,
            updatedAt: new Date(),
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );
    this.setSeason(doc?.rankedSeason ?? this.season + 1);
    return this.season;
  }

  /** keeps the season here and for rankedSeasonNow */
  private setSeason(season: number): void {
    this.season = season;
    seasonNow = season;
  }
}
