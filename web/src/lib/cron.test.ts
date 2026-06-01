import { describe, it, expect } from 'vitest';
import { parseSchedule, buildSchedule, describeCron, type SchedModel } from './cron';

// cron.ts drives the visual schedule picker for scheduled tasks. A wrong
// description makes the user schedule the wrong thing; a non-round-tripping
// parse/build silently corrupts a schedule. These are pure functions, so we
// pin the exact contract here. Cases were derived by tracing the source, not
// assumed.

describe('describeCron', () => {
  it('rejects an expression that is not 5 fields', () => {
    expect(describeCron('0 9 * *')).toEqual({
      ok: false,
      text: 'Cron must be 5 fields: minute hour day-of-month month day-of-week',
    });
  });

  it('describes a simple daily time on the hour', () => {
    expect(describeCron('0 9 * * *')).toEqual({ ok: true, text: 'Every day at 9 AM' });
  });

  it('includes minutes when not on the hour', () => {
    expect(describeCron('30 7 * * *')).toEqual({ ok: true, text: 'Every day at 7:30 AM' });
  });

  it('renders afternoon times in 12-hour PM form', () => {
    expect(describeCron('15 14 * * *')).toEqual({ ok: true, text: 'Every day at 2:15 PM' });
  });

  it('renders midnight as 12 AM and noon as 12 PM', () => {
    expect(describeCron('0 0 * * *')).toEqual({ ok: true, text: 'Every day at 12 AM' });
    expect(describeCron('0 12 * * *')).toEqual({ ok: true, text: 'Every day at 12 PM' });
  });

  it('describes weekday and weekend ranges', () => {
    expect(describeCron('0 9 * * 1-5')).toEqual({ ok: true, text: 'At 9 AM on weekdays' });
    expect(describeCron('0 9 * * 0,6')).toEqual({ ok: true, text: 'At 9 AM on weekends' });
  });

  it('describes a single weekday by name (pluralized)', () => {
    expect(describeCron('0 9 * * 1')).toEqual({ ok: true, text: 'At 9 AM on Mondays' });
  });

  it('describes a custom set of weekdays with an Oxford-comma list', () => {
    expect(describeCron('0 9 * * 1,3,5')).toEqual({
      ok: true,
      text: 'At 9 AM on Mon, Wed, and Fri',
    });
  });

  it('describes "every N minutes" step syntax', () => {
    expect(describeCron('*/15 * * * *')).toEqual({ ok: true, text: 'Every 15 minutes' });
    expect(describeCron('*/1 * * * *')).toEqual({ ok: true, text: 'Every minute' });
    expect(describeCron('* * * * *')).toEqual({ ok: true, text: 'Every minute' });
  });

  it('describes "every N hours" with and without an offset minute', () => {
    expect(describeCron('0 */2 * * *')).toEqual({ ok: true, text: 'Every 2 hours' });
    expect(describeCron('30 */2 * * *')).toEqual({ ok: true, text: 'Every 2 hours at :30' });
    expect(describeCron('0 */1 * * *')).toEqual({ ok: true, text: 'Every hour' });
  });

  it('lists multiple fixed times that share an hour', () => {
    expect(describeCron('0,30 9 * * *')).toEqual({
      ok: true,
      text: 'Every day at 9 AM and 9:30 AM',
    });
  });

  it('describes a day-of-month restriction', () => {
    expect(describeCron('0 9 1 * *')).toEqual({
      ok: true,
      text: 'At 9 AM on day 1 of the month',
    });
  });

  it('describes a month restriction', () => {
    expect(describeCron('0 9 * 1 *')).toEqual({ ok: true, text: 'At 9 AM in Jan' });
  });

  it('falls back to the raw cron for noisy multi-minute multi-hour grids', () => {
    // Two minutes x two hours is the cross-product cron actually fires; the
    // describer refuses to summarize it and echoes the raw expression so it
    // never lies about behavior.
    expect(describeCron('0,30 9,17 * * *')).toEqual({ ok: true, text: '0,30 9,17 * * *' });
  });

  it('rejects unsupported field syntax', () => {
    expect(describeCron('0 9 ? * *')).toEqual({
      ok: false,
      text: 'Unsupported cron syntax — try a simpler form like "0 9 * * *"',
    });
  });
});

