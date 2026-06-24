"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 渲染小律回复中的 Markdown 内容，支持 GFM（列表、粗体、代码块等）。
 * @param content - 待渲染的 Markdown 文本
 */
export function AgentMarkdown({ content }: { content: string }) {
  if (!content.trim()) return null;
  return (
    <div className="agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
