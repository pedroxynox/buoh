import {
  EXECUTION_MODE_PRESENTATION,
  palette,
  SERVICE_HEALTH_PRESENTATION,
  SEVERITY_PRESENTATION,
  TONES,
  typography,
  type IconName,
  type Severity,
  type Tone,
} from '@buoh/design-system';
import {
  Badge,
  BuohLogo,
  BuohMark,
  Card,
  HealthBadge,
  ModeBadge,
  PhaseLock,
  SeverityTag,
} from '@buoh/design-system/react';
import type { ExecutionMode, ServiceHealth } from '@buoh/contracts';
import type { Metadata } from 'next';
import { PageHeader } from '../../src/components/AppShell';
import { SectionTitle } from '../../src/components/Pieces';

export const metadata: Metadata = { title: 'Guía visual' };

const MODES = Object.keys(EXECUTION_MODE_PRESENTATION) as ExecutionMode[];
const HEALTH = Object.keys(SERVICE_HEALTH_PRESENTATION) as ServiceHealth[];
const SEVERITIES = Object.keys(SEVERITY_PRESENTATION) as Severity[];

const FAMILIES = ['noche', 'niebla', 'luna', 'boreal', 'papel'] as const;

/** Un icono de ejemplo por tono, tomado del estado que lo usa. */
const TONE_EXAMPLE_ICON: Readonly<Record<Tone, IconName>> = {
  aurora: 'check',
  cielo: 'info',
  naranja: 'alertTriangle',
  rojo: 'xOctagon',
  niebla: 'pauseCircle',
  violeta: 'moon',
  cian: 'playCircle',
  rosa: 'banknote',
};

