import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as Clipboard from 'expo-clipboard';
import { Alert } from 'react-native';

const credentialKey = 'codexer.mobile.relay.v1';
export const readCredentials = () => SecureStore.getItemAsync(credentialKey);
export const saveCredentials = (value: string) => SecureStore.setItemAsync(credentialKey, value);
export const clearCredentials = () => SecureStore.deleteItemAsync(credentialKey);
export const randomId = () => Crypto.randomUUID();
export const defaultRelayUrl = () => '';
export const copyText = async (value: string) => { await Clipboard.setStringAsync(value); };
export const confirmAction = (title: string, message: string): Promise<boolean> => new Promise(resolve => Alert.alert(title, message, [{ text: '取消', style: 'cancel', onPress: () => resolve(false) }, { text: '确认', style: 'destructive', onPress: () => resolve(true) }], { cancelable: true, onDismiss: () => resolve(false) }));
