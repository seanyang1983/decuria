# Decuria 使用指南

> 三个臭皮匠，不是把答案简单拼在一起，而是让不同模型先独立思考，再由指挥模型形成可执行结论。

Decuria 是 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的独立 Dashboard 插件。它面向已经使用多个模型、多个 Provider 或多个消息渠道的用户，重点解决“配置分散、模型太多、关键问题缺少交叉审视”三个问题。

## 适合谁

- 同时运营微信、Telegram、飞书、Discord 等 Hermes 渠道。
- 接入多个官方 API、兼容接口、私有部署或自定义 Provider。
- 希望控制模型清单，而不是把所有模型都塞进下拉框。
- 希望让多个模型从产品、技术、商业、风控等不同角度会商。
- 需要在 Dashboard 与通讯端之间复用同一套专家阵容。

## 四个页面

### 通道配置

![通道配置](screenshots/channel-config.png)

这里管理：

- Hermes 全局默认模型。
- 每个消息渠道的 model、provider 与 Key 覆盖。
- 图片生成、视觉识别、视频生成候补模型。
- 一次批量保存，避免逐项修改配置文件。

模型下拉只显示“模型管理”中已开启的模型；当前正在使用的模型会保留，防止配置断链。

### 模型管理

![模型管理](screenshots/model-management.png)

模型按 Provider 分组。新 Provider 默认使用“全部关闭”策略，即使以后刷新发现了新模型，也不会自动开放。你可以：

1. 搜索模型或筛选免费模型。
2. 只打开实际需要的模型。
3. 点击刷新重新探测 Provider 的最新模型清单。
4. 为指定 Provider 单独开启或关闭代理。

### Provider 管理

![Provider 管理](screenshots/provider-management.png)

可以新增或编辑兼容 OpenAI 风格接口、自定义 Base URL 和多个 API Key。最近新增或编辑的 Provider 会置顶，便于继续配置；普通 API 响应只返回 Key 预览。

### 智囊团

![智囊团圆桌](screenshots/moa-roundtable.png)

从左侧模型席拖动模型到专家席与指挥席，即可组成圆桌。专家并行独立分析，指挥模型读取各方意见并输出最终结论。

## 选择会商模式

- **单轮会商**：所有专家各回答一次，再由指挥汇总。适合快速比较和日常咨询。
- **多轮辩证**：选择 2–5 轮，后续轮次会看到上一轮观点并继续质疑、修正。
- **高共识提前结束**：开启后，在非最后一轮由裁判模型判断是否已收敛；高共识时提前停止。

辩证设置保存在 active profile 的 Decuria 状态中。Dashboard 明确关闭时，通讯端也会保持单轮，不会再回退到 preset 后意外开启多轮。

## 安装

### 1. 克隆插件

从下方仓库地址克隆（当前为私有仓库 `seanyang1983/decuria`；若你 fork 或改名，请相应调整地址）。

macOS / Linux：

```bash
git clone https://github.com/seanyang1983/decuria.git ~/.hermes/plugins/decuria
```

Windows PowerShell：

```powershell
git clone https://github.com/seanyang1983/decuria.git "$HOME\.hermes\plugins\decuria"
```

### 2. 启用插件

编辑当前 profile 的 `config.yaml`：

```yaml
plugins:
  enabled:
    - decuria
```

### 3. 重启服务

```bash
hermes gateway restart
hermes dashboard
```

打开 Dashboard 后，从侧栏进入“三个臭皮匠”。如果使用命名 profile，请确认启用配置和 Provider 凭据位于同一个 active profile。

## 首次配置建议

1. 在 **Provider 管理**中确认需要使用的 Provider 与凭据。
2. 在 **模型管理**中刷新模型目录，只开启实际需要的模型。
3. 在 **通道配置**中设置全局模型、各渠道覆盖和候补模型。
4. 在 **智囊团**中放置至少 1 位专家和 1 位指挥模型。
5. 先用单轮会商验证阵容，再按任务价值决定是否开启多轮辩证。

新增 Provider 后，其模型默认关闭。这是有意的安全默认：先确认模型，再开放给通道和智囊团。

## Dashboard 使用

### 通道配置

