// In-memory registry of devices to push to. Keyed by Expo push token (dedup on re-register).
// Single-operator MVP: no per-device auth beyond the shared bearer token.

export interface Device {
  expoPushToken: string;
  label?: string;
  registeredAt: string; // ISO-8601 UTC
}

export class DeviceStore {
  private readonly devices = new Map<string, Device>();
  private readonly max: number;

  // `max` caps the registry so /v1/register can't be used to exhaust heap. Map iteration is in
  // insertion order, so the first key is the oldest — evict it when full.
  constructor(opts: { max?: number } = {}) {
    this.max = opts.max ?? 50;
  }

  register(expoPushToken: string, label?: string): Device {
    const existing = this.devices.get(expoPushToken);
    const device: Device = existing ?? {
      expoPushToken,
      registeredAt: new Date().toISOString()
    };
    if (label !== undefined) device.label = label;
    if (!existing && this.devices.size >= this.max) {
      const oldest = this.devices.keys().next().value;
      if (oldest !== undefined) this.devices.delete(oldest);
    }
    this.devices.set(expoPushToken, device);
    return device;
  }

  tokens(): string[] {
    return [...this.devices.keys()];
  }
}
