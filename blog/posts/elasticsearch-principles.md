# Elasticsearch 搜索引擎原理——倒排索引、集群架构与性能优化

## 引言

在海量数据的时代，传统的数据库模糊查询已经无法满足用户对搜索体验的极致追求。当数据量达到千万甚至亿级时，一条 `LIKE '%关键词%'` 的 SQL 查询可能需要数秒甚至数十秒，而 Elasticsearch 可以在毫秒级返回精准的搜索结果。

Elasticsearch（简称 ES）是基于 Apache Lucene 构建的分布式搜索与分析引擎，它不仅提供了强大的全文搜索能力，还具备实时数据分析、日志处理和地理空间搜索等多种功能。本文将从倒排索引的核心原理、集群架构设计、性能调优等多个角度，深入剖析 Elasticsearch 的工作机制。

---

## 一、核心概念与数据模型

### 1.1 五大核心概念

```
Elasticsearch 概念与关系型数据库对比：

关系型数据库          Elasticsearch
─────────────────    ─────────────────
Database（数据库）  →  已废弃，ES 顶层即为 Index
Table（表）         →  Index（索引）[7.x 后 Type 已废弃]
Row（行）           →  Document（文档）
Column（列）        →  Field（字段）
Schema（表结构）    →  Mapping（映射）
SQL（查询语言）     →  DSL（领域特定语言）
```

**Index（索引）**：ES 中的顶层逻辑容器，类似于关系型数据库中的表。一个 Index 包含具有相似特征的文档集合。例如，`products` 索引存储所有商品文档。

**Document（文档）**：ES 中的基本数据单元，以 JSON 格式存储。每个文档都有一个唯一 ID，并属于某个 Index。

**Shard（分片）**：Index 的物理分区。当数据量超过单个节点的处理能力时，通过分片将数据分散到多个节点上，实现水平扩展。

**Replica（副本）**：分片的高可用副本。每个主分片可以有一个或多个副本分片，副本不会被分配到与主分片相同的节点上。

**Type（已废弃）**：在 ES 6.x 之前，一个 Index 下可以有多个 Type。从 6.x 开始逐步废弃，7.x 完全移除，每个 Index 只能有一个 `_doc` 类型。

### 1.2 核心数据类型

ES 的数据类型选择直接影响搜索性能和存储效率：

```
text vs keyword 对比：

text 类型：
├── 存储时：经过分词器（Analyzer）处理，拆分为词项（Term）
├── 用途：全文搜索（match, match_phrase, multi_match）
├── 不支持：聚合（aggregation）和排序（sort）
└── 示例："Elasticsearch 是一个搜索引擎" → ["elasticsearch", "搜索引擎"]

keyword 类型：
├── 存储时：不经过分词器，整个字段作为一个词项
├── 用途：精确匹配（term）、聚合、排序
├── 不支持：全文搜索
└── 示例："Elasticsearch 是一个搜索引擎" → ["Elasticsearch 是一个搜索引擎"]
```

```json
// Mapping 配置示例
{
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "ik_max_word",
        "search_analyzer": "ik_smart"
      },
      "status": {
        "type": "keyword"
      },
      "price": {
        "type": "scaled_float",
        "scaling_factor": 100
      },
      "tags": {
        "type": "keyword"
      },
      "created_at": {
        "type": "date",
        "format": "yyyy-MM-dd HH:mm:ss||epoch_millis"
      },
      "location": {
        "type": "geo_point"
      },
      "address": {
        "type": "nested",
        "properties": {
          "city": { "type": "keyword" },
          "street": { "type": "text" }
        }
      }
    }
  }
}
```

### 1.3 nested vs object 类型

这是一个常见的陷阱。当文档包含对象数组时，`object` 类型会将数组内的对象"打平"存储，导致字段间的关联关系丢失：

```json
// 使用 object 类型的问题
// 原始文档
{
  "users": [
    { "name": "Alice", "age": 25 },
    { "name": "Bob", "age": 40 }
  ]
}

// object 类型实际存储为（打平后）
{
  "users.name": ["Alice", "Bob"],
  "users.age": [25, 40]
}
// 查询 name=Alice AND age=40 会错误命中！

// 使用 nested 类型可以保持对象内部字段的关联性
// 每个嵌套对象作为独立的隐藏文档存储
```

### 1.4 原子性保证

**重要**：ES 仅保证单文档级别的原子性，不支持跨文档事务。如果需要多文档的事务一致性，必须在应用层面实现。

