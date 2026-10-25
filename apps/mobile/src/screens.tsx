import {
  DEMO_NOW_UTC,
  formatUtc,
  formatUtcTime,
  GLOBAL_STATUS,
  INCIDENT_LABELS,
  INCIDENT_STATUS,
  SHADOW_RESULT,
  SIGNAL_STATUS,
  SIGNALS,
  SOURCES,
  type SignalRow,
} from '@buoh/prototype-data';
import { Pressable, Text, View } from 'react-native';
import {
  alertsInOrder,
  APPROVED_EVIDENCE,
  LATEST_SIGNALS,
  LOCKED_ON_MOBILE,
  ONLY_ON_WEB,
  OPEN_ALERTS,
  PAUSED_STRATEGIES,
  SHADOW_EVIDENCE,
  type TabId,
} from './model';
import { font, size, space, theme, TOUCH } from './theme';
import {
  Badge,
  Card,
  HealthBadge,
  Icon,
  ListRow,
  MetricWithContext,
  ModeBadge,
  PhaseLock,
  SectionTitle,
  SeverityTag,
  styles,
} from './ui';

function PageTitle({
  eyebrow,
  title,
  summary,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly summary: string;
}) {
  return (
    <View style={{ gap: space[1], marginBottom: space[2] }}>
      <Text
        style={{
          fontFamily: font.semibold,
          fontSize: size.xs,
          letterSpacing: 1,
          color: theme.text.muted,
        }}
      >
        {eyebrow.toUpperCase()}
      </Text>
      <Text
        role="heading"
        aria-level={1}
        style={{ fontFamily: font.bold, fontSize: size.xxl, color: theme.text.primary }}
      >
        {title}
      </Text>
      <Text style={styles.secondary}>{summary}</Text>
    </View>
  );
}

function NavButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      role="button"
      onPress={onPress}
      style={{ minHeight: TOUCH, justifyContent: 'center', alignSelf: 'flex-start' }}
    >
      <Text style={[styles.strong, { textDecorationLine: 'underline' }]}>{label}</Text>
    </Pressable>
  );
}

export function SignalCard({
  signal,
  onNavigate,
}: {
  readonly signal: SignalRow;
  readonly onNavigate: (tab: TabId) => void;
}) {
  const status = SIGNAL_STATUS[signal.status];
  return (
    <Card
      title={`${signal.strategy} ${signal.version}`}
      subtitle={`${signal.symbol} · ${signal.condition}`}
    >
      <ModeBadge mode={signal.mode} />
      <Text style={[styles.body, styles.strong]}>{signal.direction}</Text>
      <View style={{ flexDirection: 'row', gap: space[6] }}>
        <View style={{ gap: 2 }}>
          <Text style={styles.muted}>Emitida</Text>
          <Text style={styles.mono}>{formatUtcTime(signal.issuedUtc)}</Text>
        </View>
        <View style={{ gap: 2 }}>
          <Text style={styles.muted}>Vence</Text>
          <Text style={styles.mono}>{formatUtcTime(signal.expiresUtc)}</Text>
        </View>
      </View>
      <View style={styles.row}>
        {signal.quality === 'completa' ? (
          <Badge tone="aurora" icon="check" label="Datos completos" />
        ) : (
          <Badge tone="naranja" icon="alertTriangle" label="Datos degradados" />
        )}
        <Badge tone={status.tone} icon={status.icon} label={status.label} />
      </View>
      <Text style={styles.muted}>Una señal no es una orden.</Text>
      <NavButton
        label="Ver evidencia"
        onPress={() => {
          onNavigate('evidencia');
        }}
      />
    </Card>
  );
}

export function InicioScreen({ onNavigate }: { readonly onNavigate: (tab: TabId) => void }) {
  return (
    <>
      <PageTitle
        eyebrow="Observatorio"
        title="¿Está todo bien ahora?"
        summary={`Estado al ${formatUtc(DEMO_NOW_UTC)}.`}
      />
      <Card title="Modo de ejecución" subtitle="Qué puede hacer el bot">
        <ModeBadge mode={GLOBAL_STATUS.mode} showDescription />
        <Text style={styles.secondary}>Las señales son hipotéticas. Nada sale al bróker.</Text>
      </Card>
      <Card title="Salud del servicio" subtitle="Datos y persistencia">
        <HealthBadge health={GLOBAL_STATUS.health} showDescription />
        <Text style={styles.secondary}>
          Un hueco sin resolver en R_100 la baja a degradada. Es un eje distinto del modo.
        </Text>
      </Card>
      <Card title="Alertas abiertas" subtitle="Calidad de datos">
        <Text style={{ fontFamily: font.bold, fontSize: size.xxl, color: theme.text.primary }}>
          {String(OPEN_ALERTS)}
        </Text>
        <NavButton
          label="Ver alertas"
          onPress={() => {
            onNavigate('alertas');
          }}
        />
      </Card>
      <Card title="Pausas automáticas" subtitle="Detenidas por la calidad de datos">
        {PAUSED_STRATEGIES.map((strategy) => (
          <View key={strategy.id} style={{ gap: space[2] }}>
            <Text style={styles.strong}>{`${strategy.name} ${strategy.version}`}</Text>
            <Text style={styles.secondary}>{strategy.note}</Text>
            <Badge tone="niebla" icon="pauseCircle" label="En pausa" />
          </View>
        ))}
      </Card>
      <SectionTitle>Últimas señales</SectionTitle>
      {LATEST_SIGNALS.map((signal) => (
        <SignalCard key={signal.id} signal={signal} onNavigate={onNavigate} />
      ))}
    </>
  );
}

