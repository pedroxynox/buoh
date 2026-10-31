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
    expect(parseHealthArgs(['--json'])).toEqual({ log: null, symbol: 'R_100' });
    expect(parseHealthArgs(['--', '--json'])).toEqual({ log: null, symbol: 'R_100' });
    expect(parseHealthArgs(['--json', '--symbol', '1HZ100V'])).toEqual({
      log: null,
      symbol: '1HZ100V',
    });
    expect(parseHealthArgs(['--symbol', 'R_50', '--json'])).toEqual({ log: null, symbol: 'R_50' });
  });

  it('--log da el número de un log de producción, de 1 a 999 999 (ADR-0018 §6 y §11)', () => {
    expect(parseHealthArgs(['--json', '--log', '1'])).toEqual({ log: 1, symbol: 'R_100' });
    expect(parseHealthArgs(['--', '--json', '--log', '999999', '--symbol', 'R_50'])).toEqual({
      log: 999_999,
      symbol: 'R_50',
    });
  });

  it('un número de log que no es un entero de 1 a 999 999 sin ceros delante es un error de uso, con el uso', () => {
    for (const value of ['0', '-1', '1000000', '01', '1.5', 'abc', '', ' 1']) {
      expect(() => parseHealthArgs(['--json', '--log', value])).toThrow(UsageError);
      expect(() => parseHealthArgs(['--json', '--log', value])).toThrow(HEALTH_USAGE);
    }
    expect(() => parseHealthArgs(['--json', '--log'])).toThrow(UsageError);
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
