import { Share } from "react-native";
export async function exportPreviewText(name: string, text: string, _type = "text/plain") {
  await Share.share({ title: name, message: text });
}