先选 Provider，再选该 Provider 下已开启的模型和 Key。保存全部配置后，运行中的 Gateway 需要重启才能采用新的通道路由。

### 模型刷新

“刷新”会启动一次 single-flight 模型目录更新：重复请求复用同一代刷新结果，模型管理与智囊团缓存同步更新。刷新不会自动打开新模型。

### 组建智囊团

1. 从模型席拖入专家席；建议给专家分配不同视角。
2. 拖入指挥模型；它负责综合而不是简单投票。
3. 选择“单轮会商”或“多轮辩证”。
4. 多轮模式下选择 2–5 轮，并决定是否开启高共识提前结束。
5. 在下方输入问题。执行会调用真实模型并产生相应费用。

高价值任务可使用角色提示，例如“事实核查”“安全反方”“成本审计”“用户体验”。差异化视角通常比堆叠同类模型更有价值。

## 通讯端调用

只有通过 Hermes allowlist/pairing 授权的渠道用户会触发 Decuria。支持：

- `智囊团 请从产品、技术、商业三个角度评估这个方案`
- `MoA 帮我比较 A 和 B 的风险`
- `专家团 为这份计划做反方审查`
- `智囊团[方案名] 分析这个问题`

完整触发词：`智囊团`、`智囊`、`moa`、`专家团`、`专家圆桌`、`混合智能`、`mixture of agents`。

通讯端使用当前圆桌模型与辩证状态。渠道任务全局并发上限为 2；同一用户与会话的重复请求会收到忙碌提示。只发送触发词、不附问题时，机器人会返回用法提示。

## 成本控制

假设有 N 位专家、R 轮辩证，每轮至少包含 N 次专家调用和 1 次指挥调用；自动停止判断与最终共识报告还可能产生额外调用。因此：

- 普通咨询优先单轮。
- 重要决策从 2 轮开始。
- 开启高共识提前结束，避免已经收敛后继续消耗。
- 不要为了“更多模型”牺牲专家角色差异。

Decuria 不替你决定 API 预算；它让调用模式和成本影响更清楚。

## 数据、安全与 profile

运行时数据位于：

```text
<HERMES_HOME>/data/decuria/
├── visibility.json
├── provider_state.json
├── provider_keys.json
├── model_universe.json
├── moa_models.json
├── orchestrator_state.json
├── proxy.json
├── moa_chats/
└── generated/
```

- 不同 Hermes profile 使用各自的 `HERMES_HOME`，状态和凭据互不混用。
- 旧版本留在插件目录的状态会安全迁移；已有目标文件不会被覆盖。
- Key 默认脱敏，显式查看接口要求 Dashboard 认证且使用 `Cache-Control: no-store`。
- 外部请求限制目标地址、重定向与响应体积，避免 SSRF 和无界下载。
- 状态文件使用临时文件、`fsync` 与原子替换，降低并发和中断风险。

不要把 `provider_keys.json`、代理配置、聊天记录或生成媒体提交到 Git。若凭据曾进入截图、日志或历史提交，请在服务商后台轮换，而不是只删除本地文件。

## 常见问题

**新增 Provider 后为什么看不到模型？**
进入“模型管理”点击刷新，然后手动开启需要的模型。新模型默认关闭是设计行为。

**通道保存后为什么尚未生效？**
通道配置写入 `config.yaml` 后，需要重启运行中的 Gateway。

**Dashboard 已关闭辩证，通讯端会不会继续多轮？**
不会。显式 `debate_enabled=false` 和 `debate_rounds=1` 优先于 preset；只有旧状态完全缺少辩证字段时才兼容性回退。

**为什么没有直接测试一次智囊团？**
智囊团会产生真实 Provider 调用和费用。发布验证应先使用语法、单元、API 状态与 UI 测试；真实模型烟测由用户明确决定。

**能否使用私有网络 Provider？**
默认安全策略会阻止特殊网络目标。只有经过显式允许的本地 Provider 主机才能访问，避免任意 URL 变成内网探测入口。

## 更多资料

- [GitHub 首页](../README.md)
- [安全策略](../SECURITY.md)
- [第三方资产说明](../THIRD_PARTY_NOTICES.md)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
