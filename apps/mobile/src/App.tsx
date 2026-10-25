import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import { Sen_400Regular } from '@expo-google-fonts/sen/400Regular';
import { Sen_500Medium } from '@expo-google-fonts/sen/500Medium';
import { Sen_600SemiBold } from '@expo-google-fonts/sen/600SemiBold';
import { Sen_700Bold } from '@expo-google-fonts/sen/700Bold';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { type TabId } from './model';
import { AlertasScreen, EvidenciaScreen, InicioScreen, MasScreen, SenalesScreen } from './screens';
import { BottomBar, TopBar } from './shell';
import { space, theme } from './theme';

export default function App() {
  const [tab, setTab] = useState<TabId>('inicio');
  const [loaded, error] = useFonts({
    Sen_400Regular,
    Sen_500Medium,
    Sen_600SemiBold,
    Sen_700Bold,
    JetBrainsMono_500Medium,
  });
  // Si las fuentes no cargan, la app se muestra igual con la letra del sistema.
  if (!loaded && error === null) {
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
          {tab === 'senales' ? <SenalesScreen onNavigate={setTab} /> : null}
          {tab === 'alertas' ? <AlertasScreen /> : null}
          {tab === 'evidencia' ? <EvidenciaScreen /> : null}
          {tab === 'mas' ? <MasScreen /> : null}
        </ScrollView>
        <BottomBar current={tab} onSelect={setTab} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
