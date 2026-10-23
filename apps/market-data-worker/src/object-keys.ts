/** Claves y URIs de ADR-0004 §6 y §8. Bucket y URI no participan en `dataset_id`. */

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Clave final content-addressed de un objeto: `sha256/<object_bytes_sha256>`. */
export function contentKey(objectBytesSha256: string): string {
  if (!SHA256_PATTERN.test(objectBytesSha256)) {
    throw new TypeError('object_bytes_sha256 debe ser SHA-256 hexadecimal minúsculo.');
  }
  return `sha256/${objectBytesSha256}`;
}

/** Clave del documento canónico: `manifests/<dataset_id>/<publication_id>/<digest>.json`. */
export function manifestKey(input: {
  dataset_id: string;
  manifest_document_sha256: string;
  publication_id: string;
}): string {
  return `manifests/${input.dataset_id}/${input.publication_id}/${input.manifest_document_sha256}.json`;
}

export function objectUri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

/**
 * Resuelve una URI `s3://<bucket>/<key>` del manifiesto a una clave del bucket configurado.
 * Devuelve `null` si el esquema o el bucket no corresponden.
 */
export function keyFromUri(uri: string, bucket: string): string | null {
  const prefix = `s3://${bucket}/`;
  if (!uri.startsWith(prefix)) {
    return null;
  }
  const key = uri.slice(prefix.length);
  if (key.length === 0 || key.split('/').some((segment) => segment === '' || segment === '..')) {
    return null;
  }
  return key;
}
