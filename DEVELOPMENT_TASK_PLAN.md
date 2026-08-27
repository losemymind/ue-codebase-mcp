# UE Codebase MCP 开发任务计划

> 项目：`ue-codebase-mcp`  
> 需求基线：用户已于 2026-08-27 确认“需求摘要 v1”  
> 文档状态：待执行  
> 交付目标：生产环境  
> 阶段规则：阶段 1、2、3 严格串行过门；当前阶段验收通过后才可进入下一阶段。扩展阶段在核心产品验收后启动。

## 1. 项目目标与约束

### 1.1 目标

建设一套固定设备、内网部署的 UE 5.6 代码与资产语义索引系统，通过 Streamable HTTP MCP 向 Codex Desktop/CLI/IDE、Claude Code、Cursor 和 OpenCode 等客户端提供代码检索、资产检索、调用链、影响分析、重新索引、UBT 构建和 UAT 测试能力。

### 1.2 硬性约束

- 只支持 UE 5.6，必须索引团队私有 Engine Fork 和异环项目。
- 第一版只接入 SVN；Git 与 Perforce 放入扩展阶段。
- 主干、稳定和发布分支持续索引。
- MCP 永久不提供代码写入、补丁应用、commit、push 或 submit 能力。
- MCP 可以触发重新索引、受控 UBT 构建、UAT 测试和全量构建。
- 中英文双语查询；检索结果必须包含证据、相对路径、行号、SVN revision、索引版本和不确定性。
- 约 30 人团队、10 并发；交互查询 P95 不超过 5 秒，P99 不超过 10 秒。
- 代码增量索引新鲜度不超过 5 分钟；蓝图/资产不超过 15 分钟。
- Engine Fork 与首个大型项目首次全量索引不超过 24 小时。
- 权限隔离粒度为项目、团队、用户，有效权限由 SVN 权限与 MCP ACL 取交集。
- 备份 RPO 不超过 1 小时，RTO 不超过 4 小时，保留 7 天。
- 默认只允许 MIT、BSD、Apache-2.0、PostgreSQL License 等宽松许可证依赖。

### 1.3 明确不做

- 不构建编辑器或 IDE 的代码修改替代品。
- 不向 MCP 暴露通用 Shell、任意命令或任意文件写入。
- 不对 `.uasset` 进行私有格式逆向，只通过 UE Editor API/Commandlet/Asset Registry 导出。
- 不对纹理像素、网格顶点或音频波形做多模态理解。
- 第一版不实现 Git、Perforce、双机热备、功能分支按需索引。

## 2. 架构与技术基线

### 2.1 部署拓扑

1. **MCP/API 控制面**：无状态 Streamable HTTP 服务，处理认证、ACL、工具调用、检索编排和任务管理。
2. **Windows Native Agent**：作为 Windows Service 运行，负责 SVN 同步、Clang 解析、UE Editor-Cmd/Commandlet、UBT 和 UAT。
3. **PostgreSQL + pgvector**：保存身份、ACL、仓库、revision、符号、关系图、任务、审计、全文索引和向量。
4. **对象/文件存储**：保存索引 generation 快照、导出 manifest、构建日志和备份，不对客户端直接开放。
5. **反向代理**：内网 TLS、请求体限制、连接限流和安全头。
6. **观测系统**：OpenTelemetry 指标/追踪，Prometheus 与 Grafana 作为默认实现。

### 2.2 技术选择

| 区域 | 基线选择 | 约束 |
|---|---|---|
| MCP/API/编排 | TypeScript + Node.js 企业 LTS | 第 1 阶段锁定精确版本和 lockfile |
| C++ 语义索引 | C++20 + 与 UE 5.6 工具链匹配的 Clang/LibTooling | 必须消费真实 compile database |
| UE 资产导出 | UE 5.6 C++ Editor Plugin + Commandlet | 仅 Editor 构建可用 |
| 数据库 | PostgreSQL + pgvector + PostgreSQL FTS | 先用单一数据平面降低运维复杂度 |
| 任务队列 | PostgreSQL 持久化队列 | `FOR UPDATE SKIP LOCKED`，任务可恢复 |
| Embedding/Rerank | 管理员统一配置的 OpenAI-compatible Provider | 禁止在日志中记录密钥或完整代码请求 |
| 认证 | OIDC/OAuth JWT + 每用户/服务 Bearer Token | 禁止匿名；Token 只存储哈希 |
| 配置 | 版本化 YAML + 环境变量/密钥存储 | 启动时严格 Schema 校验 |

PostgreSQL FTS/pgvector 是初始生产基线。只有第 3 阶段基准测试证明无法达到 SLO 时，才能通过 ADR 引入 OpenSearch 或 Qdrant，且必须保留相同的检索接口和回滚路径。

