"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import type { ToolStepDetail } from "@/agent/tool-labels";

/** 单条处理步骤的状态。 */
export type AgentProcessStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "confirm";
  summary?: string;
  detail?: ToolStepDetail & { missingInformation?: string[] };
};

type AgentProcessStepsProps = {
  steps: AgentProcessStep[];
  /** 是否仍在执行中；执行中默认展开 */
  active?: boolean;
  /** 完成后是否默认收起 */
  defaultCollapsed?: boolean;
};

/**
 * 统计已完成步骤数量（不含待确认步骤）。
 * @param steps - 处理步骤列表
 */
function completedCount(steps: AgentProcessStep[]): number {
  return steps.filter((step) => step.status === "done" || step.status === "failed").length;
}

/**
 * 生成处理过程头部的状态摘要文案。
 * @param steps - 处理步骤列表
 * @param active - 是否仍在执行
 */
function buildStatusLabel(steps: AgentProcessStep[], active: boolean): string {
  const doneCount = completedCount(steps);
  const awaitingConfirm = steps.some((step) => step.status === "confirm");
  if (active) return "处理中";
  if (awaitingConfirm) return `已完成 ${doneCount} 步，等待确认`;
  return `已完成 ${doneCount} 步`;
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
 * 判断步骤是否包含可展开的详情内容。
 * @param step - 单条处理步骤
 */
function hasStepDetail(step: AgentProcessStep): boolean {
  const detail = step.detail;
  if (!detail) return step.status === "confirm";
  return Boolean(detail.scope || detail.result || detail.judgment || detail.nextAction || detail.missingInformation?.length);
}

/**
 * 展示 Agent 处理过程的轻量区域：位于回复气泡之前，执行中展开，完成后默认收起。
 * @param props.steps - 处理步骤列表
 * @param props.active - 是否仍在执行
 * @param props.defaultCollapsed - 完成后是否默认收起
 */
export function AgentProcessSteps({ steps, active = false, defaultCollapsed = false }: AgentProcessStepsProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed && !active);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  useEffect(() => {
    let frame: number | undefined;
    if (active) {
      frame = window.requestAnimationFrame(() => setCollapsed(false));
      return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); };
    }
    if (defaultCollapsed) frame = window.requestAnimationFrame(() => setCollapsed(true));
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); };
  }, [active, defaultCollapsed]);

  if (!steps.length) return null;

  const statusLabel = buildStatusLabel(steps, active);

  return (
    <div className={clsx("agent-process", active && "active", !collapsed && "open")}>
      <button
        type="button"
        className="agent-process-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span className="agent-process-title">
          <span className="agent-process-spark" aria-hidden>✦</span>
          处理过程
        </span>
        <span className="agent-process-meta">
          <span>{statusLabel}</span>
          <ChevronDown size={12} className={clsx("agent-process-chevron", !collapsed && "open")} />
        </span>
      </button>

      {!collapsed && (
        <ul className="agent-process-steps">
          {steps.map((step) => {
            const expanded = expandedStepId === step.id;
            const showDetail = hasStepDetail(step);
            return (
              <li key={step.id} className={clsx("agent-process-step", step.status, expanded && "expanded")}>
                <button
                  type="button"
                  className="agent-process-step-head"
                  aria-expanded={expanded}
                  disabled={!showDetail}
                  onClick={() => setExpandedStepId(expanded ? null : step.id)}
                >
                  <span className={clsx("agent-process-icon", step.status)} aria-hidden>
                    {step.status === "running" ? <i /> : statusIcon(step.status)}
                  </span>
                  <span className="agent-process-step-body">
                    <span className="agent-process-step-label">{step.label}</span>
                    {step.summary && <span className="agent-process-step-summary">{step.summary}</span>}
                  </span>
                  {showDetail && <ChevronDown size={11} className={clsx("agent-process-step-chevron", expanded && "open")} />}
                </button>
                {expanded && showDetail && step.detail && (
                  <div className="agent-process-step-detail">
                    <div className="agent-process-detail-block">
                      {step.detail.scope && <p><span className="agent-process-detail-label">检查范围：</span>{step.detail.scope.replace(/^检查范围：/, "")}</p>}
                      {step.detail.result && <p><span className="agent-process-detail-label">检查结果：</span>{step.detail.result.replace(/^检查结果：/, "")}</p>}
                      {step.detail.judgment && (
                        <p>
                          <span className="agent-process-detail-label">{step.status === "confirm" ? "为什么需要确认：" : "简短判断："}</span>
                          {step.detail.judgment}
                        </p>
                      )}
                      {!!step.detail.missingInformation?.length && <p><span className="agent-process-detail-label">缺失信息：</span>{step.detail.missingInformation.join("、")}</p>}
                      {step.detail.nextAction && <p><span className="agent-process-detail-label">下一步：</span>{step.detail.nextAction}</p>}
                    </div>
                  </div>
                )}
                {expanded && showDetail && !step.detail && step.status === "confirm" && (
                  <div className="agent-process-step-detail">
                    <div className="agent-process-detail-block">
                      <p><span className="agent-process-detail-label">为什么需要确认：</span>需要你确认后才会继续处理。</p>
                    </div>
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
