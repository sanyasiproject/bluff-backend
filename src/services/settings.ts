import type { ObjectId } from 'mongodb';
import type { Collections } from '../db/documents.js';
import type { AppSettings } from '../types.js';

/** the switches an admin can change */
export type SettingsChange = Partial<Pick<AppSettings, 'guestsAllowed' | 'pushInvites'>>;

/** the ranked season now on, for code with no settings service at hand (PublicUser, profiles); set on load and each new season */
let seasonNow = 1;
/** when it started, and when the next one starts once an admin asked for it */
let seasonStartedAt: Date | null = null;
let seasonNextAt: Date | null = null;

/** the ranked season now on (1 until the settings are loaded) */
export const rankedSeasonNow = (): number => seasonNow;

/** when the season now on started and when the next one starts (null when not known or not asked for) */
export const rankedSeasonDates = (): { startedAt: Date | null; nextAt: Date | null } => ({ startedAt: seasonStartedAt, nextAt: seasonNextAt });

/** app-wide switches set by admins; kept in memory so every room join and invite can check them for free */
export class SettingsService {
  private guests = true;
  private invites = true;
  private season = 1;

  constructor(private readonly cols: Collections) {}

  /** reads the saved settings once at startup; both switches are on until an admin turns them off */
  async load(now = new Date()): Promise<void> {
    // older documents have no start date for the season now on: it starts counting from here
    await this.cols.settings.updateOne(
      { _id: 'app' },
      [
        {
          $set: {
            rankedSeasonStartedAt: { $ifNull: ['$rankedSeasonStartedAt', now] },
            guestsAllowed: { $ifNull: ['$guestsAllowed', true] },
            updatedBy: { $ifNull: ['$updatedBy', null] },
            updatedAt: { $ifNull: ['$updatedAt', now] },
          },
        },
      ],
      { upsert: true },
    );
    const doc = await this.cols.settings.findOne({ _id: 'app' });
    this.guests = doc?.guestsAllowed ?? true;
    this.invites = doc?.pushInvites ?? true;
    this.setSeason(doc?.rankedSeason ?? 1, doc?.rankedSeasonStartedAt ?? now, doc?.nextSeasonAt ?? null);
    // the season now on has its own document, like every later one
    await this.cols.seasons.updateOne(
      { _id: this.season },
      { $setOnInsert: { startsAt: seasonStartedAt ?? now, endsAt: null, scheduledBy: null, scheduledAt: seasonStartedAt ?? now } },
      { upsert: true },
    );
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

  /** when the next season starts, once an admin asked for it */
  get nextSeasonAt(): Date | null {
    return seasonNextAt;
  }

  async view(): Promise<AppSettings> {
    const doc = await this.cols.settings.findOne({ _id: 'app' });
    const by = doc?.updatedBy ? await this.cols.users.findOne({ _id: doc.updatedBy }, { projection: { displayName: 1 } }) : null;
    return {
      guestsAllowed: doc?.guestsAllowed ?? true,
      pushInvites: doc?.pushInvites ?? true,
      // the season ranked games are rated in right now
      rankedSeason: this.season,
      rankedSeasonStartedAt: seasonStartedAt?.toISOString() ?? null,
      nextSeasonAt: seasonNextAt?.toISOString() ?? null,
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

  /** books the next season to start at `at` and saves its document; false when one is already booked */
  async scheduleNextSeason(by: ObjectId | null, at: Date, now = new Date()): Promise<boolean> {
    const doc = await this.cols.settings.findOneAndUpdate(
      { _id: 'app', $or: [{ nextSeasonAt: null }, { nextSeasonAt: { $exists: false } }] },
      { $set: { nextSeasonAt: at, updatedBy: by, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!doc) return false;
    const next = (doc.rankedSeason ?? 1) + 1;
    await this.cols.seasons.replaceOne({ _id: next }, { startsAt: at, endsAt: null, scheduledBy: by, scheduledAt: now }, { upsert: true });
    seasonNextAt = at;
    return true;
  }

  /** calls off a booked season before it starts; false when none was booked */
  async cancelNextSeason(by: ObjectId | null, now = new Date()): Promise<boolean> {
    const doc = await this.cols.settings.findOneAndUpdate(
      { _id: 'app', nextSeasonAt: { $type: 'date' } },
      { $set: { nextSeasonAt: null, updatedBy: by, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!doc) return false;
    await this.cols.seasons.deleteOne({ _id: (doc.rankedSeason ?? 1) + 1 });
    seasonNextAt = null;
    return true;
  }

  /** starts the booked season once its time has come, in one atomic write; its number, or null when nothing was due */
  async startDueSeason(now = new Date()): Promise<number | null> {
    const doc = await this.cols.settings.findOneAndUpdate(
      { _id: 'app', nextSeasonAt: { $lte: now } },
      [
        {
          $set: {
            rankedSeason: { $add: [{ $ifNull: ['$rankedSeason', 1] }, 1] },
            rankedSeasonStartedAt: '$nextSeasonAt',
            nextSeasonAt: null,
          },
        },
      ],
      { returnDocument: 'after' },
    );
    if (!doc?.rankedSeason || !doc.rankedSeasonStartedAt) return null;
    const started = doc.rankedSeasonStartedAt;
    // the old season ends as the new one starts
    await this.cols.seasons.updateOne({ _id: doc.rankedSeason - 1 }, { $set: { endsAt: started } });
    await this.cols.seasons.updateOne(
      { _id: doc.rankedSeason },
      { $setOnInsert: { startsAt: started, endsAt: null, scheduledBy: null, scheduledAt: started } },
      { upsert: true },
    );
    this.setSeason(doc.rankedSeason, started, null);
    return this.season;
  }

  /** keeps the season here and for rankedSeasonNow */
  private setSeason(season: number, startedAt: Date | null, nextAt: Date | null): void {
    this.season = season;
    seasonNow = season;
    seasonStartedAt = startedAt;
    seasonNextAt = nextAt;
  }
}
