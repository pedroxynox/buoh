import { evaluateSourceLimit, type SourceLimitViolation } from '@buoh/domain';

export type QueueOffer =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly violation: SourceLimitViolation };

interface Entry<Item> {
  /** Bytes del frame, o `null` si es un evento de control. */
  readonly bytes: number | null;
  readonly item: Item;
}

/**
 * Cola entre `ws` y el `RawFirstIngestor` (ADR-0012 §4). Tiene un solo consumidor, que espera cada
 * llamada antes de entregar el siguiente elemento, así que el ingestor recibe una llamada a la vez.
 *
 * El límite de ADR-0004 §7 (1000 eventos y 33 554 432 bytes, el primero que se alcance) cuenta los
 * frames de la fuente, desde que entran hasta que el consumidor termina con ellos. Los eventos de
 * control (apertura, pausa y cierre de la entrada) los añade el adaptador, son pocos por conexión y
 * nunca se rechazan: así el cierre siempre puede persistirse.
 */
export class IngestQueue<Item> {
  readonly #consume: (item: Item) => Promise<void>;
  readonly #onError: (error: unknown) => void;
  readonly #entries: Entry<Item>[] = [];
  #frames = 0;
  #bytes = 0;
  #running = false;
  #failed = false;

  constructor(input: {
    readonly consume: (item: Item) => Promise<void>;
    /** Error inesperado del consumidor. La cola se detiene y descarta lo que espera. */
    readonly onError: (error: unknown) => void;
  }) {
    this.#consume = input.consume;
    this.#onError = input.onError;
  }

  /** Frames en la cola o en curso, y sus bytes. */
  get frameCount(): number {
    return this.#frames;
  }

  get byteCount(): number {
    return this.#bytes;
  }

  /**
   * Ofrece un frame de `bytes` bytes. Si no cabe, no lo guarda y devuelve el límite superado, con el
   * valor que habría alcanzado: eventos primero y después bytes.
   */
  offerFrame(item: Item, bytes: number): QueueOffer {
    const violation =
      evaluateSourceLimit('in_memory_queue_events', this.#frames + 1) ??
      evaluateSourceLimit('in_memory_queue_bytes', this.#bytes + bytes);
    if (violation !== null) {
      return { status: 'rejected', violation };
    }
    this.#frames += 1;
    this.#bytes += bytes;
    this.#push({ bytes, item });
    return { status: 'accepted' };
  }

  /** Añade un evento de control, que no cuenta para el límite. */
  pushControl(item: Item): void {
    this.#push({ bytes: null, item });
  }

  /** Descarta los frames que esperan, nunca el que está en curso, y conserva los de control. */
  dropWaitingFrames(): void {
    const kept = this.#entries.filter((entry) => entry.bytes === null);
    for (const entry of this.#entries) {
      if (entry.bytes !== null) {
        this.#frames -= 1;
        this.#bytes -= entry.bytes;
      }
    }
    this.#entries.splice(0, this.#entries.length, ...kept);
  }

  #push(entry: Entry<Item>): void {
    if (this.#failed) {
      return;
    }
    this.#entries.push(entry);
    if (!this.#running) {
      this.#running = true;
      void this.#run();
    }
  }

  async #run(): Promise<void> {
    for (let entry = this.#entries.shift(); entry !== undefined; entry = this.#entries.shift()) {
      try {
        await this.#consume(entry.item);
      } catch (error) {
        this.#failed = true;
        this.dropWaitingFrames();
        this.#entries.length = 0;
        this.#running = false;
        this.#onError(error);
        return;
      } finally {
        if (entry.bytes !== null) {
          this.#frames -= 1;
          this.#bytes -= entry.bytes;
        }
      }
    }
    this.#running = false;
  }
}