---

## 二、倒排索引原理——搜索引擎的灵魂

### 2.1 正排索引 vs 倒排索引

**正排索引（Forward Index）**：通过文档 ID → 文档内容的映射。适合已知文档 ID 时获取内容，但不适合搜索。

**倒排索引（Inverted Index）**：通过词项 → 文档列表的映射。是全文搜索的核心数据结构。

```
正排索引：
Doc-001 → "Elasticsearch 是一个开源搜索引擎"
Doc-002 → "搜索引擎是信息检索的核心技术"
Doc-003 → "Elasticsearch 支持分布式搜索"

倒排索引：
"elasticsearch" → [Doc-001, Doc-003]
"搜索引擎"      → [Doc-001, Doc-002, Doc-003]
"开源"          → [Doc-001]
"分布式"        → [Doc-003]
"信息检索"      → [Doc-002]
"核心技术"      → [Doc-002]
```

### 2.2 倒排索引的详细结构

倒排索引不仅记录词项出现在哪些文档中，还记录词频（TF）和位置（Position）信息：

```
完整的倒排索引结构：

Term（词项）     →  Posting List（文档列表）
──────────────     ──────────────────────────────────
"elasticsearch"  →  [(Doc-001, tf=1, pos=[0]),
                      (Doc-003, tf=1, pos=[0])]

"搜索引擎"        →  [(Doc-001, tf=1, pos=[4]),
                      (Doc-002, tf=1, pos=[0]),
                      (Doc-003, tf=1, pos=[4])]
```

### 2.3 倒排索引的压缩技术

为了节省存储空间和提高查询速度，ES 使用了多种压缩算法：

**1. Variable Byte Encoding（VByte，变长字节编码）**

用变长的字节表示整数，小整数用更少的字节存储：

```
原始整数:        130
二进制:          10000010
VByte 编码:      10000001 00000010
                  ↑         ↑
                  高位=1     高位=0（最后一个字节）
                  表示后面    表示结束
                  还有字节

压缩效果：小整数（如文档ID差值）只需 1 字节，大整数最多 5 字节
```

**2. Frame of Reference（FOR，帧参考编码）**

将一个数据块内的整数减去该块的最小值，使差值更小，从而使用更少的位数存储：

```
原始数据:        [1000, 1005, 1012, 1003, 1008]
最小值:          1000
差值:            [0, 5, 12, 3, 8]
位宽:            4 bits（最大值 12 只需 4 bit）

压缩前: 5 × 32 bits = 160 bits
压缩后: 32 + 5 × 4 = 52 bits（节省 67.5%）
```

**3. Roaring Bitmap（咆哮位图）**

用于高效存储稀疏的文档 ID 集合，自动在数组、位图和 RLE 三种存储结构之间切换：

```
Roaring Bitmap 策略：

数据量 < 4096 时:  使用有序数组存储（Array Container）
数据量 >= 4096 时: 使用位图存储（Bitmap Container, 8KB）
连续数据较多时:    使用游程编码（Run Container）

优点：
- 稀疏数据不浪费空间
- 密集数据使用位图实现 O(1) 查找
- 支持高效的交集、并集、差集运算
```

### 2.4 相关性评分：TF-IDF 与 BM25

ES 使用评分算法对搜索结果进行排序：

**TF-IDF（旧版默认算法）**：

```
TF（词频）：词项在文档中出现的频率
   TF(t, d) = 词项 t 在文档 d 中的出现次数 / 文档 d 的总词数

IDF（逆文档频率）：衡量词项的稀有程度
   IDF(t) = log(总文档数 / 包含词项 t 的文档数)

最终得分 = TF × IDF
```

**BM25（ES 5.0+ 默认算法）**：

```
BM25 相比 TF-IDF 的改进：
- 引入了词频饱和机制：同一词项重复出现，得分增长逐渐趋于上限
- 引入了文档长度归一化：长文档不会因词频高而获得过高分数

BM25(t, d) = IDF(t) × [TF(t,d) × (k1+1)] / [TF(t,d) + k1×(1 - b + b×|d|/avgdl)]

参数：
  k1 = 1.2  （控制词频饱和速度）
  b  = 0.75 （控制文档长度归一化程度，0=不归一化，1=完全归一化）
```

### 2.5 性能对比：LIKE vs ES

