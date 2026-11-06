import {describe,it,expect} from 'vitest';
import {openTimestamp} from '../server/open-activity.js';
describe('open timestamps',()=>{
  it('serializes UTC database values with an explicit zone and preserves milliseconds',()=>{
    expect(openTimestamp('2026-11-06 18:12:43.123')).toBe('2026-11-06T18:12:43.123Z');
    expect(openTimestamp(new Date('2026-11-06T18:12:43.123Z'))).toBe('2026-11-06T18:12:43.123Z');
    expect(openTimestamp('2026-11-06T23:12:43.123+05:00')).toBe('2026-11-06T18:12:43.123Z');
    expect(openTimestamp(null)).toBeNull();expect(openTimestamp('invalid')).toBeNull();
  });
});
