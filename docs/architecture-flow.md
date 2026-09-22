# 整体流程图

项目是一个本机运行的 React + Vite 前端和 Node.js 文件整理服务。浏览器只负责状态和预览，文件扫描、路径校验、移动、日志和撤销都由 Node 完成。

```mermaid
flowchart TD
    U[用户] --> UI[React 页面\nui/App.jsx]
    UI -->|GET /api/session| API[Node HTTP 服务\nsrc/server.js]
    API --> SESSION[返回会话 token\n分类标签\n媒体能力\n默认 Downloads]
    SESSION --> UI

    U --> PICK[选择本机文件夹\n或输入绝对路径]
    PICK -->|POST /api/pick-folder| API
    API --> OSX[macOS AppleScript\n选择目录窗口]
    OSX --> API
    API --> UI

    U --> SCAN[点击扫描文件夹]
    SCAN -->|POST /api/scan| API
    API --> ORG[Organizer\nsrc/organizer.js]
    ORG --> ROOT[校验目录\n绝对路径/真实目录/无符号链接]
    ROOT --> ENUM[读取直属文件和文件夹\n跳过隐藏项、分类目录、链接]
    ENUM --> MEDIA{是否为照片/视频扩展名?}
    MEDIA -->|否| ORD[普通项目\n名称、类型、样本、大小]
    MEDIA -->|是| SCANNER[媒体扫描器\nsrc/media-scanner.js]
    SCANNER --> SWIFT[Swift helper\nnative/MediaMetadata]
    SWIFT --> META[读取拍摄时间、GPS、\nLive Photo 标识]
    META --> RULES[媒体规则\nsrc/media-rules.js\n元数据 > 文件名 > 创建时间]
    RULES --> GEO{用户允许地点查询?}
    GEO -->|否| UNKNOWN[国家/城市待确认]
    GEO -->|是| CACHE[地理缓存\nsrc/geocode-cache.js]
    CACHE --> APPLE[Apple CoreLocation\n反向地理编码]
    APPLE --> PLACE[国家/城市]
    UNKNOWN --> PUBLIC[生成公开扫描结果\n隐藏真实路径和精确坐标]
    PLACE --> PUBLIC
    ORD --> PUBLIC
    PUBLIC --> API
    API --> UI
    UI --> PREVIEW[整理预览表格\n文件、文件夹、照片、视频]

    PREVIEW --> MANUAL[手动选择分类或修改\n年月/国家/城市/媒体类型]
    PREVIEW --> AI{点击 AI 推荐?}
    AI -->|是| CLASSIFY[POST /api/classify]
    CLASSIFY --> TYPE_SAFE[TypeSafe AI\n仅发送名称、扩展名、目录样本]
    TYPE_SAFE --> SCORE[分类、置信度、待确认状态]
    SCORE --> PREVIEW
    AI -->|否| PREVIEW

    PREVIEW --> SELECT[勾选可移动项目]
    MANUAL --> SELECT
    SELECT -->|POST /api/move| API
    API --> VALIDATE[校验 token、扫描快照、\n项目身份、目标字段和路径安全]
    VALIDATE --> JOURNAL[写入操作日志\n.data/*.json\nwrite-ahead]
    JOURNAL --> MOVE[Organizer.rename\n创建目标目录并移动]
    MOVE --> RESULT{每个项目移动结果}
    RESULT -->|成功| HISTORY[历史记录\n状态 moved]
    RESULT -->|冲突/失败| ROLLBACK[安全回滚\n或标记 uncertain]
    ROLLBACK --> HISTORY
    HISTORY --> UI

    U --> HISTORY_PAGE[打开操作记录]
    HISTORY_PAGE -->|GET /api/history| API
    API --> RECOVER[恢复 pending/undoing 日志\n核对源和目标实际位置]
    RECOVER --> HISTORY

    U --> UNDO[点击撤销批次]
    UNDO -->|POST /api/undo| API
    API --> UNDO_CHECK[校验日志和目标身份\n确认原位置可用]
    UNDO_CHECK --> RESTORE[按相反顺序移动回源目录]
    RESTORE --> HISTORY
    HISTORY --> UI

    U --> EXPORT[导出结果]
    EXPORT --> JSON[浏览器本地生成 JSON\n不上传文件内容]
```

## 关键边界

- 浏览器不会直接操作本机文件；所有文件操作都经过 Node API。
- AI 只接收普通文件/文件夹的名称、扩展名、大小和少量目录样本，不读取文件内容。
- 媒体元数据优先在本机 Swift helper 中读取；只有用户打开地点查询时，GPS 才会发送给 Apple 解析国家和城市。
- 移动前后都使用文件身份、真实路径和符号链接检查，并以操作日志支持恢复和撤销。
- Live Photo 的照片和视频只有在共享唯一标识时才成组移动，否则分别作为普通媒体处理。
