/**
 * Marco de la app: barra superior con el estado global y barra de pestañas. No carga fuentes, así que
 * las pruebas pueden renderizarlo sin Expo.
 */
import { GLOBAL_STATUS } from '@buoh/prototype-data';
import { Pressable, Text, View } from 'react-native';
import { TABS, type TabId } from './model';
import { font, size, space, theme, TOUCH } from './theme';
import { BuohLogo, FictitiousDataNotice, HealthBadge, Icon, ModeBadge } from './ui';

export function TopBar() {
  return (
    <View
      style={{
        gap: space[2],
        paddingHorizontal: space[4],
        paddingVertical: space[3],
        borderBottomWidth: 1,
        borderBottomColor: theme.border.subtle,
        backgroundColor: theme.bg.canvas,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <BuohLogo dimension={32} />
        <FictitiousDataNotice />
      </View>
      <View
        role="group"
        aria-label="Estado global"
        style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}
      >
        <ModeBadge mode={GLOBAL_STATUS.mode} />
        <HealthBadge health={GLOBAL_STATUS.health} />
      </View>
    </View>
  );
}

export function BottomBar({
  current,
  onSelect,
}: {
  readonly current: TabId;
  readonly onSelect: (tab: TabId) => void;
}) {
  return (
    <View
      role="tablist"
      aria-label="Secciones"
      style={{
        flexDirection: 'row',
        borderTopWidth: 1,
        borderTopColor: theme.border.subtle,
        backgroundColor: theme.bg.surface,
        paddingHorizontal: space[1],
        paddingTop: space[1],
      }}
    >
      {TABS.map((tab) => {
        const active = tab.id === current;
        const color = active ? theme.text.primary : theme.text.muted;
        return (
          <Pressable
            key={tab.id}
            role="tab"
            aria-selected={active}
            aria-label={tab.label}
            onPress={() => {
              onSelect(tab.id);
            }}
            style={{
              flex: 1,
              minHeight: TOUCH + 8,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              borderTopWidth: 2,
              borderTopColor: active ? theme.brand.accent : 'transparent',
            }}
          >
            <Icon name={tab.icon} color={color} dimension={22} />
            <Text
              style={{ fontFamily: active ? font.semibold : font.medium, fontSize: size.xs, color }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
