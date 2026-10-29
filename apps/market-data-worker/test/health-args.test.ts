import { describe, expect, it } from 'vitest';

import { HEALTH_USAGE, parseHealthArgs, UsageError } from '../src/index.js';

// Los argumentos de `data:health` (ADR-0015 §8), sin red ni servicios: se comprueban antes de leer
// la configuración o abrir ningún almacén.

describe('parseHealthArgs', () => {
  it('exige --json, el único formato de salida, y sin él es un error de uso que lo pide y da el uso', () => {
    for (const args of [[], ['--symbol', 'R_100'], ['--']]) {
      expect(() => parseHealthArgs(args)).toThrow(UsageError);
      expect(() => parseHealthArgs(args)).toThrow(/--json/u);
      expect(() => parseHealthArgs(args)).toThrow(HEALTH_USAGE);
    }
  });

  it('usa R_100 por defecto, tolera el separador -- que reenvía pnpm y admite otro símbolo', () => {
    expect(parseHealthArgs(['--json'])).toEqual({ symbol: 'R_100' });
    expect(parseHealthArgs(['--', '--json'])).toEqual({ symbol: 'R_100' });
    expect(parseHealthArgs(['--json', '--symbol', '1HZ100V'])).toEqual({ symbol: '1HZ100V' });
    expect(parseHealthArgs(['--symbol', 'R_50', '--json'])).toEqual({ symbol: 'R_50' });
  });

  it('el símbolo sigue la regla del smoke: rechaza lo que nunca es un código', () => {
    for (const symbol of ['', 'R 100', 'R-100', 'R_100;', 'x'.repeat(65)]) {
      expect(() => parseHealthArgs(['--json', '--symbol', symbol])).toThrow(UsageError);
      expect(() => parseHealthArgs(['--json', '--symbol', symbol])).toThrow(/--symbol/u);
    }
  });

  it('rechaza opciones desconocidas, un --json con valor, un --symbol sin valor y los argumentos sueltos, siempre con el uso', () => {
    for (const args of [
      ['--json', '--live'],
      ['--json', '--verbose'],
      ['--json=false'],
      ['--json', '--symbol'],
      ['--json', 'R_100'],
    ]) {
      expect(() => parseHealthArgs(args)).toThrow(UsageError);
      expect(() => parseHealthArgs(args)).toThrow(HEALTH_USAGE);
    }
  });
});
