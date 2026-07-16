/**
 * 最终回复开始后是否应自动收起处理过程。
 * 用户手动展开过后，始终尊重用户选择。
 */
export function shouldCollapseAgentProcess(answerStarted: boolean, userExpanded: boolean): boolean {
  return answerStarted && !userExpanded;
}

/**
 * 生成新建对话完成后的单条反馈，避免多个 toast 相互覆盖。
 */
export function newConversationNotice(hadRun: boolean, hadChangeSet: boolean): string {
  if (hadRun && hadChangeSet) return "已停止当前处理，并放弃待确认的变更草案";
  if (hadRun) return "已停止当前处理";
  if (hadChangeSet) return "已放弃待确认的变更草案";
  return "已开始新对话";
}
