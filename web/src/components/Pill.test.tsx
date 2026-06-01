import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { Pill } from './Pill';

describe('Pill', () => {
  it('renders its children', () => {
    render(<Pill tone="running">running</Pill>);
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('applies the palette class for a known tone', () => {
    render(<Pill tone="done">done</Pill>);
    expect(screen.getByText('done').className).toContain('var(--color-status-done)');
  });

  it('defaults to the neutral tone when none is given', () => {
    render(<Pill>plain</Pill>);
    expect(screen.getByText('plain').className).toContain('var(--color-text-muted)');
  });
});
