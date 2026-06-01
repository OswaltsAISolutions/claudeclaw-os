import { describe, it, expect } from 'vitest';
import { decideOAuthAlert } from './oauth-health.js';

const HOUR = 60 * 60 * 1000;
const THRESHOLD = 2 * HOUR; // the default OAUTH_ALERT_HOURS window

describe('decideOAuthAlert', () => {
  it('flags expired when no time remains', () => {
    expect(decideOAuthAlert(0, THRESHOLD, 'none')).toEqual({ level: 'expired', shouldAlert: true });
    expect(decideOAuthAlert(-5 * HOUR, THRESHOLD, 'none')).toEqual({ level: 'expired', shouldAlert: true });
  });

  it('flags warning at or under the threshold', () => {
    expect(decideOAuthAlert(HOUR, THRESHOLD, 'none')).toEqual({ level: 'warning', shouldAlert: true });
  });

  it('is healthy above the threshold and never alerts the user', () => {
    expect(decideOAuthAlert(THRESHOLD + 1, THRESHOLD, 'none')).toEqual({ level: 'none', shouldAlert: false });
    // Even recovering from a prior warning, healthy itself raises no alert.
    expect(decideOAuthAlert(10 * HOUR, THRESHOLD, 'warning')).toEqual({ level: 'none', shouldAlert: false });
  });

  it('dedups: does not re-alert at a level already announced', () => {
    expect(decideOAuthAlert(-1, THRESHOLD, 'expired').shouldAlert).toBe(false);
    expect(decideOAuthAlert(HOUR, THRESHOLD, 'warning').shouldAlert).toBe(false);
  });

  it('alerts when degrading from healthy into warning or expired', () => {
    expect(decideOAuthAlert(HOUR, THRESHOLD, 'none').shouldAlert).toBe(true);
    expect(decideOAuthAlert(0, THRESHOLD, 'none').shouldAlert).toBe(true);
  });

  it('re-alerts when escalating from warning to expired', () => {
    expect(decideOAuthAlert(-1, THRESHOLD, 'warning')).toEqual({ level: 'expired', shouldAlert: true });
  });

  it('alerts on a warning that follows a prior expired level', () => {
    expect(decideOAuthAlert(HOUR, THRESHOLD, 'expired')).toEqual({ level: 'warning', shouldAlert: true });
  });

  it('treats the exact threshold boundary as warning, not healthy', () => {
    expect(decideOAuthAlert(THRESHOLD, THRESHOLD, 'none').level).toBe('warning');
  });

  it('treats exactly zero remaining as expired, not warning', () => {
    expect(decideOAuthAlert(0, THRESHOLD, 'none').level).toBe('expired');
  });
});
