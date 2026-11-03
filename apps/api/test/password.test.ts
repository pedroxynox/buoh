import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadCommonPasswords } from '../src/auth/common-passwords.js';
import {
  argon2idTag,
  createPasswordHasher,
  DUMMY_PASSWORD_HASH,
  PasswordHasherBusyError,
  type Argon2Function,
} from '../src/auth/password-hash.js';
import { checkPassword } from '../src/auth/password-policy.js';
import { useDeterminismGuards } from './support.js';

// La contraseña de buoh (ADR-0019 §1 y §13): de 15 a 128 caracteres después de NFC, la lista de
// bloqueo, las palabras del contexto y su guardado con Argon2id de node:crypto.
useDeterminismGuards();

const COMMON = loadCommonPasswords();
const check = (password: string, username = 'pedro_perez') =>
  checkPassword(password, { username, commonPasswords: COMMON });

/** 15 caracteres que no están en la lista ni tienen palabras del contexto. */
const FIFTEEN = 'tucán azul, río';

describe('checkPassword: longitud', () => {
  it('admite de 15 a 128 caracteres y rechaza 14 o menos y 129 o más', () => {
    expect(Array.from(FIFTEEN)).toHaveLength(15);
    expect(check(FIFTEEN)).toEqual({ ok: true, normalized: FIFTEEN });
    expect(check(FIFTEEN.slice(0, 14))).toEqual({ ok: false, reason: 'too_short' });
    expect(check('')).toEqual({ ok: false, reason: 'too_short' });
    const long = `${FIFTEEN} ${'ñ'.repeat(112)}`;
    expect(Array.from(long)).toHaveLength(128);
    expect(check(long)).toEqual({ ok: true, normalized: long });
    expect(check(`${long}ñ`)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('cuenta los caracteres después de normalizar a NFC, uno por punto de código', () => {
    // «río» con la tilde aparte son 4 puntos de código, y en NFC, 3.
    const decomposed = 'tucán azul, ri\u0301o';
    expect(Array.from(decomposed)).toHaveLength(16);
    expect(check(decomposed)).toEqual({ ok: true, normalized: FIFTEEN });
    expect(check(`tucán azul, ri\u0301`)).toEqual({ ok: false, reason: 'too_short' });
    // Un emoji fuera del plano básico es un carácter, aunque sean dos unidades de UTF-16.
    expect(check('🦉'.repeat(15))).toEqual({ ok: true, normalized: '🦉'.repeat(15) });
    expect(check('🦉'.repeat(14))).toEqual({ ok: false, reason: 'too_short' });
    const decomposedLong = 'e\u0301'.repeat(128);
    expect(check(decomposedLong)).toEqual({ ok: true, normalized: 'é'.repeat(128) });
  });
});

describe('checkPassword: lista de bloqueo', () => {
  it('rechaza una contraseña común de 15 caracteres o más, sin distinguir mayúsculas', () => {
    for (const password of ['1qaz2wsx3edc4rfv', '123456789987654321', '1QAZ2WSX3EDC4RFV']) {
      expect(check(password), password).toEqual({ ok: false, reason: 'common_password' });
    }
  });

  it('la longitud se mira antes que la lista', () => {
    expect(check('1qaz2wsx3edc4r')).toEqual({ ok: false, reason: 'too_short' });
  });
});

describe('checkPassword: palabras del contexto', () => {
  // Como NIST SP 800-63B-4 §3.1.1.2, con la lista: se compara la contraseña entera, nunca las
  // palabras que contiene.
  const LONG = 'pedro_perez_lopez';

  it('rechaza la contraseña que es, entera, el nombre de usuario o una de sus variantes', () => {
    for (const password of [
      'pedro_perez_lopez',
      'PEDRO_PEREZ_LOPEZ',
      'pedroperezlopez',
      'Pedro Perez Lopez',
      'pedro-perez-lopez',
    ]) {
      expect(check(password, LONG), password).toEqual({ ok: false, reason: 'context_words' });
    }
    // Una parte del nombre de 15 caracteres o más también es una variante.
    expect(check('perezgonzalezlopez', 'perezgonzalezlopez_2')).toEqual({
      ok: false,
      reason: 'context_words',
    });
  });

  it('no rechaza una contraseña solo porque contenga esas palabras', () => {
    for (const [password, username] of [
      ['buohbuohbuohbuoh1', 'pedro_perez'],
      ['DerivDerivDeriv2026', 'pedro_perez'],
      ['pedro_perez-pedro_perez', 'pedro_perez'],
      ['pedro_perez_lopez 2026', LONG],
      ['mi contraseña de buoh es larga', 'pedro_perez'],
      ['I trade derivatives on weekends', 'pedro_perez'],
    ] as const) {
      expect(check(password, username), password).toEqual({ ok: true, normalized: password });
    }
  });

  it('las variantes salen del nombre de cada cuenta', () => {
    expect(check('anaanaanaanaanaana', 'anaanaanaanaanaana')).toEqual({
      ok: false,
      reason: 'context_words',
    });
    expect(check('anaanaanaanaanaana', 'pedro_perez')).toEqual({
      ok: true,
      normalized: 'anaanaanaanaanaana',
    });
  });
});

describe('loadCommonPasswords', () => {
  it('no arranca con una lista dañada: una línea que no está en NFC y minúsculas, corta, larga o sin el salto final', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buoh-lista-'));
    try {
      for (const [name, content] of [
        ['mayusculas', '1qaz2wsx3edc4rfv\nPASSWORDPASSWORD1\n'],
        ['nfd', `${'e\u0301'.repeat(15)}\n`],
        ['corta', '1qaz2wsx3edc4r\n'],
        ['larga', `${'x'.repeat(129)}\n`],
        ['vacia', '1qaz2wsx3edc4rfv\n\n'],
        ['sin-salto', '1qaz2wsx3edc4rfv'],
      ] as const) {
        const file = join(directory, name);
        await writeFile(file, content, 'utf8');
        expect(() => loadCommonPasswords(pathToFileURL(file)), name).toThrow(TypeError);
      }
      const good = join(directory, 'buena');
      await writeFile(good, '1qaz2wsx3edc4rfv\nqazwsxedcrfvtgb\n', 'utf8');
      expect([...loadCommonPasswords(pathToFileURL(good))]).toEqual([
        '1qaz2wsx3edc4rfv',
        'qazwsxedcrfvtgb',
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('lista de bloqueo (apps/api/data/contrasenas-comunes.txt)', () => {
  const lines = readFileSync(new URL('../data/contrasenas-comunes.txt', import.meta.url), 'utf8')
    .split('\n')
    .slice(0, -1);

  it('son las 10 898 contraseñas de 15 a 128 caracteres de la lista de origen, en NFC y minúsculas, únicas y ordenadas', () => {
    expect(lines).toHaveLength(10_898);
    for (const line of lines) {
      expect(line.normalize('NFC').toLowerCase()).toBe(line);
      expect(Array.from(line).length).toBeGreaterThanOrEqual(15);
      expect(Array.from(line).length).toBeLessThanOrEqual(128);
    }
    expect(lines.every((line, index) => index === 0 || (lines[index - 1] ?? '') < line)).toBe(true);
    expect(COMMON.size).toBe(10_898);
  });
});

describe('argon2idTag', () => {
  it('reproduce el vector de Argon2id de RFC 9106 §5.3, con su secreto y sus datos asociados', async () => {
    const tag = await argon2idTag({
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      memory: 32,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    });
    expect(tag.toString('hex')).toBe(
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    );
  });
});

describe('createPasswordHasher', () => {
  const PEPPER = Buffer.alloc(32, 0x70);
  const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  /** Argon2id con 64 MiB, 3 pasadas, un hilo, 32 bytes, la sal y la clave de arriba, calculado aparte. */
  const EXPECTED =
    '$argon2id$v=19$m=65536,t=3,p=1$AAECAwQFBgcICQoLDA0ODw$hkGk+65dvpxS93aTwH/nv954VTjdPPlDmuSlUf5z6vk';

  it('guarda Argon2id con 64 MiB, 3 pasadas, un hilo, 32 bytes, una sal de 16 y la clave del servidor', async () => {
    const sizes: number[] = [];
    const hasher = createPasswordHasher({
      pepper: PEPPER,
      maxWaiting: 4,
      randomBytes: (size) => {
        sizes.push(size);
        return SALT;
      },
    });
    expect(await hasher.hash('una contraseña larga de prueba')).toBe(EXPECTED);
    expect(sizes).toEqual([16]);
  });

  it('normaliza a NFC antes de calcular: la misma contraseña escrita de otra forma da el mismo hash', async () => {
    const hasher = createPasswordHasher({ pepper: PEPPER, maxWaiting: 4, randomBytes: () => SALT });
    expect(await hasher.hash('una contrasen\u0303a larga de prueba')).toBe(EXPECTED);
  });

  it('otra clave del servidor da otro hash', async () => {
    const hasher = createPasswordHasher({
      pepper: Buffer.alloc(32, 0x71),
      maxWaiting: 4,
      randomBytes: () => SALT,
    });
    expect(await hasher.hash('una contraseña larga de prueba')).not.toBe(EXPECTED);
  });

  it('calcula un hash a la vez, y con demasiados esperando rechaza el siguiente sin calcularlo', async () => {
    const calls: { message: string; resolve: () => void }[] = [];
    let running = 0;
    let maxRunning = 0;
    const argon2: Argon2Function = (parameters) =>
      new Promise((resolve) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        calls.push({
          message: Buffer.from(parameters.message).toString('utf8'),
          resolve: () => {
            running -= 1;
            resolve(Buffer.alloc(32, 0x01));
          },
        });
      });
    const hasher = createPasswordHasher({
      pepper: PEPPER,
      maxWaiting: 2,
      randomBytes: () => SALT,
      argon2,
    });
    const first = hasher.hash('primera contraseña larga');
    const second = hasher.hash('segunda contraseña larga');
    const third = hasher.hash('tercera contraseña larga');
    await expect(hasher.hash('cuarta contraseña larga')).rejects.toBeInstanceOf(
      PasswordHasherBusyError,
    );
    await Promise.resolve();
    expect(calls.map((call) => call.message)).toEqual(['primera contraseña larga']);
    calls[0]?.resolve();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.map((call) => call.message)).toEqual([
      'primera contraseña larga',
      'segunda contraseña larga',
    ]);
    // Con uno en curso y uno esperando, cabe otro.
    const fourth = hasher.hash('cuarta contraseña larga');
    calls[1]?.resolve();
    await second;
    await new Promise((resolve) => setImmediate(resolve));
    calls[2]?.resolve();
    await third;
    await new Promise((resolve) => setImmediate(resolve));
    calls[3]?.resolve();
    await fourth;
    expect(maxRunning).toBe(1);
    expect(calls).toHaveLength(4);
  });

  it('un fallo de un cálculo no detiene la cola', async () => {
    let calls = 0;
    const argon2: Argon2Function = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('fallo')) : Promise.resolve(Buffer.alloc(32));
    };
    const hasher = createPasswordHasher({
      pepper: PEPPER,
      maxWaiting: 1,
      randomBytes: () => SALT,
      argon2,
    });
    const failed = hasher.hash('primera contraseña larga');
    const next = hasher.hash('segunda contraseña larga');
    await expect(failed).rejects.toThrow('fallo');
    await expect(next).resolves.toMatch(/^\$argon2id\$/u);
  });

  it('exige una clave del servidor de 32 bytes', () => {
    expect(() =>
      createPasswordHasher({ pepper: Buffer.alloc(16), maxWaiting: 1, randomBytes: () => SALT }),
    ).toThrow(TypeError);
  });
});

describe('createPasswordHasher: verify (ADR-0019 §1)', () => {
  const PEPPER = Buffer.alloc(32, 0x70);
  const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

  it('acepta la contraseña correcta y rechaza otra, con Argon2id real', async () => {
    const hasher = createPasswordHasher({ pepper: PEPPER, maxWaiting: 4, randomBytes: () => SALT });
    const hash = await hasher.hash('una contraseña larga de prueba');
    expect(await hasher.verify(hash, 'una contraseña larga de prueba')).toBe(true);
    expect(await hasher.verify(hash, 'una contraseña larga de PRUEBA')).toBe(false);
    // La misma contraseña escrita en NFD vale: verify también normaliza a NFC.
    expect(await hasher.verify(hash, 'una contrasen\u0303a larga de prueba')).toBe(true);
    // Otra clave del servidor no abre el hash.
    const other = createPasswordHasher({
      pepper: Buffer.alloc(32, 0x71),
      maxWaiting: 4,
      randomBytes: () => SALT,
    });
    expect(await other.verify(hash, 'una contraseña larga de prueba')).toBe(false);
  });

  it('el hash de ejemplo de un nombre que no existe da false pero calcula igual', async () => {
    let calls = 0;
    const argon2: Argon2Function = () => {
      calls += 1;
      return Promise.resolve(Buffer.alloc(32, 0x09));
    };
    const hasher = createPasswordHasher({
      pepper: PEPPER,
      maxWaiting: 4,
      randomBytes: () => SALT,
      argon2,
    });
    expect(await hasher.verify(DUMMY_PASSWORD_HASH, 'cualquier contraseña larga')).toBe(false);
    expect(calls).toBe(1);
  });

  it('un hash mal formado o con parámetros fuera de rango da false sin lanzar, y calcula igual', async () => {
    let calls = 0;
    const argon2: Argon2Function = () => {
      calls += 1;
      return Promise.resolve(Buffer.alloc(32, 0x01));
    };
    const hasher = createPasswordHasher({
      pepper: PEPPER,
      maxWaiting: 4,
      randomBytes: () => SALT,
      argon2,
    });
    const bad = [
      'no-es-un-phc',
      `$argon2i$v=19$m=65536,t=3,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
      '$argon2id$v=19$m=65536,t=3,p=1$short$short',
      `$argon2id$v=19$m=999999999,t=3,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
      `$argon2id$v=19$m=65536,t=99,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
    ];
    for (const value of bad) {
      expect(await hasher.verify(value, 'una contraseña larga'), value).toBe(false);
    }
    expect(calls).toBe(bad.length);
  });

  it('comparte la cola de los hashes: con uno en curso y la cola llena, rechaza', async () => {
    const resolvers: (() => void)[] = [];
    const argon2: Argon2Function = () =>
      new Promise((resolve) => {
        resolvers.push(() => {
          resolve(Buffer.alloc(32));
        });
      });
    const hasher = createPasswordHasher({
      pepper: PEPPER,
      maxWaiting: 0,
      randomBytes: () => SALT,
      argon2,
    });
    const running = hasher.hash('primera contraseña larga');
    await Promise.resolve();
    await expect(hasher.verify(DUMMY_PASSWORD_HASH, 'x')).rejects.toBeInstanceOf(
      PasswordHasherBusyError,
    );
    resolvers[0]?.();
    await running;
  });
});
