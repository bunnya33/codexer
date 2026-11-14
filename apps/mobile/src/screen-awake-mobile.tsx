import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { Check, Minus, Plus } from 'lucide-react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as FileSystem from 'expo-file-system/legacy';
import { useTheme } from './styles';

type Preferences = { enabled: boolean; minutes: number | null };
type ScreenAwakeState = {
  preferences: Preferences; setPreferences: (value: Preferences) => void;
  expired: boolean; restart: () => void; error: string;
};
const defaults: Preferences = { enabled: true, minutes: null };
const tag = 'frogcoder.screen-awake';
const storageUri = () => {
  if (!FileSystem.documentDirectory) throw new Error('storage-unavailable');
  return FileSystem.documentDirectory + 'screen-awake-v1.json';
};
function normalize(value: unknown): Preferences {
  const saved = value && typeof value === 'object' ? value as Partial<Preferences> : {};
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
    minutes: typeof saved.minutes === 'number' && Number.isFinite(saved.minutes)
      ? Math.max(1, Math.min(30, Math.round(saved.minutes))) : null,
  };
}
async function readPreferences(): Promise<Preferences> {
  try { return normalize(JSON.parse(await FileSystem.readAsStringAsync(storageUri()))); }
  catch { return defaults; }
}
const Context = createContext<ScreenAwakeState | null>(null);
export const screenAwakeAvailable = true;