## 3. 目标仓库结构

```text
ue-codebase-mcp/
├─ apps/
│  ├─ mcp-server/                 # Streamable HTTP MCP 入口
│  ├─ admin-cli/                  # 安装、配置、运维与恢复 CLI
│  └─ compatibility-harness/      # MCP 客户端兼容测试
├─ services/
│  ├─ control-plane/              # 项目、ACL、任务、配置和审计
│  ├─ retrieval/                  # BM25/FTS、vector、graph、rerank
│  └─ index-coordinator/          # 增量计算、generation 发布
├─ workers/
│  ├─ windows-agent/              # Windows Service 主进程
│  ├─ svn-adapter/                # SVN 同步、revision 和 ACL
│  ├─ clang-indexer/              # C++ AST/符号/引用/关系导出
│  ├─ ue-indexer/                 # UE Commandlet 调用和导出导入
│  └─ build-runner/               # UBT/UAT 受控执行
├─ unreal/
│  └─ Plugins/UECodeIndexer/
│     ├─ Source/UECodeIndexer/
│     ├─ Source/UECodeIndexerCommandlet/
│     └─ UECodeIndexer.uplugin
├─ packages/
│  ├─ contracts/                  # MCP、HTTP、事件和导出 Schema
│  ├─ auth/                       # OIDC、Token、ACL
│  ├─ config/                     # 强类型配置
│  ├─ observability/              # 日志、指标、trace
│  ├─ provider-sdk/               # Embedding/Rerank Provider SPI
│  └─ test-fixtures/              # 合成 UE/SVN 测试数据
├─ database/
│  ├─ migrations/
│  ├─ seeds/
│  └─ queries/
├─ configs/
│  ├─ schemas/
│  └─ examples/
├─ deploy/
│  ├─ compose/
│  ├─ windows-service/
│  ├─ reverse-proxy/
│  ├─ monitoring/
│  └─ backup/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ e2e/
│  ├─ compatibility/
│  ├─ performance/
│  ├─ security/
│  └─ disaster-recovery/
├─ evals/
│  ├─ zh-CN/
│  ├─ en-US/
│  └─ graders/
├─ docs/
│  ├─ architecture/
│  ├─ adr/
│  ├─ api/
│  ├─ operations/
│  ├─ security/
│  └─ user-guide/
└─ tools/
   ├─ license-audit/
   ├─ sbom/
   └─ release/
```

## 4. 对外与内部接口

### 4.1 MCP 工具清单

| 工具 | 主要输入 | 主要输出 | 属性 |
|---|---|---|---|
| `list_projects` | 可选状态过滤 | 有权限的项目、仓库、索引 revision | 只读 |
| `index_status` | `project_id` | active generation、revision、新鲜度、错误 | 只读 |
| `search_code` | query、project、revision/scope、module、kind、limit | 排序的 `SourceEvidence[]` | 只读 |
| `read_file_excerpt` | project、revision、path、line range | 限长的代码片段与引用信息 | 只读 |
| `get_symbol` | project、symbol id/name | 声明、定义、UHT metadata、owner | 只读 |
| `find_references` | symbol id、direction、filters | 引用位置和关系类型 | 只读 |
| `trace_calls` | symbol id、direction、max depth | 限宽调用图和裁剪说明 | 只读 |
| `find_derived_types` | type id、include_blueprints | C++/Blueprint 派生类 | 只读 |
| `get_module_dependencies` | module、direction、depth | Build.cs/Plugin 依赖图 | 只读 |
| `search_assets` | query、asset classes、package paths | 资产、类型、父类、语义和引用 | 只读 |
| `get_asset_graph` | asset id、edge types、depth | 资产/蓝图关系图 | 只读 |
| `analyze_impact` | symbols/assets/files、depth、limits | 分类影响面和证据 | 只读 |
| `request_reindex` | project、requested revision、scope | `job_id` | 改变索引，不改代码 |
| `start_ubt_build` | project、revision、preset id | `job_id` | 受控执行 |
| `start_uat_test` | project、revision、preset id | `job_id` | 受控执行 |
| `get_job` | `job_id` | 状态、进度、有界日志、artifact | 只读 |
| `cancel_job` | `job_id`、reason | 取消接受状态 | 受控执行 |

工具参数一律使用 JSON Schema，禁止任意命令字符串。`start_ubt_build` 和 `start_uat_test` 只接受管理员已登记的 preset ID。

### 4.2 统一证据对象