```
千万级文档搜索性能对比：

查询方式                    响应时间        原理
─────────────────────      ──────────     ─────────────────
MySQL LIKE '%关键词%'       5-10s          全表扫描，逐行匹配
MySQL LIKE '关键词%'        0.5-2s         B+Tree 前缀匹配（有限场景）
Elasticsearch match         10-50ms        倒排索引，O(1) 词项查找
Elasticsearch term          5-20ms         精确词项匹配，无需分词

结论：ES 在全文搜索场景下性能提升 100-500 倍
```

---

## 三、集群架构设计

### 3.1 节点角色

ES 集群由多种角色的节点组成，每种角色承担不同的职责：

```
ES 集群节点架构：

                    +-----------------------+
                    |   Coordinating Node   |
                    |   (协调节点/路由节点)   |
                    |   请求路由 + 结果聚合   |
                    +-----------+-----------+
                                |
              +-----------------+------------------+
              |                 |                  |
    +---------v------+  +------v---------+  +-----v----------+
    |  Master Node   |  |  Data Node     |  |  Ingest Node   |
    |  (主节点)       |  |  (数据节点)     |  |  (预处理节点)   |
    |  集群状态管理   |  |  数据存储+查询  |  |  数据清洗+转换  |
    |  分片分配决策   |  |  热/温/冷/冻    |  |  Pipeline 处理  |
    +----------------+  +----------------+  +----------------+
```

**Master 节点**：负责集群管理操作，如索引创建/删除、分片分配、节点加入/退出。建议部署 **奇数个 Master 节点**（3 或 5），以防止脑裂（Split Brain）问题。

```
脑裂问题示例：

正常状态（3 Master 节点）：
  M1 ←→ M2 ←→ M3     quorum = (3/2) + 1 = 2

网络分区后：
  分区A: M1           分区B: M2 ←→ M3
  M1 只有自己1票       M2+M3 有2票 = quorum
  无法当选 Master      M2 当选 Master
  ✅ 只有分区B可以继续服务，避免双写

如果是偶数个（如 2 个 Master 节点）：
  分区A: M1           分区B: M2
  quorum = (2/2)+1 = 2
  两边都无法达到 quorum → 集群不可用！
```

**Data 节点**：实际存储数据和执行查询的节点。根据数据时效性可分为热/温/冷/冻四层。

**Coordinating 节点**：接收客户端请求，将请求路由到正确的数据节点，汇总各节点的结果后返回给客户端。所有节点默认都是协调节点。

**Ingest 节点**：在数据写入前执行预处理 Pipeline，如字段提取、数据清洗、GeoIP 解析等。

### 3.2 温度生命周期（Hot-Warm-Cold-Frozen）

这是 ES 大规模部署中最重要的成本优化策略：

```
数据温度生命周期：

Hot（热数据）
├── 硬件：NVMe SSD，高 CPU，大内存
├── 数据龄：< 1 周
├── 操作：频繁写入和查询
├── 副本数：1-2
└── 场景：实时日志、最新订单

        ↓ 7天后（ILM 自动迁移）

Warm（温数据）
├── 硬件：普通 SSD 或 HDD
├── 数据龄：1-4 周
├── 操作：只读，偶发查询
├── 副本数：0-1
├── 优化：force merge，减少分片数
└── 场景：历史日志查询

        ↓ 30天后

Cold（冷数据）
├── 硬件：高密度 HDD
├── 数据龄：1-6 个月
├── 操作：极少查询，查询速度较慢
├── 副本数：0
├── 优化：shrink index，冻结不活跃分片
└── 场景：合规审计

        ↓ 6个月后

Frozen（冻结数据）
├── 硬件：S3/OSS 对象存储
├── 数据龄：> 6 个月
├── 操作：极少查询，需要时缓存到本地
├── 搜索方式：部分挂载，按需加载
└── 场景：长期归档

成本节省：Hot → Frozen 整体存储成本节省 > 60%
```

### 3.3 分片策略

分片数量的设置直接影响集群的性能和可维护性：

```
分片大小建议：

推荐大小:    30-50 GB / 分片
最大不超过:  50 GB（恢复时间过长）
最小不低于:  10 GB（管理开销过大）

每节点最大分片数 = 堆内存 GB × 20
例：32GB 堆内存 → 最多 640 个分片

计算公式：
分片数 = ceil(预估数据量 / 目标分片大小)

示例：
  预估数据量: 500GB
  目标分片大小: 50GB
  主分片数: 500 / 50 = 10
  副本数: 1
  总分片数: 10 × (1 + 1) = 20
```