export function SenalesScreen({ onNavigate }: { readonly onNavigate: (tab: TabId) => void }) {
  return (
    <>
      <PageTitle
        eyebrow="Señales"
        title="¿Qué propuso el bot?"
        summary="Cada señal dice qué estrategia y versión la emitió, cuándo vence, en qué modo está y con qué calidad de datos."
      />
      {SIGNALS.map((signal) => (
        <SignalCard key={signal.id} signal={signal} onNavigate={onNavigate} />
      ))}
    </>
  );
}

export function AlertasScreen() {
  return (
    <>
      <PageTitle
        eyebrow="Alertas"
        title="¿Qué necesita atención?"
        summary="Primero lo que sigue abierto. Sin sonidos ni cuentas atrás: las alertas avisan, no apuran."
      />
      <Card title="Incidencias de calidad">
        {alertsInOrder().map((incident) => {
          const status = INCIDENT_STATUS[incident.status];
          return (
            <ListRow key={`${incident.type}-${incident.whenUtc}`}>
              <View style={{ flex: 1, gap: space[1] }}>
                <Text style={styles.strong}>{INCIDENT_LABELS[incident.type]}</Text>
                <Text style={styles.muted}>
                  {`${incident.symbol} · ${incident.source} · ${formatUtcTime(incident.whenUtc)}`}
                </Text>
                <Text style={styles.secondary}>{incident.detail}</Text>
                <Badge tone={status.tone} icon={status.icon} label={status.label} />
              </View>
              <SeverityTag severity={incident.severity} />
            </ListRow>
          );
        })}
      </Card>
    </>
  );
}

export function EvidenciaScreen() {
  const { context } = SHADOW_EVIDENCE;
  return (
    <>
      <PageTitle
        eyebrow="Evidencia"
        title="¿Esta estrategia tiene evidencia?"
        summary="Ninguna cifra va sola. La evidencia completa, con todos los tramos, está en la web."
      />
      <Card title={`${context.version} · en shadow`} subtitle="Desde su aprobación">
        <MetricWithContext
          label="Pérdida neta hipotética"
          value={SHADOW_RESULT}
          context={context}
        />
      </Card>
      <SectionTitle>Validaciones que aprobaron cada estrategia</SectionTitle>
      {APPROVED_EVIDENCE.map((item) => (
        <Card key={item.strategyId} title={item.version} subtitle="Prueba fuera de muestra">
          <MetricWithContext
            label="Resultado neto después de costes"
            value={item.result}
            context={item.context}
          />
        </Card>
      ))}
    </>
  );
}

export function MasScreen() {
  return (
    <>
      <PageTitle
        eyebrow="Más"
        title="Fuentes, límites y lo que llega después"
        summary="El móvil sirve para seguir el bot. Lo que cambia el riesgo se hace en la web o el escritorio."
      />
      {LOCKED_ON_MOBILE.map((item) => (
        <PhaseLock
          key={item.title}
          phase={item.phase}
          title={item.title}
          description={item.description}
        />
      ))}
      <Card title="Fuentes" subtitle="Cada una con su propia salud">
        {SOURCES.map((source) => (
          <ListRow key={source.id}>
            <View style={{ flex: 1, gap: space[1] }}>
              <Text style={styles.strong}>{source.name}</Text>
              <Text style={styles.muted}>{source.kind}</Text>
            </View>
            <HealthBadge health={source.health} />
          </ListRow>
        ))}
      </Card>
      <Card
        title="Solo en la web o el escritorio"
        subtitle="Cambian el riesgo o necesitan pantalla grande"
      >
        {ONLY_ON_WEB.map((item) => (
          <View key={item} style={styles.row}>
            <Icon name="circleSlash" dimension={16} color={theme.text.muted} />
            <Text style={[styles.secondary, { flexShrink: 1 }]}>{item}</Text>
          </View>
        ))}
      </Card>
      <Card title="Este prototipo">
        <Text style={styles.secondary}>
          Muestra datos ficticios. No envía órdenes, no se conecta a ninguna fuente ni bróker y no
          guarda credenciales.
        </Text>
      </Card>
    </>
  );
}