```json
{
  "project_id": "yihuan",
  "repository_id": "yihuan-game",
  "repository_kind": "svn",
  "branch": "stable",
  "revision": "75472",
  "index_generation": "01J...",
  "path": "Source/Game/Foo.cpp",
  "start_line": 120,
  "end_line": 168,
  "symbol_id": "optional-stable-id",
  "qualified_name": "UFoo::Bar",
  "snippet": "bounded snippet",
  "score": 0.93,
  "match_reasons": ["exact_symbol", "semantic", "graph_neighbor"],
  "uncertainty": [],
  "indexed_at": "RFC3339 timestamp"
}
```

### 4.3 内部 Agent 接口

- `POST /internal/v1/agents/register`：注册 Windows Agent 能力和版本。
- `POST /internal/v1/jobs/claim`：长轮询领取一个可执行任务。
- `POST /internal/v1/jobs/{id}/heartbeat`：更新 lease、进度与资源使用。
- `POST /internal/v1/jobs/{id}/events`：上报结构化事件和经过脱敏的日志。
- `POST /internal/v1/jobs/{id}/complete`：提交结果 manifest；服务端校验后发布。
- `POST /internal/v1/jobs/{id}/fail`：提交分类错误、可重试性和诊断信息。
- `GET /health/live`、`GET /health/ready`、`GET /metrics`：健康与观测。

内部端口只绑定管理网络/本机网络，使用短期 Agent 凭据，不与用户 MCP Token 共用。

## 5. 数据库表设计清单

所有业务表默认包含 `created_at`、`updated_at`；可变配置表包含 `version`与审计字段。

### 5.1 身份和权限

| 表 | 关键字段/索引 |
|---|---|
| `users` | `id`, `external_subject`, `display_name`, `status`; unique `(external_subject)` |
| `teams` | `id`, `name`, `status`; unique `(name)` |
| `team_memberships` | `team_id`, `user_id`, `role`; PK `(team_id,user_id)` |
| `project_permissions` | `project_id`, `principal_type`, `principal_id`, `role`; unique effective grant |
| `api_tokens` | `id`, `owner_type`, `owner_id`, `token_hash`, `scopes`, `expires_at`, `revoked_at` |
| `oidc_providers` | issuer、audience、JWKS 配置、enabled；密钥不入库 |
| `svn_access_snapshots` | `repository_id`, `revision`, `subject`, `effective_access`, `captured_at` |

### 5.2 项目、仓库和索引

| 表 | 关键字段/索引 |
|---|---|
| `projects` | `id`, `slug`, `name`, `ue_version`, `status`; unique `(slug)` |
| `repositories` | `id`, `project_id`, `kind`, `canonical_url`, `role`, `credential_ref`, `enabled` |
| `repository_branches` | `id`, `repository_id`, `name`, `svn_url`, `tracking_policy`, `head_revision` |
| `revisions` | `id`, `repository_branch_id`, `vcs_revision`, `observed_at`, `author`, `message_hash`; unique branch+revision |
| `index_generations` | `id`, `project_id`, `revision_set_hash`, `status`, `started_at`, `published_at`, `manifest_uri` |
| `generation_revisions` | generation 与多仓库 revision 的固定映射 |
| `files` | `id`, `generation_id`, `repository_id`, `path`, `language`, `content_hash`, `line_count`; unique generation+repo+path |
| `file_dependencies` | `src_file_id`, `edge_type`, `dst_file_id`, `condition_hash` |
| `index_failures` | generation、scope、error class、diagnostic、retry state |

### 5.3 C++/模块语义

| 表 | 关键字段/索引 |
|---|---|
| `modules` | `id`, `generation_id`, `name`, `module_type`, `plugin_id`, `build_file_id` |
| `module_dependencies` | `src_module_id`, `dst_module_id`, `visibility`, `condition`, `source_location` |
| `symbols` | `id`, `generation_id`, `stable_usr`, `qualified_name`, `kind`, `module_id`, `owner_symbol_id`, `signature_hash` |
| `symbol_locations` | `symbol_id`, `location_kind`, `file_id`, `start_line/column`, `end_line/column` |
| `symbol_metadata` | `symbol_id`, UHT specifiers/meta、Blueprint exposure、documentation |
| `symbol_edges` | `src_symbol_id`, `edge_type`, `dst_symbol_id`, `file_id`, `line`, `confidence`; composite edge index |
| `code_chunks` | `id`, `generation_id`, `symbol_id`, `file_id`, `chunk_kind`, `text`, `token_count`, `search_vector` |
| `chunk_embeddings` | `chunk_id`, `provider`, `model`, `dimensions`, `embedding`, `content_hash`; vector index |

### 5.4 UE 资产和节点图

