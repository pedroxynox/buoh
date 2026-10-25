import type { NextConfig } from 'next';

/**
 * Sitio oficial de buoh (ADR-0008 §3): exportación estática, sin servidor Next.js, sin optimización
 * de imágenes y sin recursos de terceros.
 */
const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // Identificador fijo: dos exportaciones del mismo commit producen las mismas rutas.
  generateBuildId: () => Promise.resolve('buoh-sitio'),
};

export default config;
