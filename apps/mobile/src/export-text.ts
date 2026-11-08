import { Share } from 'react-native';
export async function exportText(name: string, text: string, _type = 'text/plain') {
  await Share.share({ title: name, message: text });
}
