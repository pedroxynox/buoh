/**
 * Piezas visuales del prototipo móvil. Reproducen en React Native los componentes web del sistema de
 * diseño, con los mismos tokens, iconos y presentaciones de estado.
 */
import {
  EXECUTION_MODE_PRESENTATION,
  ICONS,
  palette,
  SERVICE_HEALTH_PRESENTATION,
  SEVERITY_PRESENTATION,
  type EvidenceSource,
  type IconName,
  type PerformanceContext,
  type Severity,
  type StatusPresentation,
  type Tone,
} from '@buoh/design-system';
import type { ExecutionMode, ServiceHealth } from '@buoh/contracts';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { corner, font, size, space, theme, withAlpha } from './theme';

export function Icon({
  name,
  color = theme.text.secondary,
  dimension = 20,
}: {
  readonly name: IconName;
  readonly color?: string;
  readonly dimension?: number;
}) {
  return (
    <Svg width={dimension} height={dimension} viewBox="0 0 24 24" aria-hidden>
      {ICONS[name].map((d) => (
        <Path
          key={d}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

const HEAD = 'M10 14 13 5l7 6q4-1 8 0l7-6 3 9q4 8 1.5 17Q36 43 24 44 12 43 8.5 31 6 22 10 14Z';
const BEAK = 'M24 31.2 26 34l-2 3.2-2-3.2Z';

/** Símbolo de buoh, con la misma geometría que el SVG de la web. */
export function BuohMark({ dimension = 28 }: { readonly dimension?: number }) {
  const ring = theme.brand.eyeRing;
  const iris = palette.ambar[400];
  return (
    <Svg width={dimension} height={dimension} viewBox="0 0 48 48" aria-hidden>
      <Path d={HEAD} fill={theme.brand.head} />
      <Circle cx={18} cy={25} r={6.6} fill={ring} />
      <Circle cx={30} cy={25} r={6.6} fill={ring} />
      <Circle cx={18} cy={25} r={4.6} fill={iris} />
      <Circle cx={30} cy={25} r={4.6} fill={iris} />
      <Circle cx={18.6} cy={25.4} r={2} fill={ring} />
      <Circle cx={30.6} cy={25.4} r={2} fill={ring} />
      <Path d={BEAK} fill={iris} />
    </Svg>
  );
}

export function Badge({
  tone = 'niebla',
  icon,
  label,
  detail,
  strong = false,
  accessibleLabel,
}: {
  readonly tone?: Tone;
  readonly icon?: IconName;
  readonly label: string;
  readonly detail?: string;
  readonly strong?: boolean;
  readonly accessibleLabel?: string;
}) {
  const colors = theme.tones[tone];
  return (
    <View
      aria-label={accessibleLabel ?? (detail === undefined ? label : `${label}. ${detail}`)}
      style={[
        styles.badge,
        {
          backgroundColor: colors.bg,
          borderColor: strong ? colors.fg : withAlpha(colors.fg, 0.4),
          borderWidth: strong ? 1.5 : 1,
        },
      ]}
    >
      {icon === undefined ? null : <Icon name={icon} color={colors.fg} dimension={14} />}
      <Text style={[styles.badgeText, { color: colors.fg }]}>
        {label}
        {detail === undefined ? null : <Text style={styles.badgeDetail}>{` · ${detail}`}</Text>}
      </Text>
    </View>
  );
}

function StatusBadge({
  axis,
  presentation,
  showDescription,
  strong = false,
}: {
  readonly axis: string;
  readonly presentation: StatusPresentation;
  readonly showDescription: boolean;
  readonly strong?: boolean;
}) {
  return (
    <Badge
      tone={presentation.tone}
      icon={presentation.icon}
      label={presentation.label}
      {...(showDescription ? { detail: presentation.description } : {})}
      strong={strong}
      accessibleLabel={`${axis}: ${presentation.label}. ${presentation.description}`}
    />
  );
}

export function ModeBadge({
  mode,
  showDescription = false,
}: {
  readonly mode: ExecutionMode;
  readonly showDescription?: boolean;
}) {
  return (
    <StatusBadge
      axis="Modo"
      presentation={EXECUTION_MODE_PRESENTATION[mode]}
      showDescription={showDescription}
      strong={mode === 'real'}
    />
  );
}

export function HealthBadge({
  health,
  showDescription = false,
}: {
  readonly health: ServiceHealth;
  readonly showDescription?: boolean;
}) {
  return (
    <StatusBadge
      axis="Salud"
      presentation={SERVICE_HEALTH_PRESENTATION[health]}
      showDescription={showDescription}
    />
  );
}

export function SeverityTag({ severity }: { readonly severity: Severity }) {
  return (
    <StatusBadge
      axis="Severidad"
      presentation={SEVERITY_PRESENTATION[severity]}
      showDescription={false}
      strong={severity === 'critical'}
    />
  );
}

export function EvidenceSourceBadge({ source }: { readonly source: EvidenceSource }) {
  return source === 'backtest' ? (
    <Badge tone="niebla" icon="flask" label="Backtest" accessibleLabel="Origen: backtest" />
  ) : (
    <ModeBadge mode={source} />
  );
}

/** Aviso fijo del prototipo, en estilo neutro para no confundirse con un estado. */
export function FictitiousDataNotice() {
  return (
    <View style={styles.notice} role="note" aria-label="Datos ficticios">
      <Icon name="document" dimension={14} />
      <Text style={styles.noticeText}>Datos ficticios</Text>
    </View>
  );
}

export function Card({
  title,
  subtitle,
  children,
}: {
  readonly title?: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      {title === undefined ? null : (
        <Text style={styles.cardTitle} role="heading" aria-level={2}>
          {title}
        </Text>
      )}
      {subtitle === undefined ? null : <Text style={styles.muted}>{subtitle}</Text>}
      <View style={styles.cardBody}>{children}</View>
    </View>
  );
}

/** Función de una fase posterior: se ve, pero no tiene controles. */
export function PhaseLock({
  phase,
  title,
  description,
}: {
  readonly phase: string;
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <View style={styles.lock} role="note">
      <View style={styles.row}>
        <Icon name="lock" color={theme.text.primary} dimension={16} />
        <Text style={styles.lockTitle}>{`${title} · Disponible en Fase ${phase}`}</Text>
      </View>
      {description === undefined ? null : <Text style={styles.secondary}>{description}</Text>}
    </View>
  );
}

const CONTEXT_ROWS: readonly (readonly [
  string,
  keyof Omit<PerformanceContext, 'source' | 'limitations'>,
])[] = [
  ['Período', 'period'],
  ['Muestra', 'sample'],
  ['Costes', 'costs'],
  ['Pérdidas', 'losses'],
  ['Drawdown máximo', 'drawdown'],
  ['Versión', 'version'],
];

/** Cifra de desempeño con su contexto completo; los tipos impiden omitir campos. */
export function MetricWithContext({
  label,
  value,
  context,
}: {
  readonly label: string;
  readonly value: string;
  readonly context: PerformanceContext;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      <View style={styles.metricContext}>
        <View style={styles.contextRow}>
          <Text style={styles.contextTerm}>Origen</Text>
          <EvidenceSourceBadge source={context.source} />
        </View>
        {CONTEXT_ROWS.map(([term, key]) => (
          <View key={term} style={styles.contextRow}>
            <Text style={styles.contextTerm}>{term}</Text>
            <Text style={styles.contextValue}>{context[key]}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.secondary}>
        <Text style={styles.strong}>Limitaciones: </Text>
        {context.limitations}
      </Text>
    </View>
  );
}

export function SectionTitle({ children }: { readonly children: string }) {
  return (
    <Text style={styles.sectionTitle} role="heading" aria-level={2}>
      {children}
    </Text>
  );
}

export function ListRow({ children }: { readonly children: ReactNode }) {
  return <View style={styles.listRow}>{children}</View>;
}

export const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space[2], flexWrap: 'wrap' },
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: corner.pill,
    maxWidth: '100%',
  },
  badgeText: { fontFamily: font.semibold, fontSize: size.xs, flexShrink: 1 },
  badgeDetail: { fontFamily: font.regular },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: corner.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.border.strong,
  },
  noticeText: { fontFamily: font.semibold, fontSize: size.xs, color: theme.text.secondary },
  card: {
    backgroundColor: theme.bg.surface,
    borderColor: theme.border.subtle,
    borderWidth: 1,
    borderRadius: corner.lg,
    padding: space[5],
    gap: space[1],
  },
  cardTitle: { fontFamily: font.bold, fontSize: size.lg, color: theme.text.primary },
  cardBody: { marginTop: space[3], gap: space[3] },
  muted: { fontFamily: font.regular, fontSize: size.sm, color: theme.text.muted },
  secondary: {
    fontFamily: font.regular,
    fontSize: size.sm,
    color: theme.text.secondary,
    lineHeight: 20,
  },
  body: {
    fontFamily: font.regular,
    fontSize: size.base,
    color: theme.text.primary,
    lineHeight: 22,
  },
  strong: { fontFamily: font.semibold, color: theme.text.primary },
  mono: { fontFamily: font.mono, color: theme.text.primary },
  lock: {
    gap: space[2],
    padding: space[4],
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.border.strong,
    borderRadius: corner.md,
    backgroundColor: theme.bg.sunken,
  },
  lockTitle: {
    fontFamily: font.semibold,
    fontSize: size.sm,
    color: theme.text.primary,
    flexShrink: 1,
  },
  metric: { gap: space[3] },
  metricLabel: { fontFamily: font.semibold, fontSize: size.sm, color: theme.text.secondary },
  metricValue: { fontFamily: font.mono, fontSize: size.xxxl, color: theme.text.primary },
  metricContext: {
    gap: space[2],
    paddingTop: space[3],
    borderTopWidth: 1,
    borderTopColor: theme.border.subtle,
  },
  contextRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space[3],
    alignItems: 'flex-start',
  },
  contextTerm: { fontFamily: font.regular, fontSize: size.xs, color: theme.text.muted, width: 110 },
  contextValue: {
    fontFamily: font.regular,
    fontSize: size.sm,
    color: theme.text.primary,
    flex: 1,
    textAlign: 'right',
  },
  sectionTitle: {
    fontFamily: font.bold,
    fontSize: size.xl,
    color: theme.text.primary,
    marginTop: space[3],
  },
  listRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space[3],
    paddingVertical: space[3],
    borderTopWidth: 1,
    borderTopColor: theme.border.subtle,
  },
});