| 表 | 关键字段/索引 |
|---|---|
| `asset_packages` | generation、package name、file、content hash、mount point |
| `assets` | package、object path、class path、native parent、generated class、tags JSONB |
| `asset_properties` | asset、property path、type、normalized value/hash、source |
| `asset_graphs` | asset、graph kind、graph name、owner path |
| `asset_nodes` | graph、node id、node class、title、referenced symbol/asset、position |
| `asset_pins` | node、pin id、name、direction、type、default value/hash |
| `asset_pin_edges` | output pin、input pin、edge type |
| `asset_edges` | src asset、edge type、dst asset/symbol、hard/soft、confidence |
| `asset_exporters` | exporter id、version、supported classes、schema version |
| `asset_export_failures` | asset、exporter、error、retry state |

### 5.5 任务、构建、审计和运维

| 表 | 关键字段/索引 |
|---|---|
| `job_presets` | id、project、kind、target/platform/configuration、allowlisted args、resource policy |
| `jobs` | id、project、type、requester、revision set、status、priority、lease、timestamps |
| `job_events` | job、sequence、level、event type、redacted payload、timestamp |
| `job_artifacts` | job、artifact kind、URI、hash、size、retention |
| `agents` | agent id、version、capabilities、last heartbeat、status |
| `audit_events` | actor、action、project、tool、outcome、request hash、source IP、timestamp |
| `backup_runs` | kind、generation、status、started/completed、manifest、verification |
| `evaluation_cases` | language、query、expected evidence、tags、approved version |
| `evaluation_runs` | generation、suite version、metrics JSONB、pass/fail |

## 6. 阶段 1：生产基础、SVN、C++/Engine 和 MCP 基线

**阶段目标**：在生产级安全边界下，完成私有 Engine Fork 与异环 C++/模块的 SVN 增量索引和标准 MCP 检索，建立后续资产索引所需的基础设施。

| ID | 任务 | 主要交付物 | 依赖 | 验证 |
|---|---|---|---|---|
| P1-01 | 建立 monorepo、格式化、lint、单测、构建与 release 骨架 | 目录、lockfile、CI 基线、版本规则 | 无 | clean checkout 一键构建；无网络重复构建一致 |
| P1-02 | 完成架构、威胁模型、数据分类和 ADR | C4 图、trust boundary、ADR-001~005 | P1-01 | 架构/安全评审签字 |
| P1-03 | 定义配置 Schema 和密钥引用模型 | project/repository/provider/preset schemas | P1-02 | 非法配置 fail-fast；密钥不入库/日志 |
| P1-04 | 实现初始数据库 migration | 5.1~5.3、5.5 核心表、索引、回滚 migration | P1-01 | 空库升级、前版升级、回滚与数据约束测试 |
| P1-05 | 实现 OIDC、Bearer Token 和用户/团队/项目 ACL | auth package、JWKS cache、Token rotation、policy engine | P1-03,P1-04 | 过期/撤销/错误 audience 拒绝；跨项目泄漏为 0 |
| P1-06 | 实现 SVN 适配器 | checkout/update/log/info/diff/status/ACL snapshot；XML 解析 | P1-03 | 合成 SVN 服务器集成测试；revision 一致性 |
| P1-07 | 实现只读工作区与 revision set 固定 | Engine/项目多仓库 workspace manager | P1-06 | 任务全程 revision 不漂移；中断可清理/恢复 |
| P1-08 | 获取和校验 UE 5.6 compile database | UBT 生成器适配、参数规范化、coverage report | P1-07 | 目标 TU 覆盖率≥99%；宏/include 路径抽样正确 |
| P1-09 | 实现 Clang 符号索引 | symbols、locations、USR、docs、macros、UHT metadata | P1-08 | 金标类/函数/模板/重载用例正确 |
| P1-10 | 实现 C++ 关系索引 | calls/references/inherits/overrides/includes/owns 边 | P1-09 | 关系金标 precision/recall 均≥95% |
| P1-11 | 解析 `.uproject/.uplugin/Build.cs/Target.cs` | module/plugin/target 模型与条件依赖 | P1-07 | Public/Private/Dynamic 依赖和平台条件金标通过 |
| P1-12 | 实现 AST-aware chunking、FTS 和 embedding pipeline | code chunks、BM25/FTS、provider batching/cache | P1-09 | 同符号声明/定义关联；重试不重复计费 |
| P1-13 | 实现 hybrid retrieval 与 rerank | exact+FTS+vector+graph 合并、去重、多样性打包 | P1-10,P1-12 | 初始双语金标 Recall@20≥90% |
| P1-14 | 实现 generation 构建与原子发布 | staging/publish/rollback/GC | P1-04,P1-09,P1-12 | 查询永不见半成品；发布失败保留旧版 |
| P1-15 | 实现 MCP 协议层与只读工具 | 初始化 instructions、工具 Schema、分页、错误码 | P1-05,P1-13,P1-14 | MCP Inspector + 客户端协议测试；不暴露写工具 |
| P1-16 | Windows Agent 和内部任务 lease | service install/update、claim/heartbeat/retry | P1-03,P1-04 | 进程崩溃后 lease 回收；任务幂等 |
| P1-17 | 基础日志、metrics、trace 与审计 | dashboard、correlation ID、脱敏规则 | P1-05,P1-15,P1-16 | 密钥/完整代码不出现在日志；工具调用可追溯 |
| P1-18 | 建立容器与 Windows Service 部署基线 | Compose、service installer、TLS 反代、health checks | P1-15~17 | 干净固定设备安装演练成功 |

