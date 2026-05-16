import { describe, it, expect } from 'vitest';
import {
  getDiceRadius, getNumberSize, getFaceLabel, faceIndexToValue,
  colorLuminance, hexToLinearRgb, decideNumberStyle,
  buildFormula, totalDiceCount, adjustDiceCount, evaluateRolls,
  hasCritical, hasFumble, rollDie, rollDieByType,
} from './diceLogic.js';
import { DICE_TYPES, COLOR_THEMES } from '../data/diceConfig.js';

// 決定的テスト用の注入可能 RNG。与えた値を順番に返す。
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('faceIndexToValue', () => {
  it('standard dice: face index n -> value n+1', () => {
    expect(faceIndexToValue('d6', 0)).toBe(1);
    expect(faceIndexToValue('d6', 5)).toBe(6);
    expect(faceIndexToValue('d20', 19)).toBe(20);
  });
  it('d10: face 0 reads as 10', () => {
    expect(faceIndexToValue('d10', 0)).toBe(10);
    expect(faceIndexToValue('d10', 1)).toBe(1);
    expect(faceIndexToValue('d10', 9)).toBe(9);
  });
  it('d100: face index n -> n*10', () => {
    expect(faceIndexToValue('d100', 0)).toBe(0);
    expect(faceIndexToValue('d100', 9)).toBe(90);
  });
});

describe('getFaceLabel', () => {
  it('standard dice label is index+1', () => {
    expect(getFaceLabel('d6', 0)).toBe('1');
    expect(getFaceLabel('d20', 19)).toBe('20');
  });
  it('d10 label is the raw index', () => {
    expect(getFaceLabel('d10', 0)).toBe('0');
    expect(getFaceLabel('d10', 7)).toBe('7');
  });
  it('d100 label is index*10 zero-padded to 2 digits', () => {
    expect(getFaceLabel('d100', 0)).toBe('00');
    expect(getFaceLabel('d100', 5)).toBe('50');
    expect(getFaceLabel('d100', 9)).toBe('90');
  });
});

describe('rollDie', () => {
  it('always returns an integer within 1..faces', () => {
    for (const faces of [4, 6, 8, 10, 12, 20, 100]) {
      for (let trial = 0; trial < 500; trial++) {
        const v = rollDie(faces, Math.random);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(faces);
      }
    }
  });
  it('rng near 0 yields the minimum face, rng near 1 yields the maximum', () => {
    expect(rollDie(6, () => 0)).toBe(1);
    expect(rollDie(6, () => 0.999999)).toBe(6);
    expect(rollDie(20, () => 0.999999)).toBe(20);
  });
  it('is deterministic with a seeded rng', () => {
    const rng = seqRng([0.0, 0.5, 0.95]);
    expect(rollDie(20, rng)).toBe(1);
    expect(rollDie(20, rng)).toBe(11);
    expect(rollDie(20, rng)).toBe(20);
  });
});

describe('rollDieByType', () => {
  it('every die type stays inside its valid value range', () => {
    for (const type of DICE_TYPES) {
      for (let trial = 0; trial < 300; trial++) {
        const v = rollDieByType(type.id, Math.random);
        if (type.id === 'd100') {
          expect(v % 10).toBe(0);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(90);
        } else if (type.id === 'd10') {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(10);
        } else {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(type.faces);
        }
      }
    }
  });
  it('d10 with rng 0 reads as 10 (face index 0 convention)', () => {
    expect(rollDieByType('d10', () => 0)).toBe(10);
  });
  it('throws on an unknown dice type', () => {
    expect(() => rollDieByType('d7', Math.random)).toThrow();
  });
});

describe('evaluateRolls', () => {
  const rolls = [
    { type: 'd20', value: 14, label: 'D20' },
    { type: 'd6', value: 3, label: 'D6' },
  ];
  it('sums dice values', () => {
    expect(evaluateRolls(rolls)).toBe(17);
  });
  it('adds a positive modifier', () => {
    expect(evaluateRolls(rolls, 5)).toBe(22);
  });
  it('adds a negative modifier', () => {
    expect(evaluateRolls(rolls, -4)).toBe(13);
  });
  it('empty roll list with no modifier is 0', () => {
    expect(evaluateRolls([])).toBe(0);
  });
  it('empty roll list returns just the modifier', () => {
    expect(evaluateRolls([], 7)).toBe(7);
  });
});

describe('critical / fumble detection', () => {
  it('detects a critical on a d20 value of 20', () => {
    expect(hasCritical([{ type: 'd20', value: 20 }])).toBe(true);
  });
  it('does not flag a critical for d20 below 20', () => {
    expect(hasCritical([{ type: 'd20', value: 19 }])).toBe(false);
  });
  it('a value of 20 on a non-d20 die is not a critical', () => {
    expect(hasCritical([{ type: 'd100', value: 20 }])).toBe(false);
  });
  it('detects a fumble on a d20 value of 1', () => {
    expect(hasFumble([{ type: 'd20', value: 1 }])).toBe(true);
  });
  it('a value of 1 on a non-d20 die is not a fumble', () => {
    expect(hasFumble([{ type: 'd6', value: 1 }])).toBe(false);
  });
  it('finds a critical among a mixed roll set', () => {
    const rolls = [
      { type: 'd6', value: 4 },
      { type: 'd20', value: 20 },
      { type: 'd8', value: 1 },
    ];
    expect(hasCritical(rolls)).toBe(true);
    expect(hasFumble(rolls)).toBe(false);
  });
});

