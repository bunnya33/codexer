import { ScrollView, Text, View } from 'react-native';
import { diffLines } from '../../../packages/client-shared/src/diff';
import { DrawerSwipeBlock } from './drawer-swipe-block';
import { s } from './styles';

export function FileDiff({ diff, path }: { diff: string; path: string }) {
  return <DrawerSwipeBlock><ScrollView nestedScrollEnabled style={s.diffViewport} accessibilityLabel={`${path} 文件差异`}>
    <ScrollView horizontal nestedScrollEnabled contentContainerStyle={s.diffRows}>
      {diffLines(diff).map((line, index) => <View key={index} style={[s.diffLine, line.kind === 'addition' && s.diffAddedLine, line.kind === 'deletion' && s.diffDeletedLine, line.kind === 'hunk' && s.diffHunkLine]}>
        <Text selectable style={[s.diffText, line.kind === 'addition' && s.diffAddedText, line.kind === 'deletion' && s.diffDeletedText, (line.kind === 'metadata' || line.kind === 'hunk') && s.diffMetaText]}>{line.text || '\u00a0'}</Text>
      </View>)}
    </ScrollView>
  </ScrollView></DrawerSwipeBlock>;
}