### 阶段 1 门禁 G1

必须全部满足：

- Engine Fork 与异环 C++/模块索引在 24 小时内完成，无无解释的永久解析失败。
- compile database TU 覆盖率≥99%；未覆盖项有明确豁免和风险说明。
- 精确符号 Recall@5≥98%，双语语义检索 Recall@20≥90%。
- 文件/revision/行号引用准确率 100%。
- 用户、团队、项目 ACL 负向测试无泄漏。
- 代码 revision 更新后 5 分钟内可检索。
- MCP 无任何代码修改/通用命令能力。
- 所有 P1 单元、集成、E2E、安全和安装测试通过；无 Critical/High 未处理问题。
- 阶段评审记录签字后才能启动阶段 2。

## 7. 阶段 2：UE 资产全量语义、知识图和检索质量

**阶段目标**：通过 UE 5.6 Editor Plugin/Commandlet 完成已确认的 UE 资产范围，将 C++、Blueprint、模块和资产连成可检索、可追溯的关系图。

| ID | 任务 | 主要交付物 | 依赖 | 验证 |
|---|---|---|---|---|
| P2-01 | 创建 UECodeIndexer Editor Plugin 和 Commandlet | plugin/modules、headless invocation、schema negotiation | G1 | 安装到私有 Fork 与项目后可命令行运行 |
| P2-02 | 设计稳定资产导出 Schema | manifest、package/asset/graph/node/pin/edge schemas | P2-01 | Schema 版本前/后向兼容测试 |
| P2-03 | 实现 Asset Registry 全量/增量扫描 | package、class、tags、dependency/referencer | P2-01,P2-02 | 与 Editor 查询金标一致 |
| P2-04 | 实现 Blueprint 导出 | 所有 Blueprint 类型、graph/node/pin/edge、native call | P2-02 | 蓝图节点/连接/父类金标 precision/recall≥98% |
| P2-05 | 实现 Animation/Widget/Behavior/EQS/StateTree 导出 | 专用 exporter 和 normalized graph | P2-02 | 每类型至少 20 个真实资产金标测试 |
| P2-06 | 实现 Control Rig/PCG 导出 | graph、settings、external references | P2-02 | 节点和资产依赖测试 |
| P2-07 | 实现 Material/Material Function/Niagara/MetaSound 导出 | domain-specific nodes/edges/properties | P2-02 | 编辑器可见节点抽样一致性≥98% |
| P2-08 | 实现 Gameplay/Input/Data/Localization 导出 | Ability/Effect/Tag/Input/DataAsset/DataTable/Curve/Loc | P2-02 | 跨 C++/资产引用金标通过 |
| P2-09 | 实现 Map/Level/World Partition/Sequence 导出 | actor descriptors、streaming cells、sequence refs | P2-02 | 不强制加载全地图；内存峰值有界 |
| P2-10 | 实现 Mesh/Texture/Animation/Sound 元数据 | properties、class、hard/soft refs | P2-03 | 不导出原始大二进制内容 |
| P2-11 | 实现 Wwise/FMOD/自定义 Exporter SPI | exporter registry、版本/能力协商、SDK | P2-02 | 用合成自定义资产插件验证无核心修改接入 |
| P2-12 | 实现资产数据导入和幂等更新 | 5.4 表、bulk loader、hash dedupe、failure isolation | P2-03~11 | 重复导入不增量；单资产失败不阻断 generation |
| P2-13 | 连接 C++/Blueprint/资产/模块关系 | cross-domain stable ids 与 edges | P2-04~12 | native parent、UFUNCTION、UPROPERTY、asset ref 金标通过 |
| P2-14 | 扩展资产 hybrid retrieval | 资产 chunking、双语摘要、FTS/vector/graph rerank | P2-12,P2-13 | 中英文同意问题结果一致性 |
| P2-15 | 实现 `search_assets/get_asset_graph/analyze_impact` | MCP tools、裁剪策略、证据输出 | P2-13,P2-14 | 深度/宽度/响应大小限制测试 |
| P2-16 | 建立双语检索评测集与 grader | ≥300 个审核用例，覆盖代码与资产 | P2-14 | 评测可重现、有版本、金标双人复核 |
| P2-17 | 完成资产增量新鲜度和大项目稳定性优化 | change detector、batching、memory/backpressure controls | P2-12~16 | 资产变更 15 分钟内可查；连续 72h 无积压失控 |