```json
// 创建索引时指定分片和副本数
PUT /products
{
  "settings": {
    "number_of_shards": 10,
    "number_of_replicas": 1,
    "refresh_interval": "30s",
    "translog": {
      "durability": "async",
      "sync_interval": "5s"
    }
  }
}
```

---

## 四、JVM 与系统调优

### 4.1 JVM 堆内存配置

ES 的 JVM 调优至关重要，错误的配置可能导致集群不稳定：

```
JVM 堆内存配置原则：

1. 堆内存 ≤ 物理 RAM 的 50%
   原因：剩余 50% RAM 留给 Lucene 的文件系统缓存（PageCache）
   Lucene 重度依赖 PageCache 来缓存索引文件，提升查询性能

2. 堆内存 ≤ 32GB（准确说是 ~26-30GB）
   原因：超过此阈值，JVM 无法使用 CompressedOops（压缩指针）
   CompressedOops 可以将对象引用从 8 字节压缩为 4 字节
   失去压缩后，堆内存使用量实际增加约 40%，反而更慢

3. 示例配置：
   64GB 服务器 → 堆内存 31GB，留 33GB 给 PageCache
   128GB 服务器 → 堆内存 31GB，留 97GB 给 PageCache

4. 使用 G1 GC（ES 7.x+ 默认）
   -XX:+UseG1GC
   -XX:G1ReservePercent=25
   -XX:InitiatingHeapOccupancyPercent=30
```

```bash
# jvm.options 配置示例
-Xms31g
-Xmx31g
-XX:+UseG1GC
-XX:G1ReservePercent=25
-XX:InitiatingHeapOccupancyPercent=30
-XX:+ParallelRefProcEnabled
-XX:+ExplicitGCInvokesConcurrent
```

---

## 五、查询优化

### 5.1 使用 filter 上下文避免评分

在 ES 中，查询分为 `query` 上下文和 `filter` 上下文。`filter` 不计算相关性分数，且结果会被缓存，性能显著优于 `query`：

```json
// 优化前：所有条件都在 query 上下文（都会评分）
{
  "query": {
    "bool": {
      "must": [
        { "match": { "title": "Elasticsearch" } },
        { "term": { "status": "published" } },
        { "range": { "price": { "lte": 100 } } }
      ]
    }
  }
}

// 优化后：精确条件放入 filter（不评分 + 缓存）
{
  "query": {
    "bool": {
      "must": [
        { "match": { "title": "Elasticsearch" } }
      ],
      "filter": [
        { "term": { "status": "published" } },
        { "range": { "price": { "lte": 100 } } }
      ]
    }
  }
}
```

### 5.2 禁用非搜索字段的索引

对于不需要搜索的字段，禁用索引可以显著减少存储空间和写入开销：

```json
{
  "mappings": {
    "properties": {
      "title": { "type": "text" },
      "internal_id": {
        "type": "keyword",
        "index": false
      },
      "raw_data": {
        "type": "text",
        "index": false
      },
      "metadata": {
        "type": "object",
        "enabled": false
      }
    }
  }
}
```

### 5.3 routing 精确路由

通过 routing 参数，可以将查询直接路由到包含数据的分片，避免全分片扫描：

```json
// 写入时指定 routing
PUT /orders/_doc/12345?routing=user_001
{
  "order_id": "12345",
  "user_id": "user_001",
  "amount": 299.99
}

// 查询时指定 routing，只需查询一个分片
GET /orders/_search?routing=user_001
{
  "query": {
    "term": { "user_id": "user_001" }
  }
}
```

---

## 六、深度分页问题

### 6.1 问题本质

```
深度分页的性能问题：

查询：GET /products/_search { "from": 10000, "size": 10 }

执行过程（假设 5 个分片）：
1. 协调节点向 5 个分片各请求前 10010 条数据
2. 每个分片返回 10010 条 → 协调节点收到 50050 条
3. 协调节点排序后取第 10001-10010 条返回

问题：
- 内存消耗巨大：协调节点需要在内存中排序 50050 条数据
- 分片越多，问题越严重
- ES 默认限制 from + size ≤ 10000（max_result_window）
```

### 6.2 解决方案

**方案一：search_after（推荐，适合实时搜索）**

