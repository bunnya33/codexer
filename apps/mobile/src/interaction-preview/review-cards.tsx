import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ListChecks,
  Maximize2,
  Pencil,
  ShieldCheck,
} from "lucide-react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useTheme } from "../styles";
import { Markdown } from "../markdown";
import { ChromeButton } from "../interaction/primitives";
import { useInteractionMotion } from "../interaction/motion";
import { exportPreviewText } from "./preview-export";
import { planBody, planTitle, reviewQuestions } from "./review-fixtures";
import type { ReviewCondition } from "./review-fixtures";

export type QuestionAnswers = {
  choices: Record<string, number>;
  text: Record<string, string>;
  sent: string[];
};
export const emptyAnswers = (): QuestionAnswers => ({ choices: {}, text: {}, sent: [] });

export function QuestionReviewCard({
  answers,
  onChange,
  mode,
  condition,
  onAnswered,
}: {
  answers: QuestionAnswers;
  onChange: (value: QuestionAnswers) => void;
  mode: "batch" | "async";
  condition: ReviewCondition;
  onAnswered: () => void;
}) {
  const { c } = useTheme(),
    motion = useInteractionMotion();
  const [page, setPage] = useState(0),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const fade = useRef(new Animated.Value(1)).current,
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    failed = useRef(false);
  const latest = useRef(answers);
  latest.current = answers;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    failed.current = false;
    setError("");
  }, [condition]);
  const question = reviewQuestions[page]!;
  const value = (id: string, state = answers) =>
    state.choices[id] === -1
      ? (state.text[id]?.trim() ?? "")
      : (reviewQuestions.find((q) => q.id === id)?.options[state.choices[id] ?? -2]?.label ?? "");
  const complete = reviewQuestions.every((q) => answers.sent.includes(q.id));
  const disabled = pending || condition === "offline" || condition === "expired" || complete;
  const submitted = answers.sent.includes(question.id);
  const changePage = (next: number) => {
    fade.setValue(motion ? 0 : 1);
    setPage(next);
    Animated.timing(fade, {
      toValue: 1,
      duration: motion ? 170 : 0,
      useNativeDriver: Platform.OS !== "web",
    }).start();
  };
  const submit = (state: QuestionAnswers, ids: string[]) => {
    if (disabled || !ids.every((id) => value(id, state))) return;
    setPending(true);
    setError("");
    timer.current = setTimeout(() => {
      setPending(false);
      if (condition === "failure" && !failed.current) {
        failed.current = true;
        setError("提交失败，答案已保留。请重试。");
        return;
      }
      const next = { ...latest.current, sent: [...new Set([...latest.current.sent, ...ids])] };
      onChange(next);
      if (reviewQuestions.every((q) => next.sent.includes(q.id))) onAnswered();
      else if (mode === "async") changePage(Math.min(page + 1, reviewQuestions.length - 1));
    }, 260);
  };
  const choose = (index: number) => {
    const next = { ...answers, choices: { ...answers.choices, [question.id]: index } };
    onChange(next);
    if (mode === "async" && index >= 0) submit(next, [question.id]);
  };
  return (
    <View testID="review-question-card" style={[s.question, { backgroundColor: c.composer }]}>
      <View style={s.pager}>
        <ChromeButton
          Icon={ChevronLeft}
          label="上一题"
          size={17}
          disabled={page === 0 || pending}
          onPress={() => changePage(page - 1)}
        />
        <Text style={{ color: c.muted, fontSize: 12 }}>
          {page + 1}/{reviewQuestions.length}
        </Text>
        <ChromeButton
          Icon={ChevronRight}
          label="下一题"
          size={17}
          disabled={page === reviewQuestions.length - 1 || pending}
          onPress={() => changePage(page + 1)}
        />
        <View style={{ flex: 1 }} />
        <Text style={{ color: complete ? c.success : c.faint, fontSize: 11 }}>
          {complete ? "已回答" : mode === "async" ? "逐题回答" : "回答问题"}
        </Text>
      </View>
      {complete ? (
        <View style={{ gap: 14, paddingVertical: 14 }}>
          <Check size={24} color={c.success} />
          <Text style={{ color: c.text, fontSize: 16, fontWeight: "600" }}>回答已提交</Text>
          {reviewQuestions.map((q) => (
            <View key={q.id}>
              <Text style={{ color: c.muted, fontSize: 12 }}>{q.question}</Text>
              <Text style={{ color: c.text, fontSize: 14, marginTop: 5 }}>{value(q.id)}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Animated.View style={{ opacity: fade }}>
          <Text style={{ color: c.faint, fontSize: 11, marginTop: 4 }}>{question.header}</Text>
          <Text accessibilityRole="header" style={[s.questionTitle, { color: c.text }]}>
            {question.question}
          </Text>
          {question.options.map((option, index) => (
            <Pressable
              key={option.label}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              aria-checked={answers.choices[question.id] === index}
              accessibilityState={{
                checked: answers.choices[question.id] === index,
                disabled: disabled || submitted,
              }}
              disabled={disabled || submitted}
              onPress={() => choose(index)}
              style={[
                s.option,
                {
                  backgroundColor:
                    answers.choices[question.id] === index ? c.surface : "transparent",
                  opacity: disabled && !pending ? 0.65 : 1,
                },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontSize: 14, lineHeight: 22 }}>{option.label}</Text>
                <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18, marginTop: 3 }}>
                  {option.description}
                </Text>
              </View>
              {answers.choices[question.id] === index && <Check size={17} color={c.text} />}
            </Pressable>
          ))}
          <View
            style={[
              s.answer,
              {
                borderColor: answers.choices[question.id] === -1 ? c.accent : "transparent",
                backgroundColor: answers.choices[question.id] === -1 ? c.surface : "transparent",
              },
            ]}
          >
            <Pencil size={13} color={c.faint} />
            <TextInput
              accessibilityLabel={`自定义回答：${question.header}`}
              value={answers.text[question.id] ?? ""}
              onFocus={() => {
                if (!disabled && !submitted) choose(-1);
              }}
              onChangeText={(text) =>
                onChange({
                  ...answers,
                  choices: { ...answers.choices, [question.id]: -1 },
                  text: { ...answers.text, [question.id]: text },
                })
              }
              editable={!disabled && !submitted}
              maxLength={8192}
              multiline
              placeholder="请提供其他答案"
              placeholderTextColor={c.faint}
              style={{
                flex: 1,
                color: c.text,
                fontSize: 13,
                lineHeight: 20,
                minHeight: 38,
                maxHeight: 110,
                paddingVertical: 9,
              }}
            />
          </View>
          {submitted ? (
            <Text style={{ color: c.success, fontSize: 12, paddingTop: 10 }}>本题已提交</Text>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 }}>
              <Text style={{ flex: 1, color: c.faint, fontSize: 11 }}>
                {mode === "batch" ? "所有答案确认后一起提交" : "选择选项后提交本题"}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  mode === "batch" && page < reviewQuestions.length - 1
                    ? "保存答案并下一题"
                    : "提交回答"
                }
                disabled={
                  disabled ||
                  !value(question.id) ||
                  (mode === "batch" &&
                    page === reviewQuestions.length - 1 &&
                    !reviewQuestions.every((q) => value(q.id)))
                }
                onPress={() =>
                  mode === "batch" && page < reviewQuestions.length - 1
                    ? changePage(page + 1)
                    : submit(
                        answers,
                        mode === "batch" ? reviewQuestions.map((q) => q.id) : [question.id],
                      )
                }
                style={[
                  s.smallAction,
                  {
                    backgroundColor: c.text,
                    opacity:
                      disabled ||
                      !value(question.id) ||
                      (mode === "batch" &&
                        page === reviewQuestions.length - 1 &&
                        !reviewQuestions.every((q) => value(q.id)))
                        ? 0.3
                        : 1,
                  },
                ]}
              >
                <Text style={{ color: c.surface, fontSize: 12 }}>
                  {pending
                    ? "提交中…"
                    : mode === "batch" && page < reviewQuestions.length - 1
                      ? "下一题"
                      : "提交"}
                </Text>
              </Pressable>
            </View>
          )}
        </Animated.View>
      )}
      {condition === "offline" && (
        <Text accessibilityRole="alert" style={[s.status, { color: c.taskRunning }]}>
          设备离线，答案保留，连接恢复后可提交。
        </Text>
      )}
      {condition === "expired" && (
        <Text accessibilityRole="alert" style={[s.status, { color: c.muted }]}>
          该问题已在电脑端处理，无法再次提交。
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={[s.status, { color: c.danger }]}>
          {error}
        </Text>
      )}
    </View>
  );
}

