"use client";

import { useState } from "react";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import type { ToolStepDetail } from "@/agent/tool-labels";

/** 单条处理步骤的状态。 */
export type AgentProcessStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "confirm";
  summary?: string;
  detail?: ToolStepDetail;
};

type AgentProcessStepsProps = {
  steps: AgentProcessStep[];
  /** 是否仍在执行中；执行中默认展开 */
  active?: boolean;
  /** 初始是否收起；完成后较长回复时建议收起 */
  defaultCollapsed?: boolean;
};

/**
 * 统计已完成步骤数量（含失败与待确认）。
 * @param steps - 处理步骤列表
 */
function completedCount(steps: AgentProcessStep[]): number {
  return steps.filter((step) => step.status === "done" || step.status === "failed" || step.status === "confirm").length;
}

/**
 * 根据步骤状态返回对应图标字符。
 * @param status - 步骤状态
 */
function statusIcon(status: AgentProcessStep["status"]): string {
  if (status === "done") return "✓";
  if (status === "failed") return "!";
  if (status === "confirm") return "?";
  if (status === "pending") return "○";
  return "●";
}

/**
 * 展示 Agent 处理过程的轻量区域：默认简洁，可收起，每步可展开详情。
 * @param props.steps - 处理步骤列表
 * @param props.active - 是否仍在执行
 * @param props.defaultCollapsed - 完成后是否默认收起
 */
export function AgentProcessSteps({ steps, active = false, defaultCollapsed = false }: AgentProcessStepsProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed && !active);

  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  if (!steps.length) return null;
  const doneCount = completedCount(steps);
  const statusLabel = active ? "处理中" : `已完成 ${doneCount} 步`;

  return (
    <div className={clsx("agent-process", active && "active")}>
      <button
        type="button"
        className="agent-process-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span className="agent-process-title">处理过程</span>
        <span className="agent-process-meta">{statusLabel}</span>
        <ChevronDown size={12} className={clsx("agent-process-chevron", !collapsed && "open")} />
      </button>

      {!collapsed && (
        <ul className="agent-process-steps">
          {steps.map((step) => {
            const expanded = expandedStepId === step.id;
            const hasDetail = Boolean(step.detail && (step.detail.scope || step.detail.result || step.detail.judgment || step.detail.nextAction));
            return (
              <li key={step.id} className={clsx("agent-process-step", step.status, expanded && "expanded")}>
                <button
                  type="button"
                  className="agent-process-step-head"
                  aria-expanded={expanded}
                  disabled={!hasDetail}
                  onClick={() => setExpandedStepId(expanded ? null : step.id)}
                >
                  <span className={clsx("agent-process-icon", step.status)} aria-hidden>
                    {step.status === "running" ? <i /> : statusIcon(step.status)}
                  </span>
                  <span className="agent-process-step-body">
                    <span className="agent-process-step-label">{step.label}</span>
                    {step.summary && <span className="agent-process-step-summary">{step.summary}</span>}
                  </span>
                  {hasDetail && <ChevronDown size={11} className={clsx("agent-process-step-chevron", expanded && "open")} />}
                </button>
                {expanded && hasDetail && step.detail && (
                  <div className="agent-process-step-detail">
                    {step.detail.scope && <p><strong>检查范围</strong>{step.detail.scope.replace(/^检查范围：/, "")}</p>}
                    {step.detail.result && <p><strong>检查结果</strong>{step.detail.result.replace(/^检查结果：/, "")}</p>}
                    {step.detail.judgment && <p><strong>简短判断</strong>{step.detail.judgment}</p>}
                    {step.detail.nextAction && <p><strong>下一步</strong>{step.detail.nextAction}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