```json
// 第一页
GET /products/_search
{
  "size": 100,
  "sort": [
    { "created_at": "desc" },
    { "_id": "asc" }
  ]
}

// 后续页：使用上一页最后一条的 sort 值
GET /products/_search
{
  "size": 100,
  "search_after": ["2025-01-15T10:30:00", "product_12345"],
  "sort": [
    { "created_at": "desc" },
    { "_id": "asc" }
  ]
}
```

**方案二：Scroll API（适合大批量数据导出）**

```json
// 创建 Scroll 上下文（保持 1 分钟）
POST /products/_search?scroll=1m
{
  "size": 1000
}

// 使用 scroll_id 获取下一批
POST /_search/scroll
{
  "scroll": "1m",
  "scroll_id": "DXF1ZXJ5QW5kRmV0Y2g..."
}

// 使用完毕，清理 scroll 上下文
DELETE /_search/scroll
{
  "scroll_id": "DXF1ZXJ5QW5kRmV0Y2g..."
}
```

**注意**：Scroll API 会消耗大量内存来维护搜索上下文，不适合实时搜索场景。ES 7.10+ 推荐使用 `Point in Time (PIT)` API 配合 `search_after`。

---

## 七、数据同步方案

将关系型数据库的数据同步到 ES 是常见的架构需求：

### 7.1 三种同步方案对比

```
方案一：同步双写
├── 实现：业务代码同时写 DB 和 ES
├── 优点：实时性强
├── 缺点：代码侵入性高，一致性难保证
└── 适用：简单场景，对实时性要求极高

方案二：异步 MQ
├── 实现：业务写 DB 后发送 MQ 消息，消费者写入 ES
├── 优点：解耦，支持重试
├── 缺点：需要维护 MQ，有一定延迟
└── 适用：大多数业务场景

方案三：Canal 监听 Binlog（推荐）
├── 实现：Canal 伪装为 MySQL Slave，解析 Binlog 同步到 ES
├── 优点：零代码侵入，实时性较好
├── 缺点：依赖 Binlog 格式，增加运维复杂度
└── 适用：数据量大，对业务代码零侵入要求
```

```
Canal 同步架构图：

MySQL (Master)
    |
    | Binlog (ROW 格式)
    |
    v
Canal Server
    |
    | 解析 Binlog → 结构化数据
    |
    v
Canal Adapter
    |
    | 数据映射 + 转换
    |
    v
Elasticsearch
```

---

## 八、ILM 索引生命周期管理

ILM（Index Lifecycle Management）是 ES 提供的自动化索引管理工具，可以自动执行索引从热到冻结的全生命周期：

```json
// 定义 ILM 策略
PUT /_ilm/policy/logs_policy
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_size": "50GB",
            "max_age": "1d"
          },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "shrink": { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 },
          "set_priority": { "priority": 50 }
        }
      },
      "cold": {
        "min_age": "30d",
        "actions": {
          "freeze": {},
          "allocate": {
            "number_of_replicas": 0
          }
        }
      },
      "delete": {
        "min_age": "180d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

---

## 九、ES 写入原理与优化

### 9.1 写入流程全解析

ES 的写入操作看似简单，背后涉及多个组件的协作：

```
文档写入的完整流程：

Client → Coordinating Node
              │
              │ 根据 routing 计算目标分片
              │ routing = hash(doc_id) % primary_shard_count
              │
              v
         Primary Shard（主分片）
              │
              ├── 1. 写入 In-Memory Buffer（内存缓冲区）
              ├── 2. 同时写入 Translog（事务日志，WAL 机制）
              │
              │   Refresh（每 1 秒）
              │   将 Buffer 数据写入新的 Lucene Segment（内存中）
              │   此时文档可被搜索（近实时）
              │
              │   Flush（每 30 分钟或 Translog 达 512MB）
              │   将所有 Segment 持久化到磁盘
              │   清空 Translog
              │   提交新的 Segment（fsync）
              │
              v
         Replica Shard（副本分片）
              │
              └── 主分片写入成功后，并行写入所有副本
                  所有副本确认后才返回成功（类似同步复制）
```

### 9.2 Segment 与 Merge

Lucene 的 Segment 是不可变的数据单元。每次 Refresh 都会创建一个新的 Segment，随着时间推移，Segment 数量会不断增加。后台的 Merge 线程会将多个小 Segment 合并为更大的 Segment，减少文件数量，提高查询效率：

```
Segment Merge 过程：