describe('buildFormula', () => {
  const empty = { d4: 0, d6: 0, d8: 0, d10: 0, d100: 0, d12: 0, d20: 0 };
  it('renders an em-dash when nothing is selected', () => {
    expect(buildFormula(empty, 0)).toBe('—');
  });
  it('renders a single die count', () => {
    expect(buildFormula({ ...empty, d20: 1 }, 0)).toBe('1d20');
  });
  it('joins multiple dice in DICE_TYPES order', () => {
    expect(buildFormula({ ...empty, d6: 2, d20: 1 }, 0)).toBe('2d6 + 1d20');
  });
  it('appends a positive modifier with a plus sign', () => {
    expect(buildFormula({ ...empty, d20: 1 }, 3)).toBe('1d20 +3');
  });
  it('appends a negative modifier', () => {
    expect(buildFormula({ ...empty, d20: 1 }, -2)).toBe('1d20 -2');
  });
  it('shows the modifier even with no dice selected', () => {
    expect(buildFormula(empty, 4)).toBe('— +4');
  });
  it('uses the D% label for d100', () => {
    expect(buildFormula({ ...empty, d100: 1 }, 0)).toBe('1d%');
  });
});

describe('totalDiceCount', () => {
  it('sums all dice counts', () => {
    expect(totalDiceCount({ d4: 1, d6: 2, d20: 3 })).toBe(6);
  });
  it('is 0 for an all-zero selection', () => {
    expect(totalDiceCount({ d4: 0, d6: 0 })).toBe(0);
  });
});

describe('adjustDiceCount', () => {
  const base = { d4: 0, d6: 0, d8: 0, d10: 0, d100: 0, d12: 0, d20: 0 };

  it('increments and decrements the chosen die type', () => {
    expect(adjustDiceCount(base, 'd6', 1)).toMatchObject({ d6: 1 });
    expect(adjustDiceCount({ ...base, d6: 3 }, 'd6', -1)).toMatchObject({ d6: 2 });
  });
  it('never goes below zero', () => {
    expect(adjustDiceCount(base, 'd6', -1)).toMatchObject({ d6: 0 });
  });
  it('clamps to maxPerType', () => {
    const r = adjustDiceCount({ ...base, d6: 5 }, 'd6', 1, { maxPerType: 5 });
    expect(r.d6).toBe(5);
  });
  it('blocks an increase that would exceed maxTotal', () => {
    const counts = { ...base, d4: 6, d20: 4 }; // total 10
    const r = adjustDiceCount(counts, 'd6', 1, { maxTotal: 10 });
    expect(r.d6).toBe(0);
    expect(totalDiceCount(r)).toBe(10);
  });
  it('allows an increase up to exactly maxTotal', () => {
    const counts = { ...base, d4: 9 }; // total 9
    const r = adjustDiceCount(counts, 'd6', 1, { maxTotal: 10 });
    expect(r.d6).toBe(1);
    expect(totalDiceCount(r)).toBe(10);
  });
  it('still permits decreases when already at the total cap', () => {
    const counts = { ...base, d6: 10 }; // total 10, at cap
    const r = adjustDiceCount(counts, 'd6', -1, { maxTotal: 10 });
    expect(r.d6).toBe(9);
  });
  it('does not mutate the input object', () => {
    const counts = { ...base, d6: 2 };
    adjustDiceCount(counts, 'd6', 1);
    expect(counts.d6).toBe(2);
  });
});

describe('getDiceRadius / getNumberSize', () => {
  it('returns a positive radius for every known die type', () => {
    for (const type of DICE_TYPES) {
      expect(getDiceRadius(type.id)).toBeGreaterThan(0);
      expect(getNumberSize(type.id)).toBeGreaterThan(0);
    }
  });
  it('falls back to defaults for an unknown id', () => {
    expect(getDiceRadius('d7')).toBe(1.0);
    expect(getNumberSize('d7')).toBe(0.5);
  });
});

describe('colorLuminance', () => {
  it('pure white is brighter than pure black', () => {
    expect(colorLuminance('#ffffff')).toBeGreaterThan(colorLuminance('#000000'));
  });
  it('white luminance is ~1 and black is 0', () => {
    expect(colorLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(colorLuminance('#000000')).toBeCloseTo(0, 5);
  });
  it('accepts hex with or without a leading #', () => {
    expect(colorLuminance('ffffff')).toBeCloseTo(colorLuminance('#ffffff'), 10);
  });
  it('hexToLinearRgb returns channels in 0..1', () => {
    const c = hexToLinearRgb('#8040c0');
    for (const ch of [c.r, c.g, c.b]) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(1);
    }
  });
});

describe('decideNumberStyle', () => {
  it('always returns the theme ink color', () => {
    const style = decideNumberStyle('metal', COLOR_THEMES.nebula, { r: 0.1, g: 0.1, b: 0.3 });
    expect(style.ink).toBe(COLOR_THEMES.nebula.ink);
  });
  it('frost (acrylic) sets bolder', () => {
    const style = decideNumberStyle('acrylic', COLOR_THEMES.ocean, { r: 0.1, g: 0.3, b: 0.6 });
    expect(style.bolder).toBe(true);
  });
  it('wood always gets an outline', () => {
    const style = decideNumberStyle('wood', COLOR_THEMES.flame, { r: 0.4, g: 0.1, b: 0.0 });
    expect(style.outlineColor).not.toBeNull();
    expect(style.outlineWidth).toBeGreaterThan(0);
  });
  it('low ink/background contrast forces an outline at width >= 5', () => {
    // ink and background nearly identical -> contrast < 0.30 branch
    const lowContrastTheme = { ink: '#202020' };
    const style = decideNumberStyle('metal', lowContrastTheme, hexToLinearRgb('#222222'));
    expect(style.outlineColor).not.toBeNull();
    expect(style.outlineWidth).toBeGreaterThanOrEqual(5);
  });
});
