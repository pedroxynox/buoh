import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_500Medium } from '@expo-google-fonts/manrope/500Medium';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold';
import { GLOBAL_STATUS } from '@buoh/prototype-data';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { TABS, type TabId } from './model';
import { AlertasScreen, EvidenciaScreen, InicioScreen, MasScreen, SenalesScreen } from './screens';
import { font, size, space, theme, TOUCH } from './theme';
import { BuohMark, FictitiousDataNotice, HealthBadge, Icon, ModeBadge } from './ui';

function TopBar() {
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <BuohMark dimension={28} />
          <Text style={{ fontFamily: font.bold, fontSize: size.xl, color: theme.text.primary }}>
            buoh
          </Text>
        </View>
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

function BottomBar({
  current,
  onSelect,
}: {
  readonly current: TabId;
  readonly onSelect: (tab: TabId) => void;
}) {
  return (
    <View
      role="tablist"
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

export default function App() {
  const [tab, setTab] = useState<TabId>('inicio');
  const [loaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    JetBrainsMono_500Medium,
  });
  if (!loaded) {
    return <View style={{ flex: 1, backgroundColor: theme.bg.canvas }} />;
  }
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg.canvas }} edges={['top', 'bottom']}>
        <TopBar />
        <ScrollView
          key={tab}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        >
          {tab === 'inicio' ? <InicioScreen onNavigate={setTab} /> : null}
          {tab === 'senales' ? <SenalesScreen /> : null}
          {tab === 'alertas' ? <AlertasScreen /> : null}
          {tab === 'evidencia' ? <EvidenciaScreen /> : null}
          {tab === 'mas' ? <MasScreen /> : null}
        </ScrollView>
        <BottomBar current={tab} onSelect={setTab} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
