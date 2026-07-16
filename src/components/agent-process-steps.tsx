"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Activity, Check, ChevronDown, CircleAlert, HelpCircle, LoaderCircle, X } from "lucide-react";
import { shouldCollapseAgentProcess } from "@/lib/agent-conversation-ui";
import {
  buildAgentProcessStages,
  buildAgentProcessSummary,
  buildAgentProcessTimeline,
  completedAgentProcessCount,
  type AgentProcessStep,
} from "@/lib/agent-process-presentation";

export type { AgentProcessStep } from "@/lib/agent-process-presentation";

type AgentProcessStepsProps = {
  steps: AgentProcessStep[];
  /** 是否仍在执行中；执行中默认展开 */
  active?: boolean;
  /** 是否已开始流式正文；用于自动收成一行 */
  answerStarted?: boolean;
  /** 用户本轮是否手动展开过（为 true 时不自动收起） */
  userExpanded?: boolean;
  onUserExpandChange?: (expanded: boolean) => void;
};

/** 根据步骤状态返回图标，状态不会只依赖颜色表达。 */
function StatusIcon({ status }: { status: AgentProcessStep["status"] }) {
  if (status === "done") return <Check size={12} aria-hidden />;
  if (status === "failed") return <CircleAlert size={12} aria-hidden />;
  if (status === "cancelled") return <X size={12} aria-hidden />;
  if (status === "confirm") return <HelpCircle size={12} aria-hidden />;
  if (status === "pending") return <span className="agent-process-dot" aria-hidden />;
  return <LoaderCircle size={12} className="agent-process-spin" aria-hidden />;
}

function statusText(status: AgentProcessStep["status"]): string {
  if (status === "running") return "进行中";
  if (status === "failed") return "未完成";
  if (status === "cancelled") return "已停止";
  if (status === "confirm") return "待确认";
  if (status === "pending") return "等待中";
  return "已完成";
}

/** 判断步骤是否包含可展开的详情内容。 */
function hasStepDetail(step: AgentProcessStep): boolean {
  const detail = step.detail;
  if (!detail) return step.status === "confirm";
  return Boolean(
    detail.scope
    || detail.result
    || detail.judgment
    || detail.nextAction
    || detail.missingInformation?.length
    || detail.inputSummary
    || detail.inputPreview
    || detail.rawInputJson,
  );
}