写入阶段（多个小 Segment）：
  Segment-1 (100 docs)
  Segment-2 (200 docs)
  Segment-3 (50 docs)
  Segment-4 (300 docs)
  Segment-5 (80 docs)

Merge 后（合并为大 Segment）：
  Segment-Merged (730 docs)

Merge 的作用：
  1. 减少文件数量 → 减少文件句柄和内存开销
  2. 物理删除标记为 deleted 的文档（ES 的删除是标记删除）
  3. 提高查询性能（减少需要遍历的 Segment 数量）
```

### 9.3 批量写入优化

```json
// 使用 Bulk API 批量写入，显著提升吞吐量
POST /_bulk
{"index": {"_index": "products"}}
{"name": "iPhone 15", "price": 7999}
{"index": {"_index": "products"}}
{"name": "MacBook Pro", "price": 14999}
{"index": {"_index": "products"}}
{"name": "AirPods Pro", "price": 1899}
{"update": {"_index": "products", "_id": "123"}}
{"doc": {"price": 6999}}
{"delete": {"_index": "products", "_id": "456"}}

// 最佳实践：
// 1. 每批 5-15MB 数据
// 2. 每批 500-1000 个文档
// 3. 多线程并发发送不同批次
```

---

## 十、查询 DSL 深入理解

### 10.1 查询分类

ES 的查询 DSL 分为两大类：**叶子查询**（Leaf Query）和**复合查询**（Compound Query）。

**叶子查询**在特定字段上搜索，包括：
- `match`：全文搜索，经过分词器处理
- `term`：精确匹配，不分词
- `range`：范围查询（数值、日期）
- `exists`：判断字段是否存在
- `prefix`：前缀匹配
- `wildcard`：通配符匹配
- `regexp`：正则表达式

**复合查询**组合多个叶子查询，包括：
- `bool`：组合 must/should/must_not/filter
- `boosting`：正向提升 + 负向降权
- `constant_score`：将所有匹配文档赋予相同分数

### 10.2 bool 查询的精确语义

```json
// bool 查询的四个子句语义：
{
  "query": {
    "bool": {
      "must": [
        // 必须匹配，参与评分（AND 语义）
        { "match": { "title": "Elasticsearch 教程" } }
      ],
      "should": [
        // 应该匹配，参与评分（OR 语义）
        // 在 must 存在时，should 起加分作用
        { "match": { "tags": "入门" } },
        { "match": { "tags": "高级" } }
      ],
      "must_not": [
        // 必须不匹配，不参与评分
        { "term": { "status": "deleted" } }
      ],
      "filter": [
        // 必须匹配，不参与评分，结果被缓存
        { "range": { "publish_date": { "gte": "2024-01-01" } } },
        { "term": { "language": "zh" } }
      ]
    }
  }
}
```

### 10.3 高亮与聚合

```json
// 搜索结果高亮
GET /articles/_search
{
  "query": {
    "match": { "content": "分布式系统" }
  },
  "highlight": {
    "fields": {
      "content": {
        "fragment_size": 150,
        "number_of_fragments": 3,
        "pre_tags": ["<em>"],
        "post_tags": ["</em>"]
      }
    }
  },
  "aggs": {
    "category_count": {
      "terms": {
        "field": "category",
        "size": 10
      }
    },
    "avg_reading_time": {
      "avg": { "field": "reading_time_minutes" }
    },
    "publish_trend": {
      "date_histogram": {
        "field": "publish_date",
        "calendar_interval": "month"
      }
    }
  }
}
```

---

## 十一、Mapping 设计最佳实践

### 11.1 动态映射的风险

ES 默认开启动态映射（Dynamic Mapping），会自动推断字段类型。这在生产环境中极其危险——错误的类型推断可能导致查询失败或性能问题。

```json
// 生产环境建议：关闭自动类型推断
PUT /orders
{
  "mappings": {
    "dynamic": "strict",  // strict=拒绝未知字段, false=接受但不索引
    "properties": {
      "order_id": { "type": "keyword" },
      "user_id": { "type": "keyword" },
      "amount": { "type": "scaled_float", "scaling_factor": 100 },
      "status": { "type": "keyword" },
      "items": {
        "type": "nested",
        "properties": {
          "product_id": { "type": "keyword" },
          "quantity": { "type": "integer" },
          "price": { "type": "scaled_float", "scaling_factor": 100 }
        }
      },
      "created_at": { "type": "date" },
      "updated_at": { "type": "date" },
      "description": {
        "type": "text",
        "analyzer": "ik_max_word",
        "search_analyzer": "ik_smart",
        "fields": {
          "keyword": {
            "type": "keyword",
            "ignore_above": 256
          }
        }
      }
    }
  }
}
```

### 11.2 常见 Mapping 陷阱

**陷阱一：text 类型字段做聚合**

text 类型的字段默认不支持聚合和排序。如果需要对文本字段进行聚合，应使用 keyword 类型，或在 text 字段上配置 `fields.keyword` 子字段。

**陷阱二：动态映射导致 Mapping Explosion**

如果文档中包含用户自定义的键（如用户标签、自定义属性），动态映射会为每个新键创建新的字段。当字段数量过多时（超过 `index.mapping.total_fields.limit` 默认 1000），会导致集群状态膨胀，性能急剧下降。解决方案是使用 `flattened` 类型或将动态字段设为 `object` + `dynamic: false`。

**陷阱三：忽略 Mapping 不可变性**

ES 的 Mapping 一旦创建，已有字段的类型不可修改。如需修改，必须创建新索引并通过 Reindex API 迁移数据。建议在项目初期就设计好 Mapping，或使用 Index Template 预定义模板。

---

## 十二、集群健康监控与运维

### 12.1 集群状态检查

```json
// 集群健康状态
GET /_cluster/health
{
  "cluster_name": "production-cluster",
  "status": "green",           // green/yellow/red
  "number_of_nodes": 9,
  "active_primary_shards": 150,
  "active_shards": 300,
  "relocating_shards": 0,      // 正在迁移的分片
  "initializing_shards": 0,    // 正在初始化的分片
  "unassigned_shards": 0       // 未分配的分片（关注重点）
}