### 阶段 2 门禁 G2

- 需求摘要中所列 UE 资产类型均有 exporter、至少一组真实资产 fixture 和自动化测试。
- Blueprint graph/node/pin/edge 和跨 C++ 关系 precision/recall≥98%。
- 资产关系 precision/recall≥95%；重要错误不得静默丢失。
- 双语综合检索 Recall@20≥90%；精确符号 Recall@5≥98%。
- 所有结果证据字段完整，路径/revision/行号准确率 100%。
- 资产增量新鲜度≤15 分钟，服务连续 72 小时无不可恢复积压。
- 所有 P2 测试通过，无 Critical/High 未处理问题；评审签字后才能启动阶段 3。

## 8. 阶段 3：UBT/UAT、生产硬化、性能与上线

**阶段目标**：在不暴露通用命令和不修改代码的前提下，上线受控 UBT/UAT，完成性能、安全、备份恢复、兼容性和生产运维验收。

| ID | 任务 | 主要交付物 | 依赖 | 验证 |
|---|---|---|---|---|
| P3-01 | 完善持久化任务队列和资源调度 | priority、lease、retry、quota、cancellation、fairness | G2 | crash/restart/cancel/race 注入测试 |
| P3-02 | 实现构建/测试 preset 管理 | 签名配置、参数允许列表、变更审计 | P3-01 | 任意参数/命令注入均被拒绝 |
| P3-03 | 实现 UBT 构建 runner | target/platform/configuration/full build、结构化错误 | P3-02 | 预设矩阵构建、超时、取消、日志测试 |
| P3-04 | 实现 UAT 测试 runner | allowlisted UAT presets、test result parser、artifacts | P3-02 | 通过/失败/崩溃/超时均有正确结果 |
| P3-05 | 实现 MCP 执行类工具 | reindex/build/test/get/cancel job | P3-01~04 | 权限、限流、审计、幂等和响应 Schema 测试 |
| P3-06 | 进行全链路性能分析和调优 | 查询/索引剖析、索引策略、容量报告 | P3-05 | 10 并发 P95≤5s、P99≤10s；24h 初始索引 |
| P3-07 | 评估是否拆分专用搜索/向量库 | ADR + benchmark + cost/rollback analysis | P3-06 | 只有基线不达标才实施；替换后全回归 |
| P3-08 | 完成安全硬化 | TLS、rate limit、请求限制、secret rotation、SSRF/注入防护 | P3-05 | SAST/DAST/依赖扫描/渗透检查无未接受 High/Critical |
| P3-09 | 完成备份、恢复与保留策略 | hourly incremental、daily full、7-day retention、restore CLI | P3-08 | RPO≤1h、RTO≤4h；隔离环境恢复演练 |
| P3-10 | 完成 MCP 客户端兼容矩阵 | Codex Desktop/CLI/IDE、Claude Code、Cursor、OpenCode | P3-05 | initialize/tools/list/call/error/auth/large result 全部通过 |
| P3-11 | 完成故障注入和稳定性测试 | DB/Agent/API/provider/SVN/UE crash scenarios | P3-06,P3-09 | 7 天 soak；无数据丢失/跨 generation 污染 |
| P3-12 | 完成 SBOM、许可证与供应链管控 | SBOM、license allowlist、签名 artifact、provenance | P3-08 | GPL/AGPL/SSPL/未知许可证自动阻断发布 |
| P3-13 | 完成监控、告警与容量手册 | dashboards、SLO alerts、runbooks、capacity model | P3-06,P3-11 | 演练新鲜度、队列、磁盘、DB、Agent 告警 |
| P3-14 | 完成安装、升级、回滚与管理员/用户文档 | 一键脚本、手册、客户端示例 | P3-08~13 | 由非开发人员按手册完成演练 |
| P3-15 | 生产发布彩排和上线 | release candidate、变更/回退窗口、验收记录 | P3-01~14 | 全量验收清单签字 |

### 阶段 3 门禁 G3（生产上线门禁）

