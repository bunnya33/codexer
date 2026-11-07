import { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import type { ProjectUsage as Usage } from '../../../packages/protocol/src/index';
import { estimateProjectCost, pricingDate, pricingSource, projectUsageLabel, usdLabel } from '../../../packages/client-shared/src/project-usage';
import { useTheme } from './styles';

export function ProjectUsage({ usage }: { usage?: Usage }) {
  const { c, s } = useTheme();
  const [open, setOpen] = useState(false);
  const cost = usage ? estimateProjectCost(usage) : undefined;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`项目用量详情，${projectUsageLabel(usage)}`} onPress={() => setOpen(true)}>
      <Text testID="project-usage-summary" style={{ color: c.muted, fontSize: 11, lineHeight: 17 }} numberOfLines={2}>{projectUsageLabel(usage)}</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, backgroundColor: '#0005' }}>
        <Pressable accessibilityLabel="关闭项目用量" onPress={() => setOpen(false)} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
        <View testID="project-usage-dialog" accessibilityViewIsModal style={{ width: '100%', maxWidth: 480, maxHeight: '80%', backgroundColor: c.surface, borderRadius: 16, padding: 20, gap: 14 }}>
          <Text style={{ color: c.text, fontSize: 17, fontWeight: '600' }}>项目累计用量</Text>
          <ScrollView contentContainerStyle={{ gap: 12 }}>
            {usage ? <>
              <Text selectable style={s.sub}>累计 {usage.totalTokens.toLocaleString()} Token · {usage.knownThreads}/{usage.totalThreads} 个会话有累计计数（含已归档会话）</Text>
              <Text style={s.sub}>当前设备、当前项目的全部目录会话，不随会话展示数量或搜索结果变化。累计计数随电脑同步更新。</Text>
              <Text style={s.sub}>{cost?.pricedTokens ? `${cost.partial ? '已记录部分' : 'Token'}预估 ${usdLabel(cost.usd)}，可计价 ${cost.pricedTokens.toLocaleString()} Token。` : '尚无可计价的模型明细。'}{usage.knownThreads < usage.totalThreads ? '部分会话没有累计计数，当前 Token 为已知下限。' : ''}{!!cost?.unpricedTokens && `另有 ${cost.unpricedTokens.toLocaleString()} Token 缺少可计价明细。`}</Text>
              {usage.models.map((model, index) => <Text key={`${model.model}:${index}`} selectable style={s.sub}>{model.model ?? '模型未知'} · 输入 {model.inputTokens.toLocaleString()} · 缓存命中 {model.cachedInputTokens.toLocaleString()} · 输出 {model.outputTokens.toLocaleString()}</Text>)}
            </> : <Text style={s.sub}>等待电脑同步项目统计，需要支持项目用量统计的 PC Agent。</Text>}
            <Text style={s.sub}>按 OpenAI 官方 API 标准速度、短上下文单价估算，缓存命中单独计价，推理 Token 已包含在输出中。不是订阅扣款或实际账单；未计速度、长上下文、地区、工具费用与折扣。历史模型未知或缓存写入时长不明的用量不计价。</Text>
            <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(pricingSource)}><Text style={{ color: c.accent, fontSize: 12 }}>官方单价 · {pricingDate}</Text></Pressable>
          </ScrollView>
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={s.smallPrimary}><Text style={s.primaryText}>关闭</Text></Pressable>
        </View>
      </View>
    </Modal>
  </>;
}