// 查看未分配分片的原因
GET /_cluster/allocation/explain
{
  "index": "logs-2025.01",
  "shard": 0,
  "primary": false
}
```

### 12.2 常见集群问题排查

**问题一：Yellow 状态**

所有主分片正常，但部分副本未分配。常见原因：节点数少于副本数（单节点集群永远 Yellow）；磁盘水位线触发；分片分配被禁用。

**问题二：Red 状态**

部分主分片未分配，意味着部分数据不可用。排查步骤：检查是否有节点宕机；查看分片分配解释；尝试 `POST /_cluster/reroute?retry_failed=true` 重新分配失败的分片。

**问题三：Split Brain（脑裂）**

多个节点同时认为自己是 Master，导致集群状态不一致。预防措施：设置 `discovery.zen.minimum_master_nodes` 为 `(master_eligible_nodes / 2) + 1`（ES 7.x 之前）。ES 7.x 之后自动计算 quorum，无需手动配置。

### 12.3 索引别名与零停机重建

```json
// 使用别名实现零停机 Reindex
// 1. 创建新索引（使用优化后的 Mapping）
PUT /products_v2
{ "mappings": { ... } }

// 2. 使用 Reindex API 迁移数据
POST /_reindex
{
  "source": { "index": "products_v1" },
  "dest": { "index": "products_v2" }
}

// 3. 原子切换别名
POST /_aliases
{
  "actions": [
    { "remove": { "index": "products_v1", "alias": "products" } },
    { "add": { "index": "products_v2", "alias": "products" } }
  ]
}