- 全部功能、检索质量、性能、安全、兼容、备份恢复和 soak 测试通过。
- 10 并发下 P95≤5s、P99≤10s；代码≤5min、资产≤15min 新鲜度达标。
- UBT 全量构建和约定 UAT 矩阵可用，且无通用命令注入通道。
- RPO≤1h、RTO≤4h、7 天保留通过实际恢复演练。
- 所有支持的 MCP 客户端通过兼容矩阵。
- SBOM 与许可证审批完成，无禁止许可证。
- 无未接受 Critical/High 问题；Medium 必须有责任人和时限。
- 管理员、安全、运维和业务代表完成生产签字。

## 9. 扩展阶段：Git、Perforce 和多 VCS

该阶段只在 G3 通过后开始，不改变核心 MCP 语义和证据对象。

| ID | 任务 | 交付物 | 验收 |
|---|---|---|---|
| EX-01 | 从 SVN 实现抽取 VCS Provider SPI | repository/revision/change/workspace/ACL 统一接口 | SVN 全回归无退化 |
| EX-02 | Git Provider | clone/fetch/commit/branch、只读 worktree、权限映射 | 合成 Git 服务器与大仓库测试 |
| EX-03 | Perforce Provider | depot/stream/changelist/client spec、权限映射 | 合成 P4 服务器与 stream 测试 |
| EX-04 | 按需分支/Stream 索引 | TTL、quota、LRU 回收、预热 | 无跨分支污染；回收后可重建 |
| EX-05 | 多 VCS revision set 与统一证据 | commit/revision/changelist discriminated union | 混合 Engine/项目/插件仓库 E2E |
| EX-06 | 扩展安全、备份、监控与文档 | provider runbooks、dashboards、client examples | 全回归、性能和恢复演练通过 |

## 10. 必须自动化的测试用例

| 用例 ID | 场景 | 预期结果 |
|---|---|---|
| T-SVN-001 | 索引过程中 SVN HEAD 改变 | generation 仍固定在原 revision set |
| T-SVN-002 | SVN 凭据失效/权限收紧 | 立即拒绝新查询，告警且不泄漏旧数据 |
| T-CPP-001 | UCLASS/UFUNCTION/UPROPERTY 与 metadata | 符号、定位、specifier 完整 |
| T-CPP-002 | 宏、模板、重载、条件编译 | 符号 ID 稳定，关系不误合并 |
| T-CPP-003 | `.generated.h` 与生成代码 | 保留来源映射，检索默认不被生成代码淹没 |
| T-MOD-001 | Public/Private/Dynamic 模块依赖 | 边类型和 Build.cs 位置正确 |
| T-BP-001 | Blueprint 调用 C++ UFUNCTION | 蓝图节点与 C++ symbol 双向可查 |
| T-BP-002 | BlueprintNativeEvent 被蓝图重写 | override 边和影响分析正确 |
| T-ASSET-001 | Hard/Soft reference 和反向引用 | 边类型正确，referencer 完整 |
| T-ASSET-002 | 损坏/无法加载资产 | 单资产隔离、显式失败，generation 策略可预期 |
| T-SEARCH-001 | 中文描述查英文代码 | Recall@20 达标，证据完整 |
| T-SEARCH-002 | 函数名/错误码/日志精确查询 | exact/FTS 优先，目标在 Top 5 |
| T-SEARCH-003 | 同名符号位于 Engine 和 Game | 通过 module/repo/owner 正确区分 |
| T-GRAPH-001 | 调用图环和超大扇出 | 无死循环，限宽并说明裁剪 |
| T-ACL-001 | 无项目权限用户猜测 symbol/path | 统一返回不可见，不侧信道泄漏 |
| T-ACL-002 | 用户属于多团队且 SVN 权限更改 | 有效权限按交集计算并及时更新 |
| T-MCP-001 | 各客户端 initialize/list/call | 协议和 Schema 一致 |
| T-MCP-002 | 超大结果、超时、取消 | 分页/限长/标准错误，无服务崩溃 |
| T-MCP-003 | 枚举工具与 Schema | 无写文件、补丁、提交、通用 Shell 能力 |
| T-BUILD-001 | 合法 UBT 全量 preset | 异步 job、完整状态、结果和受限日志 |
| T-BUILD-002 | 恶意 target/args/path 注入 | Schema/preset 层拒绝，不启动进程 |
| T-UAT-001 | UAT 通过/失败/超时/崩溃 | 状态、测试结果、artifact 和审计正确 |
| T-JOB-001 | Agent 执行期崩溃 | lease 过期后安全重试，不重复发布 |
| T-PERF-001 | 10 并发混合查询 | P95≤5s、P99≤10s，错误率在验收阈值内 |
| T-FRESH-001 | 代码/资产 revision 更新 | 分别在 5/15 分钟内进入 active generation |
| T-DR-001 | 丢失主数据库后恢复 | RPO≤1h、RTO≤4h，恢复后一致性检查通过 |
| T-LIC-001 | 引入 GPL/AGPL/SSPL/未知依赖 | CI/release 必须失败 |

