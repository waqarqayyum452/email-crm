import { describe, expect, it } from 'vitest';
import { defaultSettings, settingsSchema } from '../server/settings.js';

describe('mailbox sync settings',()=>{
  it('accepts minute-level polling and rejects polling more than once a minute',()=>{
    expect(defaultSettings.poll_interval_seconds).toBe(60);
    expect(settingsSchema.parse({...defaultSettings,poll_interval_seconds:60}).poll_interval_seconds).toBe(60);
    expect(settingsSchema.safeParse({...defaultSettings,poll_interval_seconds:59}).success).toBe(false);
  });

  it('keeps the freshness limit at least as long as the configured polling interval',()=>{
    expect(settingsSchema.safeParse({...defaultSettings,poll_interval_seconds:1200,sync_stale_seconds:900}).success).toBe(false);
    expect(settingsSchema.safeParse({...defaultSettings,poll_interval_seconds:1200,sync_stale_seconds:1200}).success).toBe(true);
  });
});
