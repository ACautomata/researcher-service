# 资料检索

> 来源：超星 mooc2 网关技能包（API Key 认证）。平台实际调用 `/openapi/coursedata/searchCourseDataJson`（OAuth 学生 token），此处仅参考参数与返回字段契约，路径与认证不可照搬。

- 权限：访问人需要该课程的资料模块权限；教师端需为该课程教师（角色 result=3 时拒绝），学生端需在指定班级。
- 接口：GET `/coursedata/searchCourseDataJson`（mooc2 网关），按资料名称关键词分页检索课程资料。

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| courseId | 是 | 课程 id |
| ut | 是 | 角色：`t`=教师端；其他值=学生端 |
| classId | 学生端必填 | 班级 id，学生端校验班级学生身份并过滤班级可见资料；教师端传 `0` |
| dataName | 是 | 资料名称关键词；查全部时必须显式传空值 `dataName=`，省略该参数服务端会返回错误页（非 JSON） |
| pageNumber | 否 | 页码，默认 `1` |
| pageSize | 否 | 每页条数，默认 `30` |

## 返回值

成功时返回 JSON 对象：

| 字段 | 说明 |
|------|------|
| status | `true` |
| msg | `success` |
| totalData | 命中资料总数 |
| datalist | 资料列表（CourseData 对象数组，含 id、dataName、dataType、rootId、insertTime 等） |
| totalPages | 总页数 |

失败时返回 `{"status":false,"msg":"..."}`，msg 含义：

| msg | 含义 |
|-----|------|
| 无权限 | 身份失效；教师端无该课程教师权限；或学生端不在该班级 |
| 课程不存在或已删除 | courseId 对应课程不存在 |

## 已知行为

- dataName 参数不可省略：查全部资料时必须显式传空值，否则服务端返回错误页而非 JSON。
- 关键词检索可能偶发 0 命中（瞬时性失败，如索引延迟、请求竞争），可重试一次；仍为 0 时改用 `dataName=` 全量列表核对，不能以关键词检索结果断定资料不存在。
- 文件夹类型判定：`dataType=afolder`；文件夹自身不可下载（无 objectId），子资料的 `rootId` 等于其父文件夹的 `id`（根目录资料的 `rootId=0`）。

## 脚本加工输出（--expand-folders true，默认）

脚本在接口原始返回基础上加工，输出 JSON 字段：

| 字段 | 说明 |
|------|------|
| status / msg / totalData / totalPages | 透传首页接口返回 |
| expandedDataCount | 展开文件夹后的文件总数（不含 afolder 条目） |
| displayLimited | 文件总数是否超过展示上限（默认 50） |
| displayNote | 仅超限时出现，固定为「资料数量较多，展示上限50个资料」 |
| datalist | 仅含文件的展示列表，截断到 `--max-display`（默认 50） |
| rawDatalist | 全部命中页的原始资料列表（含文件夹） |
| pageTruncated | 仅命中页数超过 50 时出现，提示展开结果可能不完整 |

展开规则：拉取全部命中页后，过滤掉全部 `dataType=afolder` 条目，并在命中池内按 `rootId` 等于文件夹 `id` 递归匹配子资料，子文件夹继续下钻（其自身仍不展示），最终仅保留文件条目。全量查询（`dataName=`）时命中池包含全部资料，展开结果完整；关键词查询时，仅能展开命中池内可见的子文件；文件夹本身命中关键词时不展示，等同未命中目标。