describe('parseSchedule', () => {
  it('parses a daily fixed time', () => {
    expect(parseSchedule('0 9 * * *')).toEqual({
      times: [{ h: 9, m: 0 }],
      days: { kind: 'every' },
    });
  });

  it('maps the weekday and weekend dow shortcuts', () => {
    expect(parseSchedule('30 7 * * 1-5')).toEqual({
      times: [{ h: 7, m: 30 }],
      days: { kind: 'weekdays' },
    });
    expect(parseSchedule('0 9 * * 0,6')?.days).toEqual({ kind: 'weekends' });
    expect(parseSchedule('0 9 * * 6,0')?.days).toEqual({ kind: 'weekends' });
  });

  it('normalizes dow=7 to Sunday and a full week to "every"', () => {
    expect(parseSchedule('0 9 * * 7')?.days).toEqual({ kind: 'custom', dows: [0] });
    expect(parseSchedule('0 9 * * 0-6')?.days).toEqual({ kind: 'every' });
  });

  it('keeps an arbitrary dow set as custom', () => {
    expect(parseSchedule('0 9 * * 1,3,5')?.days).toEqual({ kind: 'custom', dows: [1, 3, 5] });
  });

  it('expands a multi-minute field into one time per minute', () => {
    expect(parseSchedule('0,30 9 * * *')?.times).toEqual([
      { h: 9, m: 0 },
      { h: 9, m: 30 },
    ]);
  });

  it('returns null for syntax the picker cannot represent', () => {
    expect(parseSchedule('0 9 * *')).toBeNull(); // wrong field count
    expect(parseSchedule('0 9 1 * *')).toBeNull(); // day-of-month set
    expect(parseSchedule('0 9 * 6 *')).toBeNull(); // month set
    expect(parseSchedule('* 9 * * *')).toBeNull(); // every-minute (not a fixed time)
    expect(parseSchedule('*/15 * * * *')).toBeNull(); // step minutes
  });
});

describe('buildSchedule', () => {
  it('round-trips the common shapes back to cron', () => {
    expect(buildSchedule({ times: [{ h: 9, m: 0 }], days: { kind: 'every' } })).toEqual({
      cron: '0 9 * * *',
      warning: undefined,
    });
    expect(buildSchedule({ times: [{ h: 7, m: 30 }], days: { kind: 'weekdays' } }).cron).toBe(
      '30 7 * * 1-5',
    );
    expect(buildSchedule({ times: [{ h: 9, m: 0 }], days: { kind: 'weekends' } }).cron).toBe(
      '0 9 * * 0,6',
    );
    expect(
      buildSchedule({ times: [{ h: 9, m: 0 }], days: { kind: 'custom', dows: [1, 3, 5] } }).cron,
    ).toBe('0 9 * * 1,3,5');
  });

  it('dedups and sorts times', () => {
    const out = buildSchedule({
      times: [
        { h: 9, m: 30 },
        { h: 9, m: 0 },
        { h: 9, m: 30 },
      ],
      days: { kind: 'every' },
    });
    expect(out.cron).toBe('0,30 9 * * *');
  });

  it('defaults to 9am with a warning when no times are given', () => {
    expect(buildSchedule({ times: [], days: { kind: 'every' } })).toEqual({
      cron: '0 9 * * *',
      warning: 'No times selected',
    });
  });

  it('warns about the cron cross-product when minutes and hours both vary', () => {
    const out = buildSchedule({
      times: [
        { h: 9, m: 0 },
        { h: 17, m: 30 },
      ],
      days: { kind: 'every' },
    });
    expect(out.cron).toBe('0,30 9,17 * * *');
    expect(out.warning).toContain('2 extra combinations');
  });

  it('defaults empty custom days to every day with a warning', () => {
    const out = buildSchedule({ times: [{ h: 9, m: 0 }], days: { kind: 'custom', dows: [] } });
    expect(out.cron).toBe('0 9 * * *');
    expect(out.warning).toContain('No days selected');
  });
});

describe('parse/build round-trip', () => {
  // For every picker-representable expression, parse then build must return
  // an equivalent cron (the picker must never silently rewrite a schedule).
  const cases = ['0 9 * * *', '30 7 * * 1-5', '0 9 * * 0,6', '0 9 * * 1,3,5', '0,30 9 * * *'];
  for (const cron of cases) {
    it(`round-trips ${cron}`, () => {
      const model = parseSchedule(cron) as SchedModel;
      expect(model).not.toBeNull();
      expect(buildSchedule(model).cron).toBe(cron);
    });
  }
});
