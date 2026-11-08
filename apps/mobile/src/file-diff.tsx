import { ScrollView, Text, View } from 'react-native';
import { numberedDiffLines } from '../../../packages/client-shared/src/diff';
import { DrawerSwipeBlock } from './drawer-swipe-block';
import { useTheme } from './styles';

export function FileDiff({ diff, path, fullHeight = false }: { diff: string; path: string; fullHeight?: boolean }) {
  const { s } = useTheme();
  return <DrawerSwipeBlock><ScrollView nestedScrollEnabled style={[s.diffViewport, fullHeight && {maxHeight: undefined}]} accessibilityLabel={`${path} 文件差异`}>
    <ScrollView horizontal nestedScrollEnabled contentContainerStyle={s.diffRows}>
      {numberedDiffLines(diff).map((line, index) => <View key={index} style={[s.diffLine, {flexDirection:"row"}, line.kind === 'addition' && s.diffAddedLine, line.kind === 'deletion' && s.diffDeletedLine, line.kind === 'hunk' && s.diffHunkLine]}>
        <Text selectable={false} style={[s.diffText, {width:42,textAlign:"right",paddingRight:10,opacity:.45}]}>{line.oldLine ?? ""}</Text><Text selectable={false} style={[s.diffText, {width:42,textAlign:"right",paddingRight:10,opacity:.45}]}>{line.newLine ?? ""}</Text><Text selectable style={[s.diffText, line.kind === 'addition' && s.diffAddedText, line.kind === 'deletion' && s.diffDeletedText, (line.kind === 'metadata' || line.kind === 'hunk') && s.diffMetaText]}>{line.text || '\u00a0'}</Text>
      </View>)}
    </ScrollView>
  </ScrollView></DrawerSwipeBlock>;
}
