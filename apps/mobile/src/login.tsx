import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Terminal } from 'lucide-react-native';
import { useTheme } from './styles';
import { appDisplayName } from './branding';
import { defaultRelayUrl } from './runtime';
import { DownloadLibraryButton } from './download-library';

export function Login({ connect, busy, error }: { connect: (url: string, username: string, password: string) => void; busy: boolean; error: string }) {
  const { c, s, theme } = useTheme();
  const [url, setUrl] = useState(defaultRelayUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const scroller = useRef<ScrollView>(null), focused = useRef<TextInput | null>(null);
  const serverField = useRef<TextInput>(null), userField = useRef<TextInput>(null), passwordField = useRef<TextInput>(null);
  const keyboardVisible = useRef(Keyboard.isVisible());
  const reveal = useCallback(() => {
    if (!keyboardVisible.current || !focused.current) return;
    scroller.current?.scrollResponderScrollNativeHandleToKeyboard(focused.current, 20, true);
  }, []);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => { keyboardVisible.current = true; reveal(); });
    const hide = Keyboard.addListener('keyboardDidHide', () => { keyboardVisible.current = false; });
    return () => { show.remove(); hide.remove(); };
  }, [reveal]);
  const focus = (input: TextInput | null) => { focused.current = input; reveal(); };
  const relayUrl = Platform.OS === 'web' ? defaultRelayUrl() : url;
  return <SafeAreaView style={s.safe}><StatusBar style={theme.dark ? "light" : "dark"} />
    <KeyboardAvoidingView style={s.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView ref={scroller} onLayout={reveal} style={s.page} contentContainerStyle={[s.login, { flex: undefined, flexGrow: 1, paddingVertical: 24 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}>
    <View style={s.brandRow}>{['ios', 'android'].includes(Platform.OS) ? <Image source={require('../assets/frogcoder-icon.png')} accessibilityLabel={appDisplayName} style={{width: 42, height: 42, borderRadius: 7}} /> : <View style={s.brandMark}><Terminal size={24} color={c.onSolid} /></View>}<Text style={s.brand}>{appDisplayName}</Text></View>
    <Text style={s.heading}>账号登录</Text><Text style={s.sub}>登录后选择同账号的 PC Agent</Text>
    {Platform.OS !== 'web' && <><Text style={s.label}>服务器地址</Text><TextInput ref={serverField} onFocus={() => focus(serverField.current)} accessibilityLabel="服务器地址" style={s.field} value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://服务器地址:端口" placeholderTextColor={c.muted} /></>}
    <Text style={s.label}>账号</Text><TextInput ref={userField} onFocus={() => focus(userField.current)} accessibilityLabel="账号" style={s.field} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" placeholder="账号名称" placeholderTextColor={c.muted} />
    <Text style={s.label}>密码</Text><TextInput ref={passwordField} onFocus={() => focus(passwordField.current)} accessibilityLabel="密码" style={s.field} value={password} onChangeText={setPassword} autoCapitalize="none" autoCorrect={false} autoComplete="current-password" secureTextEntry placeholder="密码" placeholderTextColor={c.muted} />
    {!!error && <Text style={s.error}>{error}</Text>}
    <Pressable accessibilityRole="button" onPress={() => connect(relayUrl, username, password)} disabled={busy || !relayUrl.trim() || !username.trim() || !password} style={[s.primary, (busy || !relayUrl.trim() || !username.trim() || !password) && s.disabled]}>{busy ? <ActivityIndicator color={c.onAccent} /> : <Text style={s.primaryText}>登录</Text>}</Pressable>
    <DownloadLibraryButton />
    </ScrollView></KeyboardAvoidingView></SafeAreaView>;
}
