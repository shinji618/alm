import { applyPalette, getPalettePref } from '@/lib/theme';

describe('palette', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-palette');
  });

  it('defaults to blue (PAS brand) and sets data-palette', () => {
    expect(getPalettePref()).toBe('blue');
    applyPalette(getPalettePref());
    expect(document.documentElement.getAttribute('data-palette')).toBe('blue');
    expect(localStorage.getItem('alm.palette')).toBeNull();
  });

  it('green leaves data-palette unset and persists; blue clears the stored choice', () => {
    applyPalette('green');
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
    expect(getPalettePref()).toBe('green');
    applyPalette('blue');
    expect(document.documentElement.getAttribute('data-palette')).toBe('blue');
    expect(getPalettePref()).toBe('blue');
  });

  it('black sets data-palette and persists; unknown stored values fall back to blue', () => {
    applyPalette('black');
    expect(document.documentElement.getAttribute('data-palette')).toBe('black');
    expect(getPalettePref()).toBe('black');
    localStorage.setItem('alm.palette', 'nonsense');
    expect(getPalettePref()).toBe('blue');
  });
});
