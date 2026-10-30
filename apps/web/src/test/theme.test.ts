import { applyPalette, getPalettePref } from '@/lib/theme';

describe('palette', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-palette');
  });

  it('defaults to green and leaves data-palette unset', () => {
    expect(getPalettePref()).toBe('green');
    applyPalette('green');
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
  });

  it('blue sets data-palette and persists; green clears both', () => {
    applyPalette('blue');
    expect(document.documentElement.getAttribute('data-palette')).toBe('blue');
    expect(getPalettePref()).toBe('blue');
    applyPalette('green');
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
    expect(getPalettePref()).toBe('green');
  });
});
