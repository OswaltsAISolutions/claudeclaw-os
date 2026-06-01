import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/preact';

// Unmount any rendered tree between tests so the jsdom document starts clean.
afterEach(() => {
  cleanup();
});
