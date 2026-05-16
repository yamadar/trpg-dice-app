import { describe, it, expect } from 'vitest';
import {
  DICE_TYPES, BOARD_THEMES, MATERIALS, COLOR_THEMES, SOUND_PRESETS,
  MAX_TOTAL_DICE, MAX_DICE_PER_TYPE,
} from './diceConfig.js';

describe('DICE_TYPES', () => {
  it('contains the 7 standard TRPG dice', () => {
    expect(DICE_TYPES).toHaveLength(7);
    const ids = DICE_TYPES.map(d => d.id);
    expect(ids).toEqual(['d4', 'd6', 'd8', 'd10', 'd100', 'd12', 'd20']);
  });
  it('each die declares a face count matching its id', () => {
    for (const d of DICE_TYPES) {
      const expectedFaces = d.id === 'd100' ? 100 : Number(d.id.slice(1));
      expect(d.faces).toBe(expectedFaces);
    }
  });
  it('every die has a non-empty label', () => {
    for (const d of DICE_TYPES) {
      expect(typeof d.label).toBe('string');
      expect(d.label.length).toBeGreaterThan(0);
    }
  });
});

describe('color / board / material themes', () => {
  it('every color theme defines primary, secondary, emissive and ink hex colors', () => {
    const hex = /^#[0-9a-fA-F]{6}$/;
    for (const theme of Object.values(COLOR_THEMES)) {
      for (const key of ['primary', 'secondary', 'emissive', 'ink']) {
        expect(theme[key]).toMatch(hex);
      }
    }
  });
  it('every board theme references a sound preset that exists', () => {
    for (const board of Object.values(BOARD_THEMES)) {
      expect(SOUND_PRESETS[board.sound]).toBeDefined();
    }
  });
  it('every material references a sound preset that exists', () => {
    for (const m of Object.values(MATERIALS)) {
      expect(SOUND_PRESETS[m.sound]).toBeDefined();
    }
  });
  it('material opacity is within 0..1', () => {
    for (const m of Object.values(MATERIALS)) {
      expect(m.opacity).toBeGreaterThan(0);
      expect(m.opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe('dice count limits', () => {
  it('defines positive integer caps', () => {
    expect(Number.isInteger(MAX_TOTAL_DICE)).toBe(true);
    expect(MAX_TOTAL_DICE).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_DICE_PER_TYPE)).toBe(true);
    expect(MAX_DICE_PER_TYPE).toBeGreaterThan(0);
  });
  it('per-type cap does not exceed the total cap', () => {
    expect(MAX_DICE_PER_TYPE).toBeLessThanOrEqual(MAX_TOTAL_DICE);
  });
});

describe('SOUND_PRESETS', () => {
  it('every preset has at least one resonant mode with positive freq/decay/amp', () => {
    for (const preset of Object.values(SOUND_PRESETS)) {
      expect(preset.modes.length).toBeGreaterThan(0);
      for (const mode of preset.modes) {
        expect(mode.freq).toBeGreaterThan(0);
        expect(mode.decay).toBeGreaterThan(0);
        expect(mode.amp).toBeGreaterThan(0);
      }
    }
  });
});
