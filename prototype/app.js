const agentPanel = document.getElementById("agentPanel");
const agentFab = document.getElementById("agentFab");
const closeAgent = document.getElementById("closeAgent");
const toggleAgentFullscreen = document.getElementById("toggleAgentFullscreen");
const toggleSkillMenu = document.getElementById("toggleSkillMenu");
const agentSkills = document.querySelector(".agent-skills");

if (agentFab && agentPanel) {
  agentFab.addEventListener("click", () => {
    agentPanel.classList.add("open");
  });
}

if (closeAgent && agentPanel) {
  closeAgent.addEventListener("click", () => {
    agentPanel.classList.remove("open", "fullscreen");
    if (agentSkills) agentSkills.classList.remove("open");
    if (toggleAgentFullscreen) {
      toggleAgentFullscreen.textContent = "□";
      toggleAgentFullscreen.title = "全屏";
    }
  });
}

if (toggleAgentFullscreen && agentPanel) {
  toggleAgentFullscreen.addEventListener("click", () => {
    agentPanel.classList.toggle("fullscreen");
    const full = agentPanel.classList.contains("fullscreen");
    toggleAgentFullscreen.textContent = full ? "↙" : "□";
    toggleAgentFullscreen.title = full ? "退出全屏" : "全屏";
  });
}

if (toggleSkillMenu && agentSkills) {
  toggleSkillMenu.addEventListener("click", () => {
    agentSkills.classList.toggle("open");
  });
}

const clearContext = document.getElementById("clearContext");
if (clearContext) {
  clearContext.addEventListener("click", () => {
    const body = document.querySelector(".agent-body");
    if (!body) return;
    const divider = document.createElement("div");
    divider.className = "context-divider";
    divider.textContent = "上下文已清空，后续对话从当前页面重新开始";
    body.appendChild(divider);
    body.scrollTop = body.scrollHeight;
  });
}

document.querySelectorAll("[data-tab-group]").forEach((group) => {
  group.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.tabTarget;
      group.querySelectorAll("[data-tab-target]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      document.querySelectorAll(`[data-tab-panel="${group.dataset.tabGroup}"]`).forEach((panel) => {
        panel.hidden = panel.id !== target;
      });
      scrollCurrentTimeIntoView();
    });
  });
});

function scrollCurrentTimeIntoView() {
  const line = document.querySelector(".current-time-line");
  if (!line) return;
  const shell = line.closest(".timeline-shell");
  if (!shell || shell.offsetParent === null) return;
  const preferredTop = line.offsetTop - shell.clientHeight * 0.38;
  shell.scrollTop = Math.max(0, preferredTop);
}

requestAnimationFrame(scrollCurrentTimeIntoView);

const drawer = document.getElementById("drawer");
const drawerBackdrop = document.getElementById("drawerBackdrop");
const closeDrawer = document.getElementById("closeDrawer");
const drawerData = {
  code: {
    title: "设计日程块数据结构",
    meta: "今天 10:00-11:30 / 计划型任务",
    goal: "Rhythm & Routine MVP",
    task: "设计日程块数据结构",
    status: "已完成",
    planned: "90m",
    actual: "85m",
    reason: "无",
    feedback: "顺畅；上午高专注任务推进顺利。"
  },
  review: {
    title: "整理 MVP 页面结构反馈",
    meta: "今天 15:00-15:45 / 回顾任务",
    goal: "产品设计文档",
    task: "整理页面结构反馈",
    status: "已完成",
    planned: "45m",
    actual: "50m",
    reason: "范围略扩大",
    feedback: "中专注；适合下午做收尾。"
  },
  gym: {
    title: "Push 训练",
    meta: "今天 19:00-20:15 / Routine 执行",
    goal: "健身目标",
    task: "完成本周 Push 训练",
    status: "等待执行反馈",
    planned: "75m",
    actual: "待填写",
    reason: "待填写",
    feedback: "待填写"
  }
};

function openDrawer(kind) {
  if (!drawer || !drawerBackdrop) return;
  const data = drawerData[kind] || drawerData.code;
  document.getElementById("drawerTitle").textContent = data.title;
  document.getElementById("drawerMeta").textContent = data.meta;
  document.getElementById("drawerGoal").textContent = data.goal;
  document.getElementById("drawerTask").textContent = data.task;
  document.getElementById("drawerStatus").textContent = data.status;
  document.getElementById("drawerPlanned").textContent = data.planned;
  document.getElementById("drawerActual").textContent = data.actual;
  document.getElementById("drawerReason").textContent = data.reason;
  document.getElementById("drawerFeedback").textContent = data.feedback;
  drawer.classList.add("open");
  drawerBackdrop.classList.add("open");
}

function hideDrawer() {
  if (!drawer || !drawerBackdrop) return;
  drawer.classList.remove("open");
  drawerBackdrop.classList.remove("open");
}

document.querySelectorAll("[data-open-drawer]").forEach((button) => {
  button.addEventListener("click", () => openDrawer(button.dataset.openDrawer));
});

if (drawerBackdrop) drawerBackdrop.addEventListener("click", hideDrawer);
if (closeDrawer) closeDrawer.addEventListener("click", hideDrawer);