function Swatches({ family }: { readonly family: (typeof FAMILIES)[number] }) {
  return (
    <div className="w-swatches">
      {Object.entries(palette[family]).map(([step, hex]) => (
        <div key={step} className="w-swatch">
          <div className="w-swatch__color" style={{ background: hex }} />
          <div className="w-swatch__meta">
            <strong>
              {family}.{step}
            </strong>
            <span className="b-num b-muted">{hex}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ThemeSample({ theme }: { readonly theme: 'noche' | 'dia' }) {
  return (
    <div className="w-theme-sample" data-theme={theme}>
      <div className="w-row" style={{ justifyContent: 'space-between' }}>
        <BuohLogo size={26} />
        <span className="b-eyebrow">Tema {theme === 'noche' ? 'noche' : 'día'}</span>
      </div>
      <div className="w-row">
        <ModeBadge mode="shadow" />
        <HealthBadge health="degraded" />
        <SeverityTag severity="warning" />
      </div>
      <p className="b-secondary w-small">
        Texto secundario sobre el fondo del tema. <span className="b-num">1042.87</span>
      </p>
      <div className="w-row">
        <button type="button" className="b-button b-button--primary">
          Acción principal
        </button>
        <button type="button" className="b-button b-button--secondary">
          Secundaria
        </button>
      </div>
    </div>
  );
}

export default function GuiaPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guía visual"
        title="La marca de buoh"
        summary="Observa con calma. Decide con evidencia. Colores, tipografía, estados y componentes del sistema de diseño, tal como los usa el producto."
      />

      <SectionTitle>Logotipo</SectionTitle>
      <div className="w-grid w-grid--3">
        <Card title="Símbolo" subtitle="Búho de orejas cruzadas, en verde azulado y crema">
          <div className="w-row" style={{ gap: 'var(--b-space-6)' }}>
            <BuohMark size={72} />
            <BuohMark size={40} />
            <BuohMark size={24} />
          </div>
        </Card>
        <Card title="Logotipo" subtitle="Símbolo y palabra, vectorizados del logo original">
          <BuohLogo size={44} />
        </Card>
        <Card title="Monocromo" subtitle="Una sola tinta, con los detalles separados">
          <div className="w-row b-secondary" style={{ gap: 'var(--b-space-6)' }}>
            <BuohMark size={56} variant="mono" />
            <BuohLogo size={32} variant="mono" />
          </div>
        </Card>
      </div>

      <SectionTitle>Paleta</SectionTitle>
      {FAMILIES.map((family) => (
        <Card key={family} title={family} headingLevel={3}>
          <Swatches family={family} />
        </Card>
      ))}

      <SectionTitle>Estados</SectionTitle>
      <div className="w-grid w-grid--3">
        <Card title="Modo de ejecución" subtitle="Qué puede hacer el bot">
          <div className="w-stack">
            {MODES.map((mode) => (
              <ModeBadge key={mode} mode={mode} showDescription />
            ))}
          </div>
        </Card>
        <Card title="Salud del servicio" subtitle="Eje distinto del modo">
          <div className="w-stack">
            {HEALTH.map((health) => (
              <HealthBadge key={health} health={health} showDescription />
            ))}
          </div>
        </Card>
        <Card title="Severidad" subtitle="Incidencias de calidad">
          <div className="w-stack">
            {SEVERITIES.map((severity) => (
              <SeverityTag key={severity} severity={severity} />
            ))}
          </div>
        </Card>
      </div>
      <Card title="Tonos" subtitle="Nunca solos: siempre con texto e icono">
        <div className="w-row">
          {TONES.map((tone) => (
            <Badge key={tone} tone={tone} icon={TONE_EXAMPLE_ICON[tone]}>
              {tone}
            </Badge>
          ))}
        </div>
      </Card>

      <SectionTitle>Estados de pantalla</SectionTitle>
      <div className="w-grid w-grid--4">
        <Card title="Cargando" subtitle="Esqueleto quieto, sin animación">
          <div className="w-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p className="b-visually-hidden">Cargando datos</p>
        </Card>
        <Card title="Vacío" subtitle="Por qué está vacío y qué hacer">
          <p className="b-secondary w-small">
            Todavía no hay señales: ninguna estrategia está aprobada para shadow. Revisa el
            laboratorio.
          </p>
        </Card>
        <Card title="Error" subtitle="Qué falló, desde cuándo y qué sigue valiendo">
          <div className="w-stack">
            <SeverityTag severity="error" />
            <p className="b-secondary w-small">
              No se pudo leer el catálogo desde las 14:30:12 UTC. Los datos mostrados son del último
              snapshot válido.
            </p>
          </div>
        </Card>
        <Card title="Degradado" subtitle="La salud cambia y la cifra se marca">
          <div className="w-stack">
            <HealthBadge health="degraded" />
            <p className="b-secondary w-small">
              <span className="b-num">1042.87</span>{' '}
              <Badge tone="naranja" icon="gap">
                con hueco
              </Badge>
            </p>
          </div>
        </Card>
      </div>

      <SectionTitle>Tipografía</SectionTitle>
      <Card title="Sen y JetBrains Mono" subtitle="Interfaz, y cifras y rótulos técnicos">
        {(['6xl', '4xl', '2xl', 'lg', 'base', 'sm'] as const).map((size) => (
          <div key={size} className="w-type-row">
            <span className="b-num b-muted w-small">{typography.size[size]}</span>
            <span
              style={{
                fontSize: `var(--b-size-${size})`,
                fontWeight: size === 'base' || size === 'sm' ? 400 : 700,
              }}
            >
              Observa con calma
            </span>
          </div>
        ))}
        <div className="w-type-row">
          <span className="b-num b-muted w-small">mono</span>
          <span className="b-num" style={{ fontSize: 'var(--b-size-xl)' }}>
            1042.87 · sha256:6f2c…a91d · 14:32:05 UTC
          </span>
        </div>
      </Card>

      <SectionTitle>Temas y componentes</SectionTitle>
      <div className="w-themes">
        <ThemeSample theme="noche" />
        <ThemeSample theme="dia" />
      </div>
      <p className="b-muted w-small">Los botones de estas muestras no hacen nada.</p>
      <PhaseLock
        phase="4"
        title="Ejemplo de candado de fase"
        description="Así se ve una función futura: se explica, pero no tiene controles."
      />
    </>
  );
}