export function ScreenAwakeProvider({ children }: { children: ReactNode }) {
  const [preferences, setValue] = useState(defaults), [ready, setReady] = useState(false);
  const [phase, setPhase] = useState(AppState.currentState);
  const [expired, setExpired] = useState(false), [session, setSession] = useState(0);
  const [storageError, setStorageError] = useState(''), [nativeError, setNativeError] = useState('');
  const revision = useRef(0), writes = useRef(Promise.resolve()), operations = useRef(Promise.resolve());
  const mounted = useRef(false), desired = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void readPreferences().then(value => {
      if (!mounted.current) return;
      if (!revision.current) setValue(value);
      setReady(true);
    });
    const listener = AppState.addEventListener('change', setPhase);
    return () => { mounted.current = false; listener.remove(); };
  }, []);
  const request = useMemo(() => (active: boolean) => {
    desired.current = active;
    // Serialize native calls so an activation still in flight cannot undo a
    // later timeout, disabled preference or transition into the background.
    operations.current = operations.current.then(async () => {
      if (desired.current !== active) return;
      try {
        if (active) await activateKeepAwakeAsync(tag);
        else await deactivateKeepAwake(tag);
        if (mounted.current && desired.current === active) setNativeError('');
      } catch {
        if (mounted.current && desired.current === active) setNativeError(active
          ? '无法保持屏幕常亮，请关闭后重试。' : '恢复自动锁屏失败，请退出 App 后重试。');
      }
    });
  }, []);
  useEffect(() => {
    setExpired(false);
    if (!ready || !preferences.enabled || phase !== 'active') {
      request(false);
      return;
    }
    request(true);
    const timer = preferences.minutes === null ? undefined : setTimeout(() => {
      setExpired(true);
      request(false);
    }, preferences.minutes * 60_000);
    return () => { clearTimeout(timer); request(false); };
  }, [ready, preferences.enabled, preferences.minutes, phase, session, request]);
  const value = useMemo<ScreenAwakeState>(() => ({
    preferences, expired, error: storageError || nativeError,
    restart: () => setSession(value => value + 1),
    setPreferences: next => {
      const normalized = normalize(next), current = ++revision.current;
      setValue(normalized); setReady(true); setStorageError('');
      writes.current = writes.current.catch(() => {}).then(() => FileSystem.writeAsStringAsync(storageUri(), JSON.stringify(normalized)))
        .catch(() => { if (mounted.current && revision.current === current) setStorageError('设置已生效，但未能保存。请重新选择以重试。'); });
    },
  }), [preferences, expired, storageError, nativeError]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function ScreenAwakeSettings() {
  const state = useContext(Context), { c } = useTheme();
  const [minutes, setMinutes] = useState(state?.preferences.minutes ?? 10);
  useEffect(() => { setMinutes(state?.preferences.minutes ?? 10); }, [state?.preferences.minutes]);
  if (!state) return null;
  const { preferences, setPreferences, expired, restart, error } = state;
  const selectMinutes = (value: number) => {
    const next = Math.max(1, Math.min(30, Math.round(value)));
    setMinutes(next); setPreferences({ ...preferences, minutes: next });
  };
  const row = { minHeight: 54, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingHorizontal: 16 };
  return <View style={{ gap: 12 }}>
    <View style={{ borderRadius: 16, overflow: 'hidden', backgroundColor: c.surface }}>
      <View style={row}><Text style={{ flex: 1, color: c.text, fontSize: 15 }}>屏幕常亮</Text>
        <Switch accessibilityLabel="屏幕常亮" value={preferences.enabled} onValueChange={enabled => setPreferences({ ...preferences, enabled })} trackColor={{ true: c.accent }} />
      </View>
      {preferences.enabled && <View accessibilityRole="radiogroup" accessibilityLabel="常亮模式">
        {([{ label: '一直常亮', timed: false }, { label: '定时常亮', timed: true }]).map(option => {
          const selected = (preferences.minutes !== null) === option.timed;
          return <Pressable key={option.label} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: selected }}
            onPress={() => setPreferences({ ...preferences, minutes: option.timed ? minutes : null })}
            style={[row, { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.settingsLine }]}>
            <Text style={{ flex: 1, color: c.text, fontSize: 14 }}>{option.label}</Text>{selected && <Check size={18} color={c.accent} />}
          </Pressable>;
        })}
      </View>}
    </View>
    {preferences.enabled && preferences.minutes !== null && <View style={{ padding: 16, gap: 10, borderRadius: 16, backgroundColor: c.surface }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="减少常亮时间" disabled={minutes <= 1} onPress={() => selectMinutes(minutes - 1)} style={{ padding: 10, opacity: minutes <= 1 ? 0.35 : 1 }}><Minus size={20} color={c.text} /></Pressable>
        <Text accessibilityLabel={`常亮时长：${minutes} 分钟`} style={{ color: c.text, fontSize: 17, fontWeight: '600' }}>{minutes} 分钟</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="增加常亮时间" disabled={minutes >= 30} onPress={() => selectMinutes(minutes + 1)} style={{ padding: 10, opacity: minutes >= 30 ? 0.35 : 1 }}><Plus size={20} color={c.text} /></Pressable>
      </View>
      <Slider accessibilityLabel="常亮时间（分钟）" minimumValue={1} maximumValue={30} step={1} value={minutes}
        accessibilityValue={{ min: 1, max: 30, now: minutes, text: `${minutes} 分钟` }}
        onValueChange={setMinutes} onSlidingComplete={selectMinutes} minimumTrackTintColor={c.accent} style={{ width: '100%', height: 40 }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ color: c.muted, fontSize: 12 }}>1 分钟</Text><Text style={{ color: c.muted, fontSize: 12 }}>30 分钟</Text></View>
      {expired && <><Text style={{ color: c.muted, fontSize: 13 }}>本次常亮已结束，已恢复系统自动锁屏。</Text><Pressable accessibilityRole="button" onPress={restart} style={{ paddingVertical: 10 }}><Text style={{ color: c.accent, fontSize: 14 }}>重新计时</Text></Pressable></>}
    </View>}
    <Text style={{ color: c.muted, fontSize: 13, lineHeight: 20 }}>{!preferences.enabled ? '已跟随系统自动锁屏设置。' : preferences.minutes === null
      ? '在 App 前台使用时保持亮屏，切到后台后恢复系统自动锁屏。'
      : '每次回到 App 或修改常亮设置后重新计时，到期后恢复系统自动锁屏。'}</Text>
    {!!error && <Text accessibilityRole="alert" style={{ color: c.danger, fontSize: 13 }}>{error}</Text>}
  </View>;
}
