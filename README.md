# Decuria · 三个臭皮匠

> 把散落的模型、Provider 与消息渠道，变成一支随时可召集的 AI 智囊团。

Decuria 是 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的独立插件。它在一个 Dashboard 中完成模型路由、Provider 管理、模型可见性控制与多模型圆桌协作，不修改 Hermes core。

## 为什么需要 Decuria？

当模型越来越多，真正消耗时间的往往不是“问 AI”，而是管理 AI：

- 微信、Telegram、飞书等渠道想用不同模型，却要反复修改配置。
- Provider、Base URL、多个 API Key 分散，新增模型后还要手动核对。
- 模型列表越堆越长，真正会用的模型反而更难找到。
- 单个模型容易受盲区、偏见或幻觉影响，重要决策缺少交叉审视。
- 多模型讨论能提高质量，但手工复制问题、汇总答案既慢又贵。
- 某些 Provider 需要代理，另一些必须直连，全局代理无法精细控制。

Decuria 把这些问题收拢成四个页面：**一次配置、清晰可见、按需协作、渠道直达**。

## 你会得到什么

- **通道模型路由**：统一管理全局模型、各消息渠道和图片/视觉/视频候补模型。
- **模型管理**：Provider 分组、搜索、默认关闭、按需开启，并可强制刷新最新模型目录。
- **Provider 管理**：新增、编辑、禁用自定义 Provider，支持多个 Key 与 Provider 级代理。
- **AI 智囊团**：最多 8 位专家并行分析，由 1 位指挥模型综合裁决。
- **可控辩证**：单轮会商或 2–5 轮辩证；可在高共识时提前结束，减少无效调用。
- **通讯端召集**：已授权用户可直接在 Hermes 消息渠道中用自然语言启动智囊团。
- **本地与 profile 隔离**：运行时状态进入 active profile，不污染插件源码目录。

## 产品界面

### 1. 通道配置：每个入口，用最合适的模型

![通道配置](docs/screenshots/channel-config.png)

全局默认、消息渠道与多模态候补模型在同一页编辑；模型、Provider、Key 联动选择，批量保存减少漏配。

### 2. 模型管理：只让真正需要的模型进入视野

![模型管理](docs/screenshots/model-management.png)

新增 Provider 的模型默认全部关闭；你可以搜索、分组开启并强制刷新。新发现模型沿用默认关闭策略，不会再次淹没列表。

### 3. Provider 管理：兼容接口也能有完整管理体验

![Provider 管理](docs/screenshots/provider-management.png)

管理显示名称、slug、Base URL、多个 API Key、启用状态与代理路由。最近编辑的 Provider 自动置顶，普通接口不会回传原始 Key。

### 4. 智囊团：让模型相互补位，而不是只听一个答案

![智囊团圆桌](docs/screenshots/moa-roundtable.png)

把模型拖到专家席与指挥席即可组成圆桌：专家并行给出独立意见，指挥模型综合共识、分歧与建议。

```text
用户问题
  ├─ 专家 A：事实与证据
  ├─ 专家 B：风险与反例
  ├─ 专家 C：方案与落地
  └─ 更多专家（可选）
          ↓
      指挥模型综合
          ↓
  最终答案 / 共识报告
```

**单轮会商**适合日常分析，调用更少；**多轮辩证**适合重要方案，支持 2–5 轮并可在高共识时提前结束。界面会明确提示多轮模式会增加模型调用与 Token 消耗。

## 快速安装

> 仓库地址：`https://github.com/seanyang1983/decuria`（当前为私有仓库）。若你 fork 或改名，请相应调整下方克隆地址。

macOS / Linux：

```bash
git clone https://github.com/seanyang1983/decuria.git ~/.hermes/plugins/decuria
```

Windows PowerShell：

```powershell
git clone https://github.com/seanyang1983/decuria.git "$HOME\.hermes\plugins\decuria"
```

在 active profile 的 `config.yaml` 中启用：

```yaml
plugins:
  enabled:
    - decuria
```

重启正在运行的 Gateway；需要 Dashboard 时启动：

```bash
hermes gateway restart
hermes dashboard
```

打开 Dashboard 后，在侧栏进入“**三个臭皮匠**”。详细步骤见 [完整使用指南](docs/INTRO.md)。

## 5 分钟上手

1. 在 **Provider 管理**确认 Provider 与凭据。
2. 在 **模型管理**刷新目录，只开启准备使用的模型。
3. 在 **通道配置**设置全局、渠道与多模态候补模型。
4. 在 **智囊团**拖入专家和指挥，选择单轮或多轮。
5. 在 Dashboard 提问，或从已授权的消息渠道直接召集。

## 在通讯端调用

Decuria 仅拦截 Hermes 已授权/配对用户的消息。可用触发词（英文不区分大小写）：

`智囊团` · `智囊` · `MoA` · `专家团` · `专家圆桌` · `混合智能` · `mixture of agents`

直接提问：

```text
智囊团 请从产品、技术、商业三个角度评估这个方案
MoA 帮我比较 A 和 B 的风险、收益与实施成本
专家圆桌 为这次发布做一次反方审查
```

指定组合方案：

```text
智囊团[方案名] 分析这个问题
```

通讯端与 Dashboard 共享圆桌模型和辩证设置；同时最多执行 2 个渠道任务，同一会话的重复请求会收到忙碌提示。多轮辩证可能显著增加模型调用量，请按任务价值使用。

## 安全与隐私

- API Key 默认只返回不可逆预览；仅在已认证的编辑操作中显式回填，并禁止缓存。
- Provider 普通响应不返回原始 Key，短 Key 也不会在 preview 中原样出现。
- 外部请求校验 URL、目标地址和每次重定向，认证请求禁止跨来源重定向。
- JSON、图片、视频与 Base64 解码均有体积上限。
- 配置与状态采用锁、临时文件、`fsync` 和原子替换。
- 渠道触发复用 Hermes allowlist/pairing 授权，不对未授权用户开放。
- 运行时数据位于 `<HERMES_HOME>/data/decuria/`，不同 profile 相互隔离。

如果任何 Key 曾出现在日志、截图、提交历史或不受控副本中，请立即在服务商后台轮换。安全报告流程见 [SECURITY.md](SECURITY.md)。

## 开发与验证

```bash
python -m py_compile state_paths.py security_utils.py __init__.py moa_core.py moa_trigger.py media_tools.py dashboard/plugin_api.py
python -m unittest discover -s tests -v
node --check dashboard/dist/index.js
```

前端为无需构建的 Preact IIFE；后端修改后需重启 Dashboard/Gateway。插件 API 挂载在 `/api/plugins/decuria`。

## License

[MIT License](LICENSE) · 第三方资产说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。品牌名称与商标归各自权利人所有。