export function PlanReviewCard({
  onOpen,
  onCopy,
  onExport,
  onPrepare,
  prepared,
}: {
  onOpen: () => void;
  onCopy: () => void;
  onExport: () => void;
  onPrepare: () => void;
  prepared: boolean;
}) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 12 }}>
      <View style={[s.plan, { backgroundColor: c.composer }]}>
        <View style={s.pager}>
          <ListChecks size={16} color={c.muted} />
          <Text style={{ flex: 1, color: c.muted, fontSize: 12 }}>计划</Text>
          <ChromeButton Icon={Download} label="下载计划" onPress={onExport} size={17} />
          <ChromeButton Icon={Copy} label="复制计划" onPress={onCopy} size={17} />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="展开完整计划"
          onPress={onOpen}
          style={{ maxHeight: 190, overflow: "hidden" }}
        >
          <Text
            style={{
              color: c.text,
              fontSize: 17,
              fontWeight: "600",
              lineHeight: 25,
              marginBottom: 8,
            }}
          >
            {planTitle}
          </Text>
          <Text style={{ color: c.text, fontSize: 14, lineHeight: 23 }}>
            将旅行照片放在界面中心，保留轻巧、清晰的操作入口。优先完善手机阅读体验，再适配宽屏。
          </Text>
          <Text style={{ color: c.text, fontSize: 14, fontWeight: "600", marginTop: 18 }}>
            画面与布局
          </Text>
          <Text style={{ color: c.text, fontSize: 13, lineHeight: 22, marginTop: 7 }}>
            • 照片采用 4:3 卡片，标题与拍摄地点放在下方。{"\n"}• 亮色与深色使用一致的视觉层次。
          </Text>
          <Svg
            pointerEvents="none"
            width="100%"
            height={55}
            style={{ position: "absolute", bottom: 0 }}
          >
            <Defs>
              <LinearGradient id="plan-fade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={c.composer} stopOpacity={0} />
                <Stop offset="1" stopColor={c.composer} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#plan-fade)" />
          </Svg>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="阅读全文"
          onPress={onOpen}
          style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingTop: 5 }}
        >
          <Text style={{ flex: 1, color: c.muted, fontSize: 12 }}>阅读全文</Text>
          <Maximize2 size={14} color={c.muted} />
        </Pressable>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="执行此方案"
        onPress={onPrepare}
        style={[s.prepare, { borderColor: c.line }]}
      >
        <ListChecks size={15} color={c.text} />
        <Text style={{ color: c.text, fontSize: 13 }}>
          {prepared ? "查看待发送的执行指令" : "执行此方案"}
        </Text>
        <ArrowUp size={14} color={c.muted} />
      </Pressable>
    </View>
  );
}

