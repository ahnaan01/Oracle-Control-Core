/** Pairing is an explicit one-time operator action, never a reconnect strategy. */
export class PairingGate {
  private requested = false;
  mayOpen(registered: boolean, phone?: string) { return registered || (!this.requested && !!phone && /^\d{8,15}$/.test(phone)); }
  async request(registered: boolean, phone: string | undefined, pair: (phone: string) => Promise<string>) {
    if (registered || !this.mayOpen(false, phone)) return null;
    this.requested = true; // Mark before awaiting; duplicate readiness events cannot pair twice.
    return pair(phone!);
  }
}
