import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ConfigError, loadConfig } from '../config.js';
import { PublicationConflictError } from '../errors.js';
import { DEFAULT_VECTOR_ROOT, loadSyntheticFixture } from '../fixture.js';
import { createUuidV7Generator } from '../ids.js';
import { RawFirstIngestor } from '../ingestion/raw-first-ingestor.js';
import { OperationalRegistry } from '../operational/registry.js';
import { lockedSourceLogStore, SourceLock } from '../postgres/source-lock.js';
import { openStores } from '../runtime.js';
import { publishFromLog } from '../source-log/publish-from-log.js';
import { SourceEventLog } from '../source-log/source-event-log.js';
import { driveSyntheticStimuli } from '../synthetic-driver.js';

/**
 * `pnpm --filter @buoh/market-data-worker run fixture:publish`: pasa los escenarios sintéticos de
 * `test-vectors/market-data/v1` por el log raw-first real (PostgreSQL + S3) y publica cada uno
 * desde sus segmentos cerrados, para ejercitar `data:replay`. Acción explícita (ADR-0004 §13) con
 * datos sintéticos; usa reloj y entropía reales para la identidad física de la publicación.
 */
async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const fixture = await loadSyntheticFixture(fileURLToPath(DEFAULT_VECTOR_ROOT));
  const nextId = createUuidV7Generator({ now: () => Date.now(), randomBytes });
  const source = fixture.profile.source;
  // Una sola instancia escribe el log de la fuente (ADR-0012 §9): si otra lo tiene, no arranca.
  const lock = await SourceLock.acquire({ postgres: config.postgres, source });
  if (lock === null) {
    console.error(`Otro proceso escribe el log de "${source}"; no se arranca.`);
    return 1;
  }
  const stores = openStores(config);
  try {
    const sourceLog = lockedSourceLogStore(stores.sourceLog, lock);
    const openLog = () =>
      SourceEventLog.open({
        objects: stores.objects,
        source,
        store: sourceLog,
        zlibVersion: process.versions.zlib,
      });
    let log = await openLog();
    const expectedSegments = fixture.scenarios.reduce((sum, item) => sum + item.segments.length, 0);

    if (log.totalEventCount === 0) {
      const ingestor = new RawFirstIngestor({
        log,
        nextId,
        now: () => new Date().toISOString(),
        profile: fixture.profile,
        registry: await OperationalRegistry.open({ source, store: stores.operational }),
        reopenLog: openLog,
        sink: { invalidFrame: () => undefined, tick: () => undefined },
      });
      for (const scenario of fixture.scenarios) {
        await driveSyntheticStimuli(ingestor, scenario.stimuli, source);
        await ingestor.rotate('requested');
      }
      if (ingestor.state !== 'accepting') {
        throw new TypeError('La ingesta sintética no quedó durable; revisa el registro operativo.');
      }
      log = ingestor.log;
    }
    if (log.openSegmentIndex !== expectedSegments || log.openSegmentStats.event_count !== 0) {
      throw new TypeError(
        `El log de "${source}" no tiene la forma del fixture; usa una base de datos o esquema limpio.`,
      );
    }

    const results = [];
    let fromSegment = 0;
    for (const scenario of fixture.scenarios) {
      const toSegment = fromSegment + scenario.segments.length - 1;
      try {
        const publication = await publishFromLog({
          environment: config.environment,
          fromSegment,
          log,
          metadata: stores.metadata,
          objects: stores.objects,
          profile: fixture.profile,
          publication_id: nextId(),
          published_at_utc: new Date().toISOString(),
          toSegment,
          zlibVersion: process.versions.zlib,
        });
        results.push({
          dataset_id: publication.dataset_id,
          log_segments: [fromSegment, toSegment],
          publication_id: publication.record.publication_id,
          scenario: scenario.name,
          status: 'published',
        });
      } catch (error) {
        if (!(error instanceof PublicationConflictError)) {
          throw error;
        }
        results.push({
          dataset_id: error.datasetId,
          log_segments: [fromSegment, toSegment],
          scenario: scenario.name,
          status: 'already_published',
        });
      }
      fromSegment = toSegment + 1;
    }
    console.log(JSON.stringify({ deployment_environment: config.environment, results }));
    return 0;
  } finally {
    try {
      await lock.release();
    } finally {
      await stores.close();
    }
  }
}

process.exitCode = await main();
