# 获取或新建知识点

本技能编排两个接口：先查询，未找到则新建。

## 接口一：查询知识点列表

- 权限：通过网关 Bearer Token（API Key）认证用户身份；`cpi` 参数不要求调用方传入。
- 接口：GET `/qbank-educlaw/topic-list`（mooc2 网关，亦支持 POST），按名称搜索课程知识点树。

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| courseId | 是 | 课程 ID |
| query | 否 | 知识点名称关键词，模糊匹配；空串查全部 |
| qid | 否 | 题目 ID，传入时返回该题已关联的知识点选中状态 |

### 返回值

成功：

```json
{
  "status": true,
  "data": {
    "list": [
      {
        "id": 123,
        "content": "知识点名称",
        "type": 0,
        "level": 1,
        "parent": 0,
        "hasSub": true,
        "subList": [
          {
            "id": 124,
            "content": "子知识点名称",
            "type": 0,
            "level": 2,
            "parent": 123,
            "hasSub": false
          }
        ]
      }
    ],
    "selects": []
  }
}
```

list 字段说明：

| 字段 | 说明 |
|------|------|
| id | 知识点 ID |
| content | 知识点名称 |
| type | 类型：0=知识点 1=分类 |
| level | 层级，从 1 开始 |
| parent | 父知识点 ID，0 为根 |
| hasSub | 是否有子知识点 |
| subList | 子知识点列表（递归结构） |
| select | 是否被当前题目选中（仅 qid 传入时有效） |

失败时返回 `{"status":false,"msg":"..."}`，msg 含义：

| msg | 含义 |
|-----|------|
| 无效的登录人 | 鉴权失败，用户身份无效 |
| 课程不存在 | courseId 不存在 |
| 无权限访问 | 用户无该课程教师权限 |
| 映射课程无操作权限 | 该课程是映射课程，不允许操作 |

## 接口二：新建知识点

- 权限：通过网关 Bearer Token（API Key）认证用户身份；`cpi` 参数不要求调用方传入。
- 接口：POST `/questionBankTopic/addtopic`（mooc2 网关，亦支持 GET），新建知识点。

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| courseid | 是 | 课程 ID |
| topic | 是 | 知识点名称，不能为空且不超过 256 字，会做 HTML 转义和标签清理 |
| addTopicType | 否 | 添加方式：0=添加同级（必须同时传 `curOperateTopicId` 参照节点，否则报「此节点不允许添加同级知识点」） 1=添加子级（本技能新建时使用） -1=旧逻辑 |
| curOperateTopicId | 否 | 参照知识点 ID，决定添加谁的同级/子级，默认 0；API 直接新建时无需传 |
| addNodeType | 否 | 节点类型：0=知识点（默认） 1=分类 |
| parentId | 否 | 父知识点 ID，默认 0（根级）；`addTopicType=1` 时新建在该父级下，新版图谱中父节点必须为分类（type=1），否则报「知识点无法添加子集」 |
| topicModelId | 否 | 图谱模式 ID，默认 0 |
| citeTopicId | 否 | 引用知识点 ID，默认 0 |
| clazzId | 否 | 班级 ID，默认 0 |
| scenarioType | 否 | 场景类型：0=普通（默认） 1=AI生成图谱库 |
| isAbilityPoint | 否 | 是否技能点：0=否（默认） 1=是 |

### 返回值

成功：

```json
{
  "status": true,
  "topicId": 456,
  "realtTopicId": 456,
  "addDataJson": {
    "topicId": 456,
    "type": 0,
    "topic": "知识点名称",
    "parentTopicId": 0,
    "abilityPointsBtn": 0,
    "showTopicConvertType": 0,
    "curTopicIsHide": 0
  },
  "questionTopicCount": 101
}
```

返回字段说明：

| 字段 | 说明 |
|------|------|
| topicId | 新建知识点 ID |
| realtTopicId | 实际知识点 ID（引用时为被引用的知识点 ID，否则等于 topicId） |
| addDataJson | 新建知识点详情 |
| questionTopicCount | 新建后课程知识点总数 |

失败时返回 `{"status":false,"msg":"..."}`，msg 含义：

| msg | 含义 |
|-----|------|
| 知识点名称不符合要求 | topic 为空或清理后为空 |
| 知识点过长 / 分类名称过长 | topic 超过 256 字 |
| 课程不存在或已删除 | courseId 不存在 |
| 无权限 | 鉴权失败或用户无教师权限 |
| 映射课程无操作权限 | 该课程是映射课程 |
| 无权限更改 | 用户非创建人且无管理权限 |
| 图谱模式选择错误 | topicModelId 不属于当前课程 |
| 知识点超过限制 | 课程知识点总数已达上限（5000） |
| 同名知识点已存在 | 同一父级下已有同名知识点 |
| 此节点不允许添加同级知识点 | `addTopicType=0`（添加同级）但未传 `curOperateTopicId` 参照节点；无参照节点新建应改用 `addTopicType=1` |
| 知识点无法添加子集 | 父节点（`parentId` 或 `curOperateTopicId`）是 type=0 的知识点，新版图谱中只有分类（type=1）能挂子级 |

## 编排逻辑

1. 调用接口一，传入 `courseId` 和 `query`（知识点名称）搜索
2. 递归遍历 `data.list`（含 `subList`），按 `content` 字段精确匹配知识点名称
3. 找到匹配项 → 返回 `{"action":"found","topicId":...,"topicName":...}`
4. 未找到 → 调用接口二，传 `courseid`、`topic`、`addTopicType=1`（及可选 `parentId`）新建
5. 新建成功 → 返回 `{"action":"created","topicId":...,"topicName":...,"createResult":{...}}`

## 已知行为

- 接口一返回树形结构，知识点可能嵌套在 `subList` 中，需递归搜索。
- `query` 为服务端模糊匹配，返回的列表可能包含多个名称相近的知识点，脚本按 `content` 精确匹配。
- 接口二会对 `topic` 做 HTML 标签清理和尖括号转义，传入纯文本即可。
- `addTopicType` 语义是「添加同级/添加子级」，不是排序方式。前端页面在无参照节点时的兜底逻辑为 `if(curOperateTopicId == 0){ addTopicType = 1; }`（见 `mooc2-ans/js/courselist/knowledgepoints.js`），本技能新建时与其保持一致使用 `addTopicType=1`。
- 课程知识点总数上限 5000，超出时新建会被拒绝。
- 映射课程不允许操作知识点。
- `scenarioType=1`（AI生成图谱库）时鉴权方式不同（校验课程创建人身份），本技能默认使用 `scenarioType=0`。
