# Issue tracker: GitHub

项目规格、PRD 和开发任务均发布到 GitHub Issues，并使用 `gh` CLI 操作。

## 约定

- 仓库由当前工作目录的 Git remote 自动确定。
- 创建、读取、评论、加标签和关闭 Issue 均通过 `gh issue` 完成。
- 当技能要求“发布到 issue tracker”时，创建 GitHub Issue。
- 当技能要求“读取相关任务”时，读取对应 Issue 的正文、评论和标签。
- 外部 Pull Request 默认不作为需求分诊入口。
- GitHub Issue 原生依赖可用时，任务之间使用原生 blocking dependency；否则在正文中使用 `Blocked by: #<number>`。

## 发布状态

完整且可以交给开发代理执行的规格或任务使用 `ready-for-agent` 标签。