// 4. 应用始终通过别名访问，无感知切换
GET /products/_search
{ "query": { "match": { "title": "手机" } } }
```

---

## 十三、面试题精选

### Q1：ES 为什么是近实时的？

**答**：ES 的写入操作先将数据写入 Translog 和内存 Buffer，默认每 1 秒执行一次 Refresh 操作，将 Buffer 中的数据写入文件系统缓存（OS PageCache），此时数据可被搜索。因此从写入到可搜索有约 1 秒的延迟，称为"近实时"。可以通过 `POST /index/_refresh` 手动刷新，或调整 `refresh_interval` 参数。

### Q2：ES 如何实现分布式的？

**答**：通过分片（Shard）实现数据的水平分割，每个分片是一个独立的 Lucene 索引。写入时根据 `routing`（默认为文档 ID 的哈希值）决定数据落入哪个分片。查询时协调节点将请求分发到所有相关分片，汇总结果后返回。

### Q3：ES 如何保证数据一致性？

**答**：ES 采用 Translog + Flush 机制。写入时同时写入 Translog（类似 WAL），每隔 5 秒或 Translog 达到 512MB 时执行 Flush，将内存数据持久化到磁盘。默认 Translog 采用异步刷盘（`durability: async`），可能有少量数据丢失。设置 `durability: request` 可保证每次写入都刷盘。

### Q4：如何实现 ES 的聚合分析？

**答**：ES 的聚合基于倒排索引和 `doc_values`（列式存储）。`doc_values` 在写入时构建列式数据结构，存储在磁盘上，按需 mmap 到内存。只有 keyword、numeric、date 等类型支持聚合，text 类型默认不支持。

### Q5：ES 集群 Yellow 和 Red 状态分别代表什么？

**答**：
- **Green**：所有主分片和副本分片都正常
- **Yellow**：所有主分片正常，但部分副本分片未分配（单节点集群常见）
- **Red**：部分主分片未分配（数据不可用），需要排查节点故障或分片损坏

### Q6：如何优化 ES 的写入性能？

**答**：
1. 使用批量写入 API（`_bulk`），每批 5-15MB
2. 增大 `refresh_interval`（如 30s），减少 Refresh 频率
3. 增大 `translog.sync_interval`，使用异步刷盘
4. 写入时临时将副本数设为 0，写入完成后再恢复
5. 增大 `index_buffer_size`（默认 10%）
6. 使用 SSD 存储

### Q7：如何实现 ES 的中文分词？

**答**：使用 IK 分词器插件。`ik_smart` 做最粗粒度切分（适合搜索），`ik_max_word` 做最细粒度切分（适合索引）。建议索引时用 `ik_max_word`，搜索时用 `ik_smart`，兼顾召回率和精确度。

### Q8：ES 如何实现 Master 选举？

**答**：ES 7.x 采用了全新的选举机制。每个 Master-eligible 节点启动时参与选举，需要获得大多数（quorum）候选节点的投票才能当选。quorum 的计算公式为 `(master_eligible_nodes / 2) + 1`。ES 7.x 不再需要手动配置 `minimum_master_nodes`，集群会根据配置的候选节点数自动计算。选举过程使用类 Raft 协议，确保在任意时刻最多只有一个节点能成为 Master，从根本上避免了脑裂问题。

### Q9：ES 的 doc_values 和 field_data 有什么区别？

**答**：`doc_values` 是 ES 5.x 之后引入的列式存储结构，在写入时构建并存储在磁盘上，按需通过 mmap 加载到内存。它支持聚合、排序和脚本访问，适用于 keyword、numeric、date 等类型。`field_data` 是旧版的实现方式，在查询时从倒排索引构建，加载到 JVM 堆内存中，容易造成堆内存溢出。ES 7.x 中 text 类型默认禁用 field_data，如果需要对 text 字段做聚合，推荐使用 keyword 子字段配合 doc_values。

### Q10：如何设计一个高并发的商品搜索系统？

**答**：完整的商品搜索系统需要综合考虑以下方面：首先在 Mapping 设计上，商品标题使用 text 类型配合 IK 分词器，价格使用 scaled_float，分类和状态使用 keyword，SKU 信息使用 nested 类型保持对象关联性。其次在查询优化上，将分类筛选、价格区间等精确条件放入 filter 上下文以利用缓存，只对标题和描述字段进行全文搜索评分。第三在架构设计上，使用索引别名实现零停机重建，通过 ILM 管理历史商品数据的热温冷分层，利用 routing 参数将同一店铺的商品路由到同一分片以支持店铺内搜索的精确路由优化。最后在数据同步上，通过 Canal 监听 MySQL Binlog 实时同步商品变更到 ES，保证搜索结果的时效性。

---

## 总结

Elasticsearch 的强大源于其精妙的底层设计——倒排索引实现了毫秒级的全文搜索，分布式分片架构支撑了海量数据的水平扩展，温度分层存储策略在性能和成本之间取得了优雅的平衡。在生产环境中，合理配置分片大小、JVM 参数、ILM 策略，以及选择合适的数据同步方案，是确保 ES 集群稳定高效运行的关键。

对于正在考虑引入 ES 的团队，建议从小规模集群开始，随着数据量增长逐步扩展。同时，密切关注 ES 版本更新——每个大版本都在性能和稳定性上有显著提升。特别需要注意的是，ES 的版本迭代速度很快，从 7.x 到 8.x 引入了向量搜索（Dense Vector）、EQL（事件查询语言）等新特性，如果你的业务涉及机器学习或安全分析场景，建议直接使用最新版本以获得最佳的功能支持和性能优化。
