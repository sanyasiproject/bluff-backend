/** which accounts have the app open right now (any connected socket); in memory, one server */
export class Presence {
  private sockets = new Map<string, Set<string>>();

  add(userId: string, socketId: string): void {
    const set = this.sockets.get(userId) ?? new Set<string>();
    set.add(socketId);
    this.sockets.set(userId, set);
  }

  remove(userId: string, socketId: string): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) this.sockets.delete(userId);
  }

  isOnline(userId: string): boolean {
    return this.sockets.has(userId);
  }

  socketsOf(userId: string): string[] {
    return [...(this.sockets.get(userId) ?? [])];
  }
}
