# Decuria · 三个臭皮匠

> 三个臭皮匠，顶个诸葛亮。
> 让多个 AI 互相补位、彼此质疑——把「问一个模型」升级成「开一场专家圆桌」。

Decuria 是 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的独立 Dashboard 插件。它把**通道模型路由、Provider 管理、模型可见性控制、多模型圆桌协作**收进一个面板，不改 Hermes 一行核心代码，装上即用。

---

## 模型越接越多，为什么反而更累？

当你接入的模型多起来，真正吃掉时间的往往不是「问 AI」，而是「管 AI」：

- **配置分散**：微信、飞书、Telegram 想各用一个模型，得反复翻 `config.yaml`，改一次、重启一次。
- **凭据零散**：Provider、Base URL、多个 API Key 散落各处，新增模型后还要手动核对哪个能用。
- **列表臃肿**：模型越堆越长，真正常用的那几个反而要翻半天才找得到。
- **单模型盲区**：再强的模型也有盲区、偏见和幻觉，可关键决策往往只听它一家之言。
- **协作又慢又贵**：想让几个模型交叉验证，只能手动复制问题、来回粘贴、人工汇总，费时又费 Token。
- **代理难精细**：有的 Provider 必须走代理、有的必须直连，全局代理一刀切根本不够用。

Decuria 把这些痛点收拢成四个页面：**一次配置、清晰可见、按需协作、渠道直达。**

---

## 四个页面，四类问题一次解决

### 1. 通道配置 · 每个入口，都用最合适的模型

![通道配置](docs/screenshots/channel-config.png)

全局默认模型、各消息渠道、图片 / 视觉 / 视频候补模型，全在一页里配置。模型、Provider、Key 三级联动选择，批量保存，从此告别手改配置文件、逐条重启。

### 2. 模型管理 · 只让真正需要的模型进入视野

![模型管理](docs/screenshots/model-management.png)

模型按 Provider 分组，可搜索、可只看免费模型。新增 Provider 的模型**默认全部关闭**——你只开自己要用的；日后刷新发现的新模型同样默认关闭，列表永远清爽不淹没。

### 3. Provider 管理 · 兼容接口，也有完整的管理体验

![Provider 管理](docs/screenshots/provider-management.png)

新增、编辑、启用 / 禁用任意 OpenAI 兼容 Provider，支持自定义 Base URL、**同一 Provider 挂多个 API Key**、以及**按 Provider 单独开关代理**。API Key 只回传不可逆预览，绝不下发明文。

### 4. 智囊团 · 让模型互相补位，而不是只听一个答案

![智囊团圆桌](docs/screenshots/moa-roundtable.png)

把模型拖进「专家席」和「指挥席」，就组成一张圆桌：**最多 8 位专家并行、各自独立作答，再由 1 位指挥模型综合共识、分歧与建议**，最后交付一份结论，并附带每个模型的用量总览。

```text
你的问题
  ├─ 专家 A：摆事实、找证据
  ├─ 专家 B：挑风险、提反例
  ├─ 专家 C：给方案、谈落地
  └─ 更多专家（最多 8 位）
          ↓
      指挥模型综合裁决
          ↓
   最终结论 / 共识报告
```

- **单轮会商**：专家各答一次、指挥汇总，适合日常分析，省时省钱。
- **多轮辩证**：2–5 轮，后续轮次能看到上一轮观点继续质疑与修正；开启「高共识提前结束」，一旦收敛就停，不浪费调用。

---

## 安装

> 仓库地址：`https://github.com/seanyang1983/decuria`

克隆到 Hermes 的插件目录：

```bash
# macOS / Linux
git clone https://github.com/seanyang1983/decuria.git ~/.hermes/plugins/decuria
```

```powershell
# Windows PowerShell
git clone https://github.com/seanyang1983/decuria.git "$HOME\.hermes\plugins\decuria"
```

在 active profile 的 `config.yaml` 中启用：

```yaml
plugins:
  enabled:
    - decuria
```

重启 Gateway，需要时启动 Dashboard：

```bash
hermes gateway restart
hermes dashboard
```

打开 Dashboard，在侧栏进入「**三个臭皮匠**」。完整步骤见 [使用指南](docs/INTRO.md)。

## 5 分钟上手

1. 在 **Provider 管理**确认 Provider 与凭据。
2. 在 **模型管理**刷新目录，只开启准备使用的模型。
3. 在 **通道配置**设置全局、各渠道与多模态候补模型。
4. 在 **智囊团**拖入专家与指挥，选择单轮或多轮。
5. 在 Dashboard 提问，或从已授权的消息渠道直接召集。

## 在通讯端召集智囊团

已通过 Hermes allowlist / pairing 授权的渠道用户，可直接在消息里用触发词召集智囊团（英文不区分大小写）：

`智囊团` · `智囊` · `MoA` · `专家团` · `专家圆桌` · `混合智能` · `mixture of agents`

```text
智囊团 请从产品、技术、商业三个角度评估这个方案
MoA 帮我比较 A 和 B 的风险、收益与实施成本
专家圆桌 为这次发布做一次反方审查
智囊团[方案名] 分析这个问题
```

通讯端与 Dashboard 共享同一套圆桌模型与辩证设置；同时最多执行 2 个渠道任务，重复请求会收到忙碌提示。多轮辩证会显著增加调用量，请按任务价值使用。

## 安全与隐私

- **API Key 不外泄**：普通响应只返回不可逆预览，明文仅在已认证的编辑操作中回填，且禁止缓存。
- **外部请求受控**：校验 URL、目标地址与每一次重定向，认证请求禁止跨来源重定向；JSON、图片、视频与 Base64 解码均有体积上限。
- **写入安全**：配置与状态采用锁、临时文件、`fsync` 与原子替换。
- **授权与隔离**：渠道触发复用 Hermes 的 allowlist / pairing，不对未授权用户开放；运行时数据按 profile 隔离在 `<HERMES_HOME>/data/decuria/`，不污染插件源码目录。

若任何 Key 曾出现在日志、截图或提交历史中，请立即在服务商后台轮换。安全报告流程见 [SECURITY.md](SECURITY.md)。

## 开发与验证

```bash
python -m py_compile state_paths.py security_utils.py __init__.py moa_core.py moa_trigger.py media_tools.py dashboard/plugin_api.py
python -m unittest discover -s tests -v
node --check dashboard/dist/index.js
```

前端为无需构建的 Preact IIFE；后端修改后需重启 Dashboard / Gateway。插件 API 挂载在 `/api/plugins/decuria`。

## License

Decuria 采用 [GNU AGPL-3.0](LICENSE) 许可发布。Copyright © 2026 Decuria Team。

- **个人、学习、研究，以及愿意同样开源的项目**：可自由使用、修改、分发。但只要你修改了 Decuria 并**通过网络对外提供服务**（包括私有部署给他人使用），就必须向这些使用者公开你修改版的**完整源码**（AGPL 第 13 条）。
- **闭源或商业集成**：若你不愿公开自己的源码（例如把 Decuria 集成进闭源产品或商业服务），请联系作者获取**商业授权**（双授权）。

第三方资产（内置的 Preact、Provider 图标等）保留其各自原始许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。品牌名称与商标归各自权利人所有。
