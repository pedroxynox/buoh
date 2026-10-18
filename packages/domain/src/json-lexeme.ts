/**
 * Parser JSON estricto (RFC 8259) que conserva el lexema de cada número.
 *
 * ADR-0004 prohíbe derivar cotizaciones de dominio con `JSON.parse` y aritmética binaria:
 * `100.130` debe conservar su cero final. Este parser produce un árbol con números como
 * texto y rechaza claves duplicadas, profundidad excesiva y strings Unicode mal formados.
 */

export type JsonNode =
  | { readonly type: 'array'; readonly items: readonly JsonNode[] }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'null' }
  | { readonly type: 'number'; readonly lexeme: string }
  | { readonly type: 'object'; readonly entries: ReadonlyMap<string, JsonNode> }
  | { readonly type: 'string'; readonly value: string };

export class JsonLexemeError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (offset ${String(offset)})`);
    this.name = 'JsonLexemeError';
    this.offset = offset;
  }
}

const MAX_DEPTH = 64;
const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;

class Parser {
  private position = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsonNode {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.position !== this.text.length) {
      this.fail('Contenido posterior al documento JSON');
    }
    return value;
  }

  private fail(message: string): never {
    throw new JsonLexemeError(message, this.position);
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
        return;
      }
      this.position += 1;
    }
  }

  private expectLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.position)) {
      this.fail(`Se esperaba ${literal}`);
    }
    this.position += literal.length;
  }

  private parseValue(depth: number): JsonNode {
    if (depth > MAX_DEPTH) {
      this.fail('Profundidad JSON excedida');
    }
    const character = this.text[this.position] ?? '';
    switch (character) {
      case '{':
        return this.parseObject(depth);
      case '[':
        return this.parseArray(depth);
      case '"':
        return { type: 'string', value: this.parseString() };
      case 't':
        this.expectLiteral('true');
        return { type: 'boolean', value: true };
      case 'f':
        this.expectLiteral('false');
        return { type: 'boolean', value: false };
      case 'n':
        this.expectLiteral('null');
        return { type: 'null' };
      default:
        return this.parseNumber();
    }
  }

  private parseNumber(): JsonNode {
    NUMBER_PATTERN.lastIndex = this.position;
    const match = NUMBER_PATTERN.exec(this.text);
    if (match === null) {
      this.fail('Valor JSON inválido');
    }
    this.position += match[0].length;
    return { type: 'number', lexeme: match[0] };
  }

  private parseString(): string {
    this.position += 1;
    let result = '';
    for (;;) {
      if (this.position >= this.text.length) {
        this.fail('String sin cerrar');
      }
      const code = this.text.charCodeAt(this.position);
      if (code === 0x22) {
        this.position += 1;
        break;
      }
      if (code < 0x20) {
        this.fail('Carácter de control sin escapar');
      }
      if (code !== 0x5c) {
        result += this.text[this.position] ?? '';
        this.position += 1;
        continue;
      }
      const escape = this.text[this.position + 1] ?? '';
      this.position += 2;
      switch (escape) {
        case '"':
        case '\\':
        case '/':
          result += escape;
          break;
        case 'b':
          result += '\b';
          break;
        case 'f':
          result += '\f';
          break;
        case 'n':
          result += '\n';
          break;
        case 'r':
          result += '\r';
          break;
        case 't':
          result += '\t';
          break;
        case 'u': {
          const hex = this.text.slice(this.position, this.position + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
            this.fail('Escape \\u inválido');
          }
          result += String.fromCharCode(Number.parseInt(hex, 16));
          this.position += 4;
          break;
        }
        default:
          this.fail('Escape inválido');
      }
    }
    if (!result.isWellFormed()) {
      this.fail('String con surrogates aislados');
    }
    return result;
  }

  private parseArray(depth: number): JsonNode {
    this.position += 1;
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.text[this.position] === ']') {
      this.position += 1;
      return { type: 'array', items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.text[this.position];
      this.position += 1;
      if (separator === ']') {
        return { type: 'array', items };
      }
      if (separator !== ',') {
        this.fail('Se esperaba , o ]');
      }
    }
  }

  private parseObject(depth: number): JsonNode {
    this.position += 1;
    const entries = new Map<string, JsonNode>();
    this.skipWhitespace();
    if (this.text[this.position] === '}') {
      this.position += 1;
      return { type: 'object', entries };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.position] !== '"') {
        this.fail('Se esperaba una clave');
      }
      const key = this.parseString();
      if (entries.has(key)) {
        this.fail(`Clave duplicada: ${key}`);
      }
      this.skipWhitespace();
      if (this.text[this.position] !== ':') {
        this.fail('Se esperaba :');
      }
      this.position += 1;
      this.skipWhitespace();
      entries.set(key, this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.text[this.position];
      this.position += 1;
      if (separator === '}') {
        return { type: 'object', entries };
      }
      if (separator !== ',') {
        this.fail('Se esperaba , o }');
      }
    }
  }
}

export function parseJsonPreservingNumbers(text: string): JsonNode {
  return new Parser(text).parseDocument();
}

/** Convierte el árbol a valores JavaScript para validación estructural (no para dominio). */
export function toPlainJson(node: JsonNode): unknown {
  switch (node.type) {
    case 'array':
      return node.items.map(toPlainJson);
    case 'boolean':
    case 'string':
      return node.value;
    case 'null':
      return null;
    case 'number':
      return Number(node.lexeme);
    case 'object':
      return Object.fromEntries([...node.entries].map(([key, value]) => [key, toPlainJson(value)]));
  }
}

export function getMember(node: JsonNode | undefined, key: string): JsonNode | undefined {
  return node?.type === 'object' ? node.entries.get(key) : undefined;
}