function StepDetail({
  step,
  rawOpen,
  onRawToggle,
}: {
  step: AgentProcessStep;
  rawOpen: boolean;
  onRawToggle: () => void;
}) {
  return (
    <div className="agent-process-step-detail">
      <div className="agent-process-detail-block">
        {step.detail?.inputSummary && (
          <p><span className="agent-process-detail-label">调用参数：</span>{step.detail.inputSummary}</p>
        )}
        {step.detail?.inputPreview && <pre className="agent-process-kv">{step.detail.inputPreview}</pre>}
        {step.detail?.scope && <p><span className="agent-process-detail-label">检查范围：</span>{step.detail.scope.replace(/^检查范围：/, "")}</p>}
        {step.detail?.result && <p><span className="agent-process-detail-label">检查结果：</span>{step.detail.result.replace(/^检查结果：/, "")}</p>}
        {step.detail?.judgment && (
          <p>
            <span className="agent-process-detail-label">{step.status === "confirm" ? "为什么需要确认：" : "简短判断："}</span>
            {step.detail.judgment}
          </p>
        )}
        {!!step.detail?.missingInformation?.length && (
          <p><span className="agent-process-detail-label">缺失信息：</span>{step.detail.missingInformation.join("、")}</p>
        )}
        {step.detail?.nextAction && <p><span className="agent-process-detail-label">下一步：</span>{step.detail.nextAction}</p>}
        {step.status === "confirm" && !step.detail && (
          <p><span className="agent-process-detail-label">为什么需要确认：</span>需要你确认后才会继续处理。</p>
        )}
        {(step.detail?.rawInputJson || step.detail?.toolName) && (
          <div className="agent-process-raw">
            <button type="button" className="agent-process-raw-toggle" aria-expanded={rawOpen} onClick={onRawToggle}>
              {rawOpen ? "收起原始参数" : "查看原始参数"}
            </button>
            {rawOpen && (
              <>
                {step.detail.toolName && <code className="agent-process-tool-name">{step.detail.toolName}</code>}
                {step.detail.rawInputJson && <pre className="agent-process-json">{step.detail.rawInputJson}</pre>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 展示 Agent 处理过程：原始步骤按用户语义投影为阶段，真实工具调用仍按 toolCallId 一对一保留。
 */
export function AgentProcessSteps({
  steps,
  active = false,
  answerStarted = false,
  userExpanded = false,
  onUserExpandChange,
}: AgentProcessStepsProps) {
  const shouldAutoCollapse = shouldCollapseAgentProcess(answerStarted, userExpanded);
  const stages = buildAgentProcessStages(steps);
  const timeline = buildAgentProcessTimeline(steps);
  const activeStage = stages.find((stage) => stage.status === "running");
  // 容器状态取用户语义阶段的当前投影，不能被已经恢复的历史失败污染。
  const awaitingConfirm = stages.some((stage) => stage.status === "confirm");
  const hasFailure = stages.some((stage) => stage.status === "failed");
  const [collapsed, setCollapsed] = useState(shouldAutoCollapse);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [rawOpenStepId, setRawOpenStepId] = useState<string | null>(null);

  useEffect(() => {
    let frame: number | undefined;
    if (active && !answerStarted) {
      frame = window.requestAnimationFrame(() => setCollapsed(false));
      return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); };
    }
    if (shouldAutoCollapse) frame = window.requestAnimationFrame(() => setCollapsed(true));
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); };
  }, [active, answerStarted, shouldAutoCollapse]);

  if (!steps.length) return null;

  const completedCount = completedAgentProcessCount(steps);
  const summary = buildAgentProcessSummary(steps, active);
  const headerTitle = collapsed
    ? `已完成 ${completedCount} 个动作`
    : activeStage
      ? `正在${activeStage.label}`
      : "处理过程";
  const headerStatus = active ? "进行中" : hasFailure ? "需要处理" : awaitingConfirm ? "等待确认" : "已完成";

  function toggleCollapsed() {
    const nextCollapsed = !collapsed;
    setCollapsed(nextCollapsed);
    if (!nextCollapsed) onUserExpandChange?.(true);
  }

  function toggleStep(stepId: string) {
    const nextExpanded = expandedStepId === stepId ? null : stepId;
    setExpandedStepId(nextExpanded);
    if (nextExpanded) onUserExpandChange?.(true);
  }

  function renderStep(step: AgentProcessStep) {
    const expanded = expandedStepId === step.id;
    const showDetail = hasStepDetail(step);
    const rawOpen = rawOpenStepId === step.id;
    return (
      <li key={step.id} className={clsx("agent-process-tool", step.status, expanded && "expanded")}>
        <button
          type="button"
          className="agent-process-tool-head"
          aria-expanded={showDetail ? expanded : undefined}
          disabled={!showDetail}
          onClick={() => toggleStep(step.id)}
        >
          <span className={clsx("agent-process-tool-icon", step.status)} aria-hidden><StatusIcon status={step.status} /></span>
          <span className="agent-process-tool-copy">
            <strong>{step.label}</strong>
            {(step.summary || step.detail?.inputSummary) && <span>{step.summary || step.detail?.inputSummary}</span>}
          </span>
          <span className="agent-process-tool-state">{statusText(step.status)}</span>
          {showDetail && <ChevronDown size={12} className={clsx("agent-process-step-chevron", expanded && "open")} />}
        </button>
        {expanded && showDetail && (
          <StepDetail
            step={step}
            rawOpen={rawOpen}
            onRawToggle={() => {
              const nextRawOpen = rawOpen ? null : step.id;
              setRawOpenStepId(nextRawOpen);
              if (nextRawOpen) onUserExpandChange?.(true);
            }}
          />
        )}
      </li>
    );
  }

  return (
    <section
      className={clsx("agent-process", active && "active", !collapsed && "open", awaitingConfirm && "awaiting-confirm", hasFailure && "has-failure")}
      aria-label="小律处理过程"
    >
      <button type="button" className="agent-process-toggle" aria-expanded={!collapsed} onClick={toggleCollapsed}>
        <span className="agent-process-title">
          <span className="agent-process-spark" aria-hidden><Activity size={14} /></span>
          <span className="agent-process-heading"><strong>{headerTitle}</strong><span>{summary}</span></span>
        </span>
        <span className="agent-process-meta">
          <i className="agent-process-status-dot" aria-hidden />
          <span>{headerStatus}</span>
          <ChevronDown size={14} className={clsx("agent-process-chevron", !collapsed && "open")} />
        </span>
      </button>

      {!collapsed && (
        <ol className="agent-process-tools agent-process-timeline" aria-live="polite">
          {timeline.map((step) => renderStep(step))}
        </ol>
      )}
    </section>
  );
}
