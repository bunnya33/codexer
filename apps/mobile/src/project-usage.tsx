import { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import type { ProjectUsage as Usage, ThreadUsage as ChatUsage } from '../../../packages/protocol/src/index';
import { estimateProjectCost, pricingDate, pricingSource, projectUsageLabel, threadUsageLabel, usdLabel } from '../../../packages/client-shared/src/project-usage';
import { useTheme } from './styles';

export function ProjectUsage({ usage }: { usage?: Usage }) { return <UsageSummary scope="project" usage={usage} />; }
export function ThreadUsage({ usage }: { usage?: ChatUsage }) { return <UsageSummary scope="thread" usage={usage} />; }
function UsageSummary({ scope, usage }: { scope: 'project' | 'thread'; usage?: Usage | ChatUsage }) {
  const { c, s } = useTheme();
  const [open, setOpen] = useState(false);
  const cost = usage ? estimateProjectCost(usage) : undefined;
  const project = scope === 'project';
  const name = project ? '项目' : '会话';
  const label = project ? projectUsageLabel(usage as Usage | undefined) : threadUsageLabel(usage as ChatUsage | undefined);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`${name}用量详情，${label}`} onPress={() => setOpen(true)} style={{ minWidth: 0, flexShrink: 1 }}>
      <Text testID={`${scope}-usage-summary`} style={{ color: c.muted, fontSize: 11, lineHeight: 17 }} numberOfLines={2}>{label}</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, backgroundColor: '#0005' }}>
        <Pressable accessibilityLabel={`关闭${name}用量`} onPress={() => setOpen(false)} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
        <View testID={`${scope}-usage-dialog`} accessibilityViewIsModal style={{ width: '100%', maxWidth: 480, maxHeight: '80%', backgroundColor: c.surface, borderRadius: 16, padding: 20, gap: 14 }}>
          <Text style={{ color: c.text, fontSize: 17, fontWeight: '600' }}>{name}累计用量</Text>
          <ScrollView contentContainerStyle={{ gap: 12 }}>
            {usage ? <>
              <Text selectable style={s.sub}>累计 {usage.totalTokens.toLocaleString()} Token{project && 'knownThreads' in usage ? ` · ${usage.knownThreads}/${usage.totalThreads} 个会话有累计计数（含已归档会话）` : ''}</Text>
              <Text style={s.sub}>{project ? '当前设备、当前项目的全部目录会话，不随会话展示数量或搜索结果变化。' : '只统计当前设备的当前会话，不包含同项目其他会话。支持会话统计的 Agent 会包含未展开的历史轮次。'}累计计数随电脑同步更新。</Text>
              <Text style={s.sub}>{cost?.pricedTokens ? `${cost.partial ? '已记录部分' : 'Token'}预估 ${usdLabel(cost.usd, project ? 2 : 4)}，可计价 ${cost.pricedTokens.toLocaleString()} Token。` : '尚无可计价的模型明细。'}{project && 'knownThreads' in usage && usage.knownThreads < usage.totalThreads || !project && 'totalKnown' in usage && !usage.totalKnown ? '累计计数不完整，当前 Token 为已知下限。' : ''}{!!cost?.unpricedTokens && `另有 ${cost.unpricedTokens.toLocaleString()} Token 缺少可计价明细。`}</Text>
              {usage.models.map((model, index) => <Text key={`${model.model}:${index}`} selectable style={s.sub}>{model.model ?? '模型未知'} · 输入 {model.inputTokens.toLocaleString()} · 缓存命中 {model.cachedInputTokens.toLocaleString()} · 输出 {model.outputTokens.toLocaleString()}</Text>)}
            </> : <Text style={s.sub}>等待电脑同步{name}统计，需要支持{name}用量统计的 PC Agent。</Text>}
            <Text style={s.sub}>按 OpenAI 官方 API 标准速度、短上下文单价估算，缓存命中单独计价，推理 Token 已包含在输出中。不是订阅扣款或实际账单；未计速度、长上下文、地区、工具费用与折扣。历史模型未知或缓存写入时长不明的用量不计价。</Text>
            <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(pricingSource)}><Text style={{ color: c.accent, fontSize: 12 }}>官方单价 · {pricingDate}</Text></Pressable>
          </ScrollView>
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={s.smallPrimary}><Text style={s.primaryText}>关闭</Text></Pressable>
        </View>
      </View>
    </Modal>
  </>;
}