## 11. 全局 Definition of Done

任何任务标记完成前必须：

1. 代码、Schema、migration、配置和文档同步提交。
2. 单元测试和相关集成/E2E 测试通过，且无通过降低阈值规避失败。
3. 完成同行评审；身份、ACL、执行、密钥、输入处理变更必须安全评审。
4. 日志、指标、审计和错误信息可用且已脱敏。
5. 所有新依赖通过许可证、漏洞和 SBOM 检查。
6. 如影响部署/运维，已更新安装、升级、回滚和故障处置文档。
7. 不新增任何 MCP 代码写入或通用命令路径。

## 12. 建议人员与工期基线

建议核心团队：

- 1 名技术负责人/架构师。
- 2 名 TypeScript/后端工程师。
- 2 名 UE/C++/工具链工程师。
- 1 名平台/SRE 工程师。
- 1 名 QA/测试开发工程师。
- 安全、SVN 管理员、UE 各专业内容开发者按门禁参与。

初始日历估算（阶段内并行，阶段间串行）：

| 阶段 | 估算 | 说明 |
|---|---:|---|
| 阶段 1 | 8~10 周 | 在真实 Engine Fork/项目和 SVN 接入后校准 |
| 阶段 2 | 10~14 周 | 取决于自定义资产、Wwise/FMOD 和地图规模 |
| 阶段 3 | 8~10 周 | 包含 7 天 soak 和恢复演练 |
| 扩展阶段 | 6~8 周 | Git/Perforce 环境和权限系统需可用 |

核心生产版初始估算为 26~34 周。P1-08 完成并获得真实规模数据后，必须重新基准化人力与日历计划，但不得降低已确认的验收标准。

## 13. 主要风险与应对

| 风险 | 影响 | 应对/触发条件 |
|---|---|---|
| 私有 Engine Fork 无法生成完整 compile database | C++ 语义不完整 | P1-08 独立门禁；修复 UBT 适配而不伪造全局 flags |
| `.uasset` 数量/地图规模超预期 | 首索引超 24h、内存爆炸 | 分批、不加载全地图、Actor Descriptor、背压和专用 exporter |
| 自定义资产类型多 | 范围漂移 | Exporter SPI；每类资产必须注册能力和 Schema 版本 |
| 云 Embedding/Rerank 限流或不可用 | 索引积压/查询降级 | hash cache、batch/retry/circuit breaker；精确+FTS 可降级服务 |
| SVN 权限与 MCP ACL 短暂不一致 | 泄漏风险 | fail closed；权限快照过期后拒绝而非沿用 |
| UBT/UAT 占满固定设备 | 查询/索引 SLO 下降 | 资源组、优先级、并发限制；检索服务保留资源 |
| 不同 MCP 客户端行为差异 | 兼容性问题 | 只使用标准能力；固定兼容矩阵和大响应限制 |
| 单机故障 | 服务中断 | 小时/每日备份、自动恢复、索引可重建，RTO 演练 |
| 许可证漂移 | 无法生产发布 | lockfile、SBOM、allowlist、发布门禁 |

## 14. 开工前输入清单

这些是执行输入，不再改变已确认需求。缺失项在对应任务开始前必须由项目负责人提供：

- 异环项目 SVN URL、主干/稳定/发布路径和只读服务账号。
- 私有 UE 5.6 Engine Fork SVN URL、revision 策略和已验证的 Editor/Target 构建命令。
- 固定设备的网络名、TLS 证书策略、磁盘布局和服务账号。
- 公司 OIDC issuer/audience/claims 规则，或首期 Token-only 启动批准。
- Embedding/Rerank Provider endpoint、模型、限额和数据合规确认。
- 第一批 UBT/UAT preset 矩阵。
- Wwise/FMOD/自定义资产清单和对应内容专家。
- 阶段门禁签字人：技术、UE 内容、SVN、安全、运维和业务代表。

## 15. 文档与发布产物清单

- 完整源码、锁定依赖和可重现构建。
- 架构文档、ADR、威胁模型、数据分类和边界。
- MCP/HTTP/导出 Schema 和错误码参考。
- UE 5.6 Editor Plugin/Commandlet 的安装、升级和故障排查文档。
- 数据库 migration、备份/恢复、容量与索引维护手册。
- Windows Service、Compose、反向代理、监控和一键部署。
- OIDC/Token/ACL/审计管理手册。
- Codex Desktop/CLI/IDE、Claude Code、Cursor、OpenCode 配置示例。
- 单元、集成、E2E、兼容、性能、安全、DR 和评测报告。
- SBOM、第三方许可证报告、签名发布产物和回滚包。