export function PlanReviewReader({
  onCopy,
  onPrepare,
  onNotice,
}: {
  onCopy: () => void;
  onPrepare: () => void;
  onNotice: (message: string) => void;
}) {
  const { c } = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <View style={[s.readerActions, { borderBottomColor: c.line }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="复制完整计划"
          onPress={onCopy}
          style={s.textAction}
        >
          <Copy size={16} color={c.text} />
          <Text style={{ color: c.text, fontSize: 12 }}>复制</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="保存完整计划"
          onPress={() =>
            void exportPreviewText("旅行相册-交互方案.md", planBody, "text/markdown").catch(() =>
              onNotice("保存失败，请重试"),
            )
          }
          style={s.textAction}
        >
          <Download size={16} color={c.text} />
          <Text style={{ color: c.text, fontSize: 12 }}>保存</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="将计划执行指令放入草稿"
          onPress={onPrepare}
          style={[s.smallAction, { backgroundColor: c.soft }]}
        >
          <Text style={{ color: c.accent, fontSize: 12 }}>执行此方案</Text>
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 13, paddingVertical: 12, paddingBottom: 35 }}
      >
        <Markdown>{planBody}</Markdown>
      </ScrollView>
    </View>
  );
}

export function ApprovalReviewCard({ condition }: { condition: ReviewCondition }) {
  const { c } = useTheme();
  const [decision, setDecision] = useState<string>(),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    failed = useRef(false);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const act = (value: string) => {
    setPending(true);
    setError("");
    timer.current = setTimeout(() => {
      setPending(false);
      if (condition === "failure" && !failed.current) {
        failed.current = true;
        setError("未能提交，请重试。");
      } else setDecision(value);
    }, 260);
  };
  const disabled = pending || !!decision || condition === "offline" || condition === "expired";
  return (
    <View style={[s.question, { backgroundColor: c.composer }]}>
      <ShieldCheck size={22} color={c.text} />
      <Text style={[s.questionTitle, { color: c.text }]}>允许执行这条命令？</Text>
      <Text style={{ color: c.muted, fontSize: 13, lineHeight: 21 }}>
        检查相册页面的生产构建，确认布局修改能够正常打包。
      </Text>
      <View
        style={{ backgroundColor: c.surface, borderRadius: 10, padding: 14, marginVertical: 16 }}
      >
        <Text selectable style={{ color: c.text, fontFamily: "monospace", fontSize: 13 }}>
          npm run build
        </Text>
        <Text style={{ color: c.muted, fontSize: 11, marginTop: 8 }}>
          旅行相册 · F:\\projects\\travel-album
        </Text>
      </View>
      {decision ? (
        <Text style={{ color: c.success, fontSize: 13 }}>{decision}，等待任务状态更新。</Text>
      ) : (
        <View style={{ flexDirection: "row", gap: 9 }}>
          {["允许一次", "拒绝"].map((label, index) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => act(label)}
              style={[
                s.smallAction,
                { backgroundColor: index === 0 ? c.text : c.surface, opacity: disabled ? 0.4 : 1 },
              ]}
            >
              <Text style={{ color: index === 0 ? c.surface : c.text, fontSize: 13 }}>
                {pending ? "提交中…" : label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {condition === "offline" && (
        <Text style={[s.status, { color: c.taskRunning }]}>设备离线，恢复连接后可处理。</Text>
      )}
      {condition === "expired" && (
        <Text style={[s.status, { color: c.muted }]}>此请求已被处理。</Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={[s.status, { color: c.danger }]}>
          {error}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  question: { borderRadius: 20, padding: 18, minHeight: 310 },
  pager: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: -9,
    marginLeft: -11,
    marginRight: -9,
  },
  questionTitle: {
    fontSize: 17,
    lineHeight: 25,
    fontWeight: "600",
    marginTop: 10,
    marginBottom: 15,
  },
  option: {
    paddingHorizontal: 10,
    paddingVertical: 13,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: -8,
    marginBottom: 3,
  },
  answer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 10,
    marginHorizontal: -8,
    marginTop: 20,
    borderRadius: 12,
    borderWidth: 1,
  },
  smallAction: {
    minHeight: 36,
    paddingHorizontal: 15,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  status: { fontSize: 12, lineHeight: 19, marginTop: 12 },
  plan: { borderRadius: 20, padding: 17 },
  prepare: {
    alignSelf: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderWidth: 1,
    paddingHorizontal: 14,
    minHeight: 40,
    borderRadius: 22,
  },
  readerActions: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingHorizontal: 9,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  textAction: { flexDirection: "row", gap: 6, alignItems: "center", minHeight: 38 },
});